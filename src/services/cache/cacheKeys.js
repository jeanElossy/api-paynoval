"use strict";

/**
 * ── Déplacé depuis l'API Gateway le 2026-09-10 ──────────────────────────────
 *
 * Ce module suit `fxRulesService`, son unique consommateur applicatif, parti
 * avec le domaine de la tarification. Le laisser dans la passerelle en aurait
 * fait du code mort tout en gardant, côté Tx-Core, un `require` non résolu —
 * défaut invisible à `node --check`, qui ne suit pas les `require`, et attrapé
 * par un test de CHARGEMENT réel des modules.
 *
 * Le module est injecté (`client` en paramètre) et reste inerte sans client
 * Redis : il ne suppose donc rien de l'hôte qui l'accueille.
 */


/**
 * Convention de clés et POLITIQUE DE CACHABILITÉ. Module PUR : aucun accès
 * réseau, aucun Redis. C'est ici que se décide ce qui a le droit d'être mis en
 * cache — et la réponse par défaut est NON.
 *
 * ── La règle centrale : allowlist, jamais blocklist ───────────────────────
 * Une liste de ce qu'on refuse de cacher (« ne pas cacher les soldes ») ne
 * protège de rien : la ressource inventée demain n'y figure pas, et se
 * retrouve cachée par défaut. La liste ci-dessous énumère le seul contenu
 * autorisé. Ajouter une ressource est un geste délibéré, visible en revue.
 *
 * C'est la même leçon que l'allowlist d'hôtes des scénarios k6 et celle du
 * banc de charge : sur un système financier, le défaut doit être le refus.
 *
 * ── Ce qui ne sera JAMAIS cachable ────────────────────────────────────────
 * Solde, écriture de grand livre, état de transaction, décision de risque.
 * Ces valeurs ont un point commun : elles deviennent fausses SANS erreur. Un
 * solde périmé s'affiche comme un solde. Le §13 le dit — Redis n'est pas la
 * vérité financière — et la décision du 2026-08-18 ajoute qu'un solde
 * faussement créditeur est plus grave qu'un solde faussement nul.
 */

/**
 * Ressources cachables, avec leur durée de vie en secondes.
 *
 * Le TTL fait partie de la déclaration, il n'est pas un paramètre d'appel :
 * un TTL choisi au site d'appel finit par diverger d'un appel à l'autre, et
 * deux durées différentes pour la même donnée produisent des lectures
 * incohérentes selon le chemin emprunté.
 */
const RESSOURCES_CACHABLES = Object.freeze({
  // Référentiel — change rarement, coûteux à recalculer.
  "pricing-rules": { ttl: 300, pourquoi: "règles tarifaires, relues à chaque devis" },
  "fx-rate": { ttl: 60, pourquoi: "taux de change, appel externe facturé" },
  corridor: { ttl: 600, pourquoi: "corridors autorisés, table de référence" },
  country: { ttl: 3600, pourquoi: "métadonnées pays, quasi statiques" },
  "fee-schedule": { ttl: 300, pourquoi: "barème de frais, lu à chaque devis" },

  // Profil — pas de donnée financière, pas de donnée KYC sensible.
  "user-profile": { ttl: 120, pourquoi: "nom, langue, devise d'affichage" },
});

/**
 * Ressources explicitement interdites. **Ceci n'est PAS le mécanisme de
 * sécurité** — l'allowlist ci-dessus l'est. Cette table sert uniquement à
 * produire un message qui explique POURQUOI, plutôt qu'un « inconnu » qui
 * laisserait croire à une faute de frappe.
 */
const INTERDITS_EXPLIQUES = Object.freeze({
  balance: "un solde périmé s'affiche comme un solde — il n'y a pas d'erreur à voir",
  wallet: "voir `balance`",
  ledger: "le grand livre fait foi ; une copie qui diverge n'est plus une preuve",
  transaction: "l'état d'une transaction décide d'un paiement",
  "risk-score": "une décision de risque périmée laisse passer ce qu'elle devait bloquer",
  idempotency: "l'idempotence doit être durable ; un cache qui expire rejoue l'argent",
});

const FORMAT_SEGMENT = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * @param {string} ressource
 * @returns {{cachable: boolean, ttl: number|null, raison: string|null}}
 */
function politique(ressource) {
  const r = String(ressource || "").trim();

  if (Object.prototype.hasOwnProperty.call(RESSOURCES_CACHABLES, r)) {
    return { cachable: true, ttl: RESSOURCES_CACHABLES[r].ttl, raison: null };
  }

  if (Object.prototype.hasOwnProperty.call(INTERDITS_EXPLIQUES, r)) {
    return { cachable: false, ttl: null, raison: `INTERDIT — ${INTERDITS_EXPLIQUES[r]}` };
  }

  return {
    cachable: false,
    ttl: null,
    raison:
      `ressource « ${r} » non déclarée cachable. Le défaut est le refus : ` +
      `pour l'autoriser, l'ajouter à RESSOURCES_CACHABLES avec son TTL et sa justification.`,
  };
}

/**
 * Construit une clé au format `paynoval:{env}:{service}:{resource}:{id}`.
 *
 * Lève sur une ressource non cachable : mieux vaut une exception en
 * développement qu'un solde en cache en production. L'appelant public
 * (`cacheService`) rattrape et retombe sur la base — le service ne tombe pas.
 *
 * @throws {Error} si la ressource n'est pas cachable ou si un segment est invalide
 */
function construireCle({ env, service, ressource, id }) {
  const p = politique(ressource);
  if (!p.cachable) {
    throw new Error(`[cache] refus de construire une clé : ${p.raison}`);
  }

  const segments = { env, service, ressource, id };
  for (const [nom, valeur] of Object.entries(segments)) {
    const v = String(valeur ?? "").trim();
    if (!v) throw new Error(`[cache] segment « ${nom} » vide`);

    // Le deux-points est le séparateur : le laisser passer dans un identifiant
    // permettrait de forger une clé appartenant à une autre ressource.
    if (v.includes(":")) {
      throw new Error(`[cache] segment « ${nom} » contient « : », séparateur réservé`);
    }
    if (nom !== "id" && !FORMAT_SEGMENT.test(v)) {
      throw new Error(`[cache] segment « ${nom} » de forme invalide : ${v}`);
    }
  }

  return `paynoval:${env}:${service}:${ressource}:${id}`;
}

/** Motif d'invalidation en masse pour une ressource entière. */
function motifRessource({ env, service, ressource }) {
  const p = politique(ressource);
  if (!p.cachable) throw new Error(`[cache] ${p.raison}`);
  return `paynoval:${env}:${service}:${ressource}:*`;
}

module.exports = {
  RESSOURCES_CACHABLES,
  INTERDITS_EXPLIQUES,
  politique,
  construireCle,
  motifRessource,
};
