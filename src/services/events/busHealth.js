"use strict";

/**
 * ============================================================================
 * SANTÉ DU BUS D'ÉVÉNEMENTS — LE RETARD DES CONSOMMATEURS
 * ============================================================================
 *
 * ═══ LE DÉFAUT QUE CE FICHIER REFERME ════════════════════════════════════
 *
 * Constaté le 2026-09-23, sur le service réel : un utilisateur a exécuté une
 * transaction avec les trois canaux de notification activés et n'a **rien** reçu.
 * Ni push, ni e-mail, ni in-app. Cause : le consommateur
 * `worker:notifications` — un processus séparé — n'était pas déployé. Les
 * événements s'empilaient dans le flux, intacts, et personne ne les lisait.
 *
 * Le plus coûteux n'est pas la panne, c'est qu'elle était **invisible** :
 *
 *   • `/readyz` restait vert — il ne contrôle que Mongo ;
 *   • `/metrics` n'exposait AUCUNE série sur le bus ;
 *   • `workerMetrics.js` ne surveille que les cinq boucles de CE processus ;
 *   • les quatre groupes de consommateurs existaient par leur nom dans quatre
 *     fichiers, et aucun n'était mesuré.
 *
 * Le seul signal était l'absence de notifications, c'est-à-dire un symptôme
 * qu'on prend pour un bug applicatif. C'est exactement la classe de défaut que
 * `workerMetrics.js` décrit dans son propre en-tête : « on ne surveille pas une
 * absence : on la découvre des semaines plus tard ».
 *
 * ═══ POURQUOI C'EST OBSERVABLE D'ICI, ET COMMENT ═════════════════════════
 *
 * Les consommateurs tournent dans d'autres processus, par conception. Ce
 * processus ne peut donc pas recevoir leur battement de cœur. Mais Redis, lui,
 * sait où chaque groupe en est : `XINFO GROUPS` rend le retard et le nombre de
 * messages non acquittés.
 *
 * C'est le signal que surveillent tous les systèmes à file — le retard de
 * consommateur (« consumer lag » sur Kafka, `ApproximateAgeOfOldestMessage` sur
 * SQS). On n'alerte pas sur « le worker est-il vivant ? », question à laquelle on
 * ne peut pas répondre à distance, mais sur « le travail avance-t-il ? », qui est
 * la seule qui compte pour l'utilisateur.
 *
 * ═══ UN GROUPE ABSENT N'EST PAS UN GROUPE À JOUR ══════════════════════════
 *
 * C'est le piège principal, et il est exactement celui que `workerMetrics`
 * décrit à propos du zéro. Un groupe qui ne figure pas dans `XINFO GROUPS` n'a
 * jamais été créé : son consommateur n'a jamais démarré. Le compter comme
 * « retard 0 » le ferait passer pour parfaitement à jour — c'est-à-dire donner
 * le meilleur score possible au pire état possible.
 *
 * `ABSENT` est donc un état distinct, et c'est celui qui porte l'alerte.
 *
 * ═══ CE QUI N'EST DÉLIBÉRÉMENT PAS FAIT ══════════════════════════════════
 *
 * ⚠️ UN CONSOMMATEUR ABSENT NE REND PAS `/readyz` ROUGE.
 *
 * La tentation est forte et ce serait une faute. `/readyz` rouge sort
 * l'instance de la rotation : une notification en retard mettrait donc le
 * MOTEUR D'ARGENT à l'arrêt. L'ordre de priorité du projet est explicite —
 * correction financière et fiabilité passent avant l'observabilité. Le retard
 * s'expose et s'alerte ; il ne coupe rien.
 */

const stream = require("./stream");

/* -------------------------------------------------------------------------- */
/* Ce qu'on attend — partie PURE                                              */
/* -------------------------------------------------------------------------- */

/**
 * Les groupes de consommateurs que ce service attend, et ce que coûte leur
 * absence.
 *
 * ⚠️ `critique` NE VEUT PAS DIRE « IMPORTANT », MAIS « VISIBLE PAR
 * L'UTILISATEUR ». Le consommateur de notifications est le seul dont l'absence
 * se manifeste comme un bug de l'application : le client ne reçoit rien et
 * conclut que le produit est cassé. Les trois autres dégradent la surveillance
 * et la conformité — grave, mais silencieux pour le client, et rattrapable en
 * rejouant le flux.
 *
 * Cette liste doit rester alignée sur les constantes `GROUPE` des quatre
 * consommateurs ; un test le vérifie en lisant leurs fichiers, pour qu'un
 * cinquième consommateur ajouté sans surveillance fasse échouer la suite.
 */
const GROUPES_ATTENDUS = Object.freeze([
  {
    nom: "notification-dispatch",
    role: "notifications",
    critique: true,
    consequence:
      "AUCUNE notification de transaction n'arrive (ni push, ni e-mail, ni " +
      "in-app). Le client conclut que l'application est cassée. Rien n'est " +
      "perdu : le flux est relu depuis le début au démarrage du consommateur.",
  },
  {
    nom: "risk-monitoring",
    role: "risque / AML",
    critique: false,
    consequence:
      "la surveillance de conformité asynchrone est aveugle ; les seuils AML " +
      "ne sont plus évalués sur les nouveaux mouvements.",
  },
  {
    nom: "settlement-reconciliation",
    role: "réconciliation de règlement",
    critique: false,
    consequence: "les écarts de règlement ne sont plus signalés.",
  },
  {
    nom: "referral-award",
    role: "parrainage",
    critique: false,
    consequence: "les primes de parrainage ne sont plus attribuées.",
  },
]);

const ETATS = Object.freeze({
  OK: "ok",
  ABSENT: "absent",
  EN_RETARD: "en_retard",
  INCONNU: "inconnu",
});

/**
 * Retard au-delà duquel on alerte.
 *
 * ⚠️ IL N'EST PAS À ZÉRO, ET C'EST VOLONTAIRE. Un consommateur sain a toujours
 * quelques messages en vol — c'est ce qu'on veut : il lit par lots. Alerter au
 * premier message en attente produirait une alerte permanente, donc ignorée,
 * donc pire que pas d'alerte.
 */
const RETARD_MAX = Math.max(
  1,
  Number(process.env.EVENT_STREAM_LAG_ALERT || 500)
);

/**
 * Évalue l'état de chaque groupe attendu. **Fonction pure.**
 *
 * @param {object} p
 * @param {Array|null} p.infos          sortie de `stream.groupes()`
 * @param {number|null} p.longueurFlux  `XLEN` du flux
 * @param {number} [p.retardMax]
 * @returns {{groupes: Array, degrade: boolean, critiqueAbsent: boolean}}
 */
function evaluerGroupes({ infos, longueurFlux = null, retardMax = RETARD_MAX } = {}) {
  /**
   * `infos === null` signifie « pas de transport », donc aucune information.
   * On ne prétend PAS que les groupes sont absents : l'absence de mesure et la
   * mesure d'une absence sont deux choses différentes, et les confondre ferait
   * alerter sur quatre consommateurs à chaque coupure de Redis.
   */
  const transport = Array.isArray(infos);

  const parNom = new Map(
    transport ? infos.map((g) => [String(g.name || ""), g]) : []
  );

  const groupes = GROUPES_ATTENDUS.map((attendu) => {
    if (!transport) {
      return {
        ...attendu,
        etat: ETATS.INCONNU,
        retard: null,
        pending: null,
        consumers: null,
      };
    }

    const vu = parNom.get(attendu.nom);

    if (!vu) {
      return {
        ...attendu,
        etat: ETATS.ABSENT,
        /**
         * Le retard d'un groupe absent, c'est TOUT le flux : aucun message n'a
         * jamais été lu par lui.
         */
        retard: Number.isFinite(Number(longueurFlux)) ? Number(longueurFlux) : null,
        pending: null,
        consumers: 0,
      };
    }

    /**
     * `lag` est absent avant Redis 7 et vaut `null` quand Redis ne sait pas le
     * calculer. On retombe alors sur le nombre de messages non acquittés, qui
     * est une borne INFÉRIEURE du retard — moins bonne, mais jamais trompeuse
     * dans le sens rassurant.
     */
    const retard = vu.lag === null || vu.lag === undefined ? vu.pending : vu.lag;

    return {
      ...attendu,
      etat: retard > retardMax ? ETATS.EN_RETARD : ETATS.OK,
      retard: Number(retard || 0),
      pending: Number(vu.pending || 0),
      consumers: Number(vu.consumers || 0),
    };
  });

  return {
    groupes,
    degrade: groupes.some((g) => g.etat === ETATS.ABSENT || g.etat === ETATS.EN_RETARD),
    critiqueAbsent: groupes.some((g) => g.critique && g.etat === ETATS.ABSENT),
  };
}

/**
 * Le message à journaliser pour un groupe en défaut, AVEC sa conséquence.
 *
 * Règle B.6 : un journal qui dit « groupe absent » sans dire ce que cela coûte
 * oblige le lecteur à aller chercher lui-même l'impact — ce qu'il ne fait pas à
 * trois heures du matin.
 */
function messagePour(groupe) {
  if (groupe.etat === ETATS.ABSENT) {
    return (
      `⚠️ Consommateur « ${groupe.role} » JAMAIS DÉMARRÉ (groupe Redis ` +
      `« ${groupe.nom} » inexistant, ${groupe.retard ?? "?"} événements en ` +
      `attente) — CONSÉQUENCE : ${groupe.consequence} ` +
      `Correctif : déployer le processus consommateur ` +
      `(\`npm run workers:all\`, ou \`npm run worker:notifications\`).`
    );
  }

  if (groupe.etat === ETATS.EN_RETARD) {
    return (
      `⚠️ Consommateur « ${groupe.role} » EN RETARD de ${groupe.retard} ` +
      `événements (${groupe.consumers} consommateur(s) connecté(s)) — ` +
      `CONSÉQUENCE : ${groupe.consequence}`
    );
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Lecture — partie avec entrées/sorties                                      */
/* -------------------------------------------------------------------------- */

/**
 * Lit l'état réel du bus.
 *
 * ⚠️ NE LÈVE JAMAIS. Une sonde d'observabilité qui casse le chemin qui
 * l'appelle — une collecte de métriques, un journal périodique — transforme un
 * outil de diagnostic en cause de panne.
 */
async function lireEtat({ retardMax = RETARD_MAX } = {}) {
  let infos = null;
  let longueurFlux = null;
  let erreur = null;

  try {
    infos = await stream.groupes();
    longueurFlux = await stream.longueur();
  } catch (err) {
    erreur = String(err?.message || err);
    infos = null;
  }

  const evaluation = evaluerGroupes({ infos, longueurFlux, retardMax });

  return { ...evaluation, longueurFlux, erreur, flux: stream.FLUX };
}

/* -------------------------------------------------------------------------- */
/* Métriques                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Expose le retard de chaque groupe sur `/metrics`.
 *
 * Deux séries, et la seconde n'est pas redondante :
 *
 *   `event_consumer_lag`     — le retard. C'est elle qui porte l'alerte de
 *                              lenteur.
 *   `event_consumer_present` — 1 présent, 0 absent, -1 indéterminé (pas de
 *                              transport). Un groupe absent aurait un retard
 *                              égal à la longueur du flux, qui vaut 0 sur un
 *                              flux vide : sans cette seconde série, un
 *                              consommateur jamais démarré sur un système au
 *                              repos serait indiscernable d'un consommateur
 *                              parfaitement à jour.
 */
function registerMetrics(metrics) {
  if (!metrics?.registerAsyncGauge) return false;

  metrics.registerAsyncGauge({
    name: "event_consumer_lag",
    help:
      "Événements du bus non encore lus par un groupe de consommateurs. " +
      "-1 = indéterminé (transport absent).",
    labelNames: ["consumer", "role"],
    collect: async (g) => {
      const etat = await lireEtat();

      for (const groupe of etat.groupes) {
        g.set(
          { consumer: groupe.nom, role: groupe.role },
          groupe.retard === null || groupe.retard === undefined ? -1 : groupe.retard
        );
      }
    },
  });

  metrics.registerAsyncGauge({
    name: "event_consumer_present",
    help:
      "1 = le groupe existe (le consommateur a démarré au moins une fois), " +
      "0 = jamais démarré, -1 = indéterminé (transport absent).",
    labelNames: ["consumer", "role"],
    collect: async (g) => {
      const etat = await lireEtat();

      for (const groupe of etat.groupes) {
        const valeur =
          groupe.etat === ETATS.INCONNU ? -1 : groupe.etat === ETATS.ABSENT ? 0 : 1;

        g.set({ consumer: groupe.nom, role: groupe.role }, valeur);
      }
    },
  });

  return true;
}

/* -------------------------------------------------------------------------- */
/* Surveillance périodique                                                    */
/* -------------------------------------------------------------------------- */

/** Intervalle du contrôle. Cinq minutes : c'est une absence, pas une latence. */
const INTERVALLE_MS = Math.max(
  60_000,
  Number(process.env.EVENT_BUS_HEALTH_INTERVAL_MS || 300_000)
);

/**
 * Contrôle périodique, qui JOURNALISE ce qu'il trouve.
 *
 * Les métriques supposent un collecteur et une règle d'alerte configurés. Le
 * journal, lui, suffit à répondre à « pourquoi personne ne reçoit ses
 * notifications ? » sans rien installer — et c'est précisément la question qui
 * s'est posée.
 *
 * ⚠️ LE PREMIER CONTRÔLE A LIEU AU DÉMARRAGE. Un consommateur jamais déployé est
 * un état permanent : attendre cinq minutes pour l'annoncer la première fois
 * laisserait un démarrage silencieux, ce que la règle B.6 interdit.
 */
function start({ logger = console, intervalMs = INTERVALLE_MS } = {}) {
  let arrete = false;

  async function tour() {
    if (arrete) return;

    try {
      const etat = await lireEtat();

      if (etat.erreur) {
        logger.warn?.(
          `⚠️ Santé du bus illisible (${etat.erreur}) — le retard des ` +
            `consommateurs n'est PAS surveillé pour l'instant.`
        );

        return;
      }

      const enDefaut = etat.groupes.filter((g) => messagePour(g));

      if (!enDefaut.length) {
        logger.debug?.(
          `✅ Bus « ${etat.flux} » — ${etat.groupes.length} consommateurs à jour ` +
            `(${etat.longueurFlux ?? "?"} événements dans le flux).`
        );

        return;
      }

      for (const groupe of enDefaut) {
        const message = messagePour(groupe);

        // Un consommateur visible par l'utilisateur mérite `error`, pas `warn` :
        // les deux ne réveillent pas les mêmes règles d'alerte.
        if (groupe.critique) logger.error?.(message);
        else logger.warn?.(message);
      }
    } catch (err) {
      logger.warn?.(
        `⚠️ Contrôle de santé du bus en échec (${err?.message || err}) — sans ` +
          `conséquence sur le trafic, mais le retard des consommateurs n'est ` +
          `pas surveillé.`
      );
    }
  }

  tour();

  const minuteur = setInterval(tour, intervalMs);

  if (typeof minuteur.unref === "function") minuteur.unref();

  return {
    stop() {
      arrete = true;
      clearInterval(minuteur);
    },
    tour,
  };
}

module.exports = {
  ETATS,
  GROUPES_ATTENDUS,
  INTERVALLE_MS,
  RETARD_MAX,
  evaluerGroupes,
  lireEtat,
  messagePour,
  registerMetrics,
  start,
};
