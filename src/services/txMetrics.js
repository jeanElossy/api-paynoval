"use strict";

/**
 * ============================================================================
 * MÉTRIQUES MÉTIER DE TX-CORE
 * ============================================================================
 *
 * CE QUE LES MÉTRIQUES HTTP NE DISENT PAS
 * ---------------------------------------
 * `metrics.js` mesure la durée des requêtes par route. C'est nécessaire et
 * insuffisant : `POST /confirm` à 3 secondes ne dit pas si le temps est parti
 * dans Mongo, dans le calcul de tarification, ou chez Wave. Or c'est
 * exactement la question qu'on se pose pendant un incident, et la seule dont la
 * réponse change ce qu'on fait.
 *
 * Ce module ajoute les deux mesures que §37 réclame et qui n'existaient nulle
 * part :
 *
 *   • **latence prestataire**, par prestataire, rail et opération ;
 *   • **taux d'erreur prestataire**, sur la même découpe.
 *
 * POURQUOI UN SEUL POINT D'INSTRUMENTATION
 * ----------------------------------------
 * Les appels prestataires partent de SIX adapters (le septième était le rail
 * bancaire, retiré le 2026-08-26 — cf. `providers/providerConfigReport.js`),
 * appelés depuis cinq
 * exécuteurs, eux-mêmes atteints par plusieurs chemins (confirmation, webhook,
 * relance administrative). Instrumenter chaque site d'appel garantirait d'en
 * oublier un — et un chemin non mesuré est pire qu'aucune mesure, parce qu'il
 * fausse les moyennes sans se signaler.
 *
 * `getProviderAdapter()` est le passage obligé : tout appel réel passe par lui.
 * On enveloppe donc l'adapter qu'il rend, une fois, et toute la chaîne est
 * couverte — y compris les chemins ajoutés plus tard.
 *
 * ⚠️ L'ENVELOPPE NE DOIT JAMAIS CHANGER LE COMPORTEMENT.
 * Elle mesure et relaie. Une exception est comptée puis **relancée telle
 * quelle** ; la valeur de retour est rendue sans modification. Une métrique qui
 * fait échouer un virement est un défaut bien pire que l'absence de métrique.
 *
 * CARDINALITÉ
 * -----------
 * Les étiquettes sont fermées par construction : SIX prestataires, trois
 * rails, deux opérations, trois issues. Le produit est borné à ~108 séries,
 * connu à l'avance. C'est le contraire d'une étiquette par identifiant de
 * transaction, qui ferait tomber Prometheus (voir l'en-tête de `metrics.js`).
 */

/**
 * Bornes du histogramme prestataire, en secondes.
 *
 * Volontairement DIFFÉRENTES de celles des requêtes HTTP. Un appel Mobile Money
 * ne se comporte pas comme une requête interne : les délais d'expiration des
 * adapters sont à 15-20 s, et ce qui intéresse est la zone 1-10 s où un
 * prestataire commence à traîner. Des bornes s'arrêtant à 10 s écraseraient tout
 * ce qui compte dans le dernier seau.
 */
const PROVIDER_BUCKETS = Object.freeze([
  0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 12, 20, 30,
]);

/**
 * Construit le jeu de métriques métier.
 *
 * En injection, comme `metrics.js` : `client` et `register` sont fournis, donc
 * les tests n'ont pas de registre global à partager entre fichiers.
 */
function createTxMetrics({ client, register }) {
  if (!client) throw new Error("txMetrics : dépendance `client` manquante");
  if (!register) throw new Error("txMetrics : dépendance `register` manquante");

  const providerDuration = new client.Histogram({
    name: "provider_request_duration_seconds",
    help: "Durée d'un appel prestataire, par prestataire, rail et opération",
    labelNames: ["provider", "rail", "operation", "outcome"],
    buckets: PROVIDER_BUCKETS,
    registers: [register],
  });

  const providerTotal = new client.Counter({
    name: "provider_requests_total",
    help: "Appels prestataires, par issue",
    labelNames: ["provider", "rail", "operation", "outcome"],
    registers: [register],
  });

  /**
   * Compteur d'issues transactionnelles.
   *
   * Séparé de la latence à dessein : le taux de succès et la durée répondent à
   * des questions différentes, et les mêler dans un histogramme rendrait le
   * taux illisible.
   */
  const transactionTotal = new client.Counter({
    name: "transactions_total",
    help: "Transactions par flux et statut atteint",
    labelNames: ["flow", "rail", "status"],
    registers: [register],
  });

  const providerMocked = new client.Gauge({
    name: "provider_rails_mocked",
    help:
      "1 si le rail est en mode SIMULÉ — il accepte les ordres sans jamais " +
      "payer. Doit valoir 0 partout en production.",
    labelNames: ["provider", "rail"],
    registers: [register],
  });

  function norm(v, fallback = "unknown") {
    const s = String(v ?? "").trim().toLowerCase();
    return s || fallback;
  }

  /**
   * Enveloppe `payout` et `collect` d'un adapter pour les mesurer.
   *
   * @param {object} adapter   l'adapter rendu par `getProviderAdapter`
   * @param {object} ctx       `{ rail, provider }`
   * @param {Function} [now]   horloge injectable (tests)
   * @returns {object} un adapter équivalent, mesuré
   */
  function instrumentAdapter(adapter, { rail, provider } = {}, now = () => Date.now()) {
    if (!adapter || typeof adapter !== "object") return adapter;

    const labelsBase = {
      provider: norm(provider || adapter.provider),
      rail: norm(rail),
    };

    /**
     * On délègue par PROTOTYPE plutôt que de copier les propriétés : l'adapter
     * garde `parseWebhook`, `mapStatus` et tout ce qu'on y ajoutera, sans qu'il
     * faille penser à les recopier ici.
     */
    const wrapped = Object.create(adapter);

    for (const operation of ["payout", "collect"]) {
      const original = adapter[operation];
      if (typeof original !== "function") continue;

      wrapped[operation] = async function instrumented(...args) {
        const started = now();
        let outcome = "success";

        try {
          const result = await original.apply(adapter, args);

          /**
           * Un adapter ne LÈVE pas sur refus prestataire : il rend
           * `{ ok: false }`. Compter cela comme un succès masquerait exactement
           * ce qu'on cherche — un prestataire qui refuse tout sans tomber.
           */
          if (result && result.ok === false) outcome = "failed";

          return result;
        } catch (err) {
          // `error` ≠ `failed` : l'un est un refus métier, l'autre une panne
          // (délai dépassé, réseau, rail non configuré). Les mélanger ferait
          // chercher au mauvais endroit.
          outcome = "error";
          throw err;
        } finally {
          const labels = { ...labelsBase, operation, outcome };
          const seconds = Math.max(0, now() - started) / 1000;

          try {
            providerDuration.observe(labels, seconds);
            providerTotal.inc(labels);
          } catch {
            // Une métrique ne doit jamais faire échouer un virement.
          }
        }
      };
    }

    return wrapped;
  }

  /** Enregistre l'issue d'une transaction. Ne lève jamais. */
  function observeTransaction({ flow, rail, status } = {}) {
    try {
      transactionTotal.inc({
        flow: norm(flow),
        rail: norm(rail),
        status: norm(status),
      });
    } catch {}
  }

  /**
   * Publie l'état simulé/réel des rails, tel que résolu au démarrage.
   *
   * C'est la contrepartie observable du correctif de la Phase A : le journal le
   * dit une fois au démarrage, cette jauge le dit en permanence. Une alerte
   * `provider_rails_mocked > 0` en production attrape le cas où quelqu'un a posé
   * `ALLOW_PROVIDER_MOCK_IN_PRODUCTION=true` « le temps d'un test » et l'a oublié.
   */
  function setRailModes(report) {
    try {
      for (const r of report?.rails || []) {
        providerMocked.set(
          { provider: norm(r.provider), rail: norm(r.rail) },
          r.mock === true ? 1 : 0
        );
      }
    } catch {}
  }

  return {
    instrumentAdapter,
    observeTransaction,
    setRailModes,
    PROVIDER_BUCKETS,
  };
}

/* -------------------------------------------------------------------------- */
/* Instance de processus                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Une seule instance par processus, posée par `server.js` au démarrage.
 *
 * `providerSelector` doit pouvoir instrumenter sans connaître le registre ni
 * l'ordre d'initialisation — et sans qu'un `require` de bas niveau construise
 * un second registre.
 *
 * Tant que rien n'est posé, `getTxMetrics()` rend un objet inerte : les appels
 * prestataires fonctionnent exactement comme avant, ils ne sont simplement pas
 * mesurés. Un module de mesure ne doit jamais être une condition de démarrage.
 */
const INERT = Object.freeze({
  instrumentAdapter: (adapter) => adapter,
  observeTransaction: () => {},
  setRailModes: () => {},
});

let _instance = null;

function setTxMetrics(instance) {
  _instance = instance || null;
}

function getTxMetrics() {
  return _instance || INERT;
}

module.exports = {
  createTxMetrics,
  setTxMetrics,
  getTxMetrics,
  PROVIDER_BUCKETS,
  INERT,
};
