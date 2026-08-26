"use strict";

/**
 * ============================================================================
 * RÉCONCILIATION CONTRE LE PRESTATAIRE — LES RÈGLES, SANS LA BASE
 * ============================================================================
 *
 * CE QUE CE FICHIER AJOUTE À LA RÉCONCILIATION EXISTANTE
 * -----------------------------------------------------
 * `transactionReconciliationService` vérifie que NOS données sont cohérentes
 * ENTRE ELLES : le portefeuille avec le grand livre, le grand livre avec la
 * transaction. Tous ses contrôles peuvent être verts alors que l'argent est
 * perdu — il suffit que nous soyons cohéremment en désaccord avec le
 * prestataire.
 *
 * C'est le second axe, et c'est celui qui manquait : comparer ce que le
 * prestataire nous a DIT avec ce que nous avons FAIT. Le registre
 * `provider_webhook_events` en est la matière première ; il a été construit pour
 * l'idempotence, il sert ici de journal de ce qui nous a été annoncé.
 *
 * LA RÈGLE ABSOLUE EST HÉRITÉE : ON NE CORRIGE RIEN.
 * -------------------------------------------------
 * Ce module n'a aucun accès à la base, donc il ne peut rien écrire — mais ce
 * n'est pas qu'une propriété technique, c'est la même règle que le service
 * voisin. Une réconciliation qui répare est une seconde source de mouvements
 * d'argent, déclenchée par un travail de fond que personne ne regarde. Ce qui
 * est signalé ici se corrige par le chemin normal, ou à la main.
 *
 * POURQUOI DES FONCTIONS PURES
 * ----------------------------
 * Même découpage que `webhookIdempotency.js` (pur) / `webhookEventStore.js`
 * (accès) : la DÉCISION se teste sans Mongo, sans horloge réelle, et sans
 * fabriquer d'écarts financiers dans une base. Un contrôle qu'on ne peut pas
 * tester finit par n'être vérifié qu'en production, le jour où il se trompe.
 */

/**
 * Les six écarts. Ils ne sont pas de même gravité et ne se traitent pas de la
 * même façon : chacun porte sa conséquence financière dans son commentaire,
 * parce qu'un nom d'anomalie seul n'appelle aucune action.
 */
const PROVIDER_ANOMALIES = Object.freeze({
  /**
   * Rappel réservé puis jamais clôturé, bail expiré depuis longtemps.
   *
   * Un processus est mort AU MILIEU du règlement. L'argent peut être à
   * mi-chemin : réserve capturée sans crédit du bénéficiaire, par exemple. Le
   * prestataire, lui, n'a jamais reçu de 2xx et a fini par abandonner ses
   * rejeux. C'est le seul cas où l'incohérence vient de NOUS et où personne
   * ne réémettra.
   */
  PROVIDER_EVENT_UNSETTLED: "PROVIDER_EVENT_UNSETTLED",

  /**
   * Rappel en échec, jamais repris passé le délai de grâce.
   *
   * Le prestataire nous a parlé, nous n'avons pas su agir, et ses rejeux se
   * sont taris. L'événement est perdu si personne ne le rejoue à la main.
   */
  PROVIDER_EVENT_FAILED: "PROVIDER_EVENT_FAILED",

  /**
   * Rappel authentifié portant sur une transaction que nous n'avons pas.
   *
   * Soit la référence est fausse (et il faut le savoir : un prestataire qui
   * nous envoie une référence inconnue signée peut aussi nous en envoyer une
   * juste avec le mauvais montant), soit la transaction a été supprimée alors
   * qu'un règlement la concernait.
   */
  PROVIDER_EVENT_ORPHAN: "PROVIDER_EVENT_ORPHAN",

  /**
   * ⚠️ LE PLUS COÛTEUX DES SIX POUR L'UTILISATEUR.
   *
   * Le prestataire dit SUCCÈS, notre transaction n'a jamais abouti. L'argent a
   * quitté le circuit du prestataire — donc, sur une collecte, il a été prélevé
   * chez le client — et rien n'a été crédité chez nous. Le client a payé et
   * n'a rien reçu ; il ouvrira une réclamation, et nous n'aurons aucune trace
   * du règlement pour la traiter.
   */
  PROVIDER_SUCCESS_NOT_APPLIED: "PROVIDER_SUCCESS_NOT_APPLIED",

  /**
   * ⚠️ LE PLUS COÛTEUX DES SIX POUR NOUS.
   *
   * Le dernier mot du prestataire est ÉCHEC, et nous avons pourtant crédité le
   * bénéficiaire. Nous avons livré de l'argent que personne n'a financé : la
   * perte est sèche et elle est pour nous. C'est le scénario que les fraudeurs
   * cherchent — provoquer un échec côté rail après avoir obtenu le crédit.
   */
  PROVIDER_FAILURE_APPLIED: "PROVIDER_FAILURE_APPLIED",

  /**
   * Transaction remise au prestataire, aucun rappel jamais reçu.
   *
   * Les prestataires PERDENT des rappels — mauvaise configuration d'URL, panne
   * de leur côté, réponse 5xx de notre côté au moment précis du dernier essai.
   * Sans ce contrôle, la transaction reste en attente indéfiniment : les fonds
   * de l'expéditeur sont réservés, invisibles pour lui, et rien ne signale
   * qu'il faut aller interroger le prestataire.
   */
  SETTLEMENT_TIMEOUT: "SETTLEMENT_TIMEOUT",
});

/* -------------------------------------------------------------------------- */
/* Délais                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Chaque délai répond à la question « à partir de quand est-ce anormal ? », et
 * jamais à « quelle valeur est jolie ».
 */
const DEFAULT_DELAYS = Object.freeze({
  /**
   * Un règlement en cours n'est pas un règlement bloqué. Le bail
   * d'idempotence vaut 5 min ; on attend le double par-dessus, pour qu'une
   * reprise légitime ait le temps d'aboutir avant qu'on crie à l'écart.
   */
  unsettledGraceMs: 10 * 60 * 1000,

  /**
   * Un échec sera rejoué par le prestataire dans l'heure, très généralement
   * dans les minutes. Passé ce délai sans reprise, c'est que les rejeux ont
   * cessé ou qu'ils échouent tous.
   */
  failedGraceMs: 60 * 60 * 1000,

  /**
   * Entre la réception d'un rappel et l'état final de la transaction, il y a
   * un règlement asynchrone. Le comparer trop tôt produirait un écart qui se
   * résout tout seul en quelques secondes — et une alerte qui se résout seule
   * apprend à ignorer les alertes.
   */
  verdictGraceMs: 30 * 60 * 1000,

  /**
   * Au-delà, un rail qui n'a rien dit ne dira plus rien. Six heures couvrent
   * largement les traitements par lots des opérateurs mobile money, qui sont
   * les plus lents.
   */
  settlementTimeoutMs: 6 * 60 * 60 * 1000,
});

/* -------------------------------------------------------------------------- */
/* Normalisation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Le contrôleur écrit déjà un statut canonique (`SUCCESS`, `FAILED`,
 * `PROCESSING`). On renormalise malgré tout : le registre a une rétention de
 * 90 jours, donc il contiendra des documents écrits par des versions
 * antérieures du contrôleur. Faire confiance au format de ses propres archives
 * est une hypothèse qui se dément toujours un jour.
 */
function canonicalVerdict(status) {
  const s = String(status || "").trim().toUpperCase();

  if (["SUCCESS", "SUCCEEDED", "COMPLETED", "PAID", "SETTLED", "CAPTURED"].includes(s)) {
    return "SUCCESS";
  }

  if (["FAILED", "FAILURE", "CANCELLED", "CANCELED", "REJECTED", "REVERSED", "EXPIRED"].includes(s)) {
    return "FAILED";
  }

  return "PROCESSING";
}

function toTime(value) {
  if (!value) return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/* -------------------------------------------------------------------------- */
/* État de NOTRE côté                                                         */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ ON REGARDE LES DRAPEAUX AVANT LE STATUT.
 *
 * `status` est déclaratif : il dit où en est le dossier. `beneficiaryCredited`
 * est factuel : il dit que l'argent est parti. Pour comparer avec un
 * prestataire qui, lui, parle d'argent, c'est le fait qui compte — une
 * transaction `confirmed` dont le bénéficiaire n'a jamais été crédité n'est pas
 * un succès appliqué, c'est déjà une anomalie que le service voisin attrape.
 */
function isSuccessApplied(tx) {
  if (!tx) return false;
  return tx.beneficiaryCredited === true || tx.fundsCaptured === true;
}

const FAILURE_STATUSES = Object.freeze(["cancelled", "failed", "refunded"]);

function isFailureApplied(tx) {
  if (!tx) return false;
  return FAILURE_STATUSES.includes(String(tx.status || "").toLowerCase());
}

/* -------------------------------------------------------------------------- */
/* 1 et 2. Rappels restés en plan                                             */
/* -------------------------------------------------------------------------- */

/**
 * Un rappel qui n'a pas abouti est-il en cours, ou abandonné ?
 *
 * @returns {{type: string, ageMs: number}|null} `null` si tout va bien.
 */
function classifyStuckEvent(event, { now, leaseMs, delays = DEFAULT_DELAYS } = {}) {
  if (!event) return null;

  const status = String(event.status || "").toLowerCase();

  if (status === "processing") {
    const startedAt = toTime(event.startedAt) ?? toTime(event.createdAt);
    if (startedAt === null) return null;

    const ageMs = now - startedAt;

    /**
     * Le seuil ADDITIONNE le bail : tant que le bail court, une autre instance
     * a légitimement l'événement en main. Ne compter que la grâce ferait
     * signaler des règlements parfaitement normaux.
     */
    if (ageMs <= leaseMs + delays.unsettledGraceMs) return null;

    return { type: PROVIDER_ANOMALIES.PROVIDER_EVENT_UNSETTLED, ageMs };
  }

  if (status === "failed") {
    // `updatedAt` : c'est la date du dernier échec, pas celle de la réception.
    const lastTouch = toTime(event.updatedAt) ?? toTime(event.startedAt) ?? toTime(event.createdAt);
    if (lastTouch === null) return null;

    const ageMs = now - lastTouch;
    if (ageMs <= delays.failedGraceMs) return null;

    return { type: PROVIDER_ANOMALIES.PROVIDER_EVENT_FAILED, ageMs };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* 3 à 5. Le dernier mot du prestataire contre notre état                      */
/* -------------------------------------------------------------------------- */

/**
 * De tous les rappels reçus sur une transaction, lequel fait foi ?
 *
 * ⚠️ LE DERNIER, ET C'EST UNE HYPOTHÈSE ASSUMÉE.
 *
 * Un prestataire peut légitimement envoyer ÉCHEC puis SUCCÈS : un premier essai
 * qui échoue, un second qui aboutit. Prendre le premier verdict ferait conclure
 * à un échec sur une opération réussie — et donc réclamer un remboursement à
 * l'utilisateur pour de l'argent qu'il a bien reçu.
 *
 * La limite : si deux rappels arrivent dans le désordre (ce qui existe, aucun
 * prestataire ne garantit l'ordre), le « dernier reçu » n'est pas le dernier
 * émis. On ordonne donc par la date de RÉCEPTION faute de mieux, et c'est
 * précisément pourquoi ce module SIGNALE au lieu de corriger : un humain
 * regarde la chronologie avant d'agir.
 */
function lastProviderWord(events = []) {
  const dates = [];

  for (const e of events) {
    const at = toTime(e?.processedAt) ?? toTime(e?.createdAt) ?? toTime(e?.startedAt);
    if (at === null) continue;

    dates.push({ event: e, at, verdict: canonicalVerdict(e.providerStatus) });
  }

  if (!dates.length) return null;

  /**
   * ⚠️ UN « EN COURS » N'EST PAS UN MOT, ET NE DOIT PAS COUVRIR CELUI D'AVANT.
   *
   * Constaté à la vérification sur base : une transaction portait un rappel
   * SUCCÈS et, à la même seconde, un rappel encore `PROCESSING`. Le second
   * l'emportait par simple ordre d'arrivée, son verdict valait « en cours », et
   * le contrôle concluait « rien à signaler » — alors que le prestataire avait
   * bel et bien annoncé un succès que nous n'avions jamais appliqué. Le pire
   * des écarts, masqué par le plus anodin des événements.
   *
   * Un verdict terminal (SUCCÈS ou ÉCHEC) est une affirmation sur l'argent ;
   * `PROCESSING` n'est qu'une absence d'affirmation. On ne retient donc les
   * non-terminaux QUE s'il n'existe aucun terminal — auquel cas le prestataire
   * n'a effectivement encore rien dit, et c'est l'information juste.
   */
  const terminaux = dates.filter((d) => d.verdict !== "PROCESSING");
  const candidats = terminaux.length ? terminaux : dates;

  /**
   * ⚠️ LE DÉPARTAGE À DATE ÉGALE DOIT ÊTRE DÉTERMINISTE.
   *
   * Deux rappels peuvent porter la même date à la seconde près — c'est même la
   * norme quand un prestataire émet une rafale. Retenir « le dernier de la
   * liste » faisait dépendre le résultat de l'ordre rendu par Mongo : deux
   * balayages successifs pouvaient conclure différemment sur les mêmes données.
   * Un contrôle financier qui n'est pas reproductible n'est pas un contrôle.
   *
   * L'identifiant de document sert d'arbitre : il est monotone dans le temps
   * (horodatage en tête d'ObjectId) et surtout, il est stable.
   */
  let best = candidats[0];

  for (const d of candidats.slice(1)) {
    if (d.at > best.at) best = d;
    else if (d.at === best.at && String(d.event?._id) > String(best.event?._id)) best = d;
  }

  return { event: best.event, verdict: best.verdict, at: best.at };
}

/**
 * Compare le dernier mot du prestataire à l'état réel de la transaction.
 *
 * @param {object|null} tx         La transaction, ou `null` si introuvable.
 * @param {object} word            Sortie de `lastProviderWord`.
 * @returns {{type: string, verdict: string, ageMs: number}|null}
 */
function classifyVerdict(tx, word, { now, delays = DEFAULT_DELAYS } = {}) {
  if (!word) return null;

  const ageMs = now - word.at;

  if (!tx) {
    /**
     * Pas de grâce ici : une transaction inexistante ne va pas apparaître. Le
     * seul retard possible serait une réplication en cours, et on lit sur le
     * primaire.
     */
    return { type: PROVIDER_ANOMALIES.PROVIDER_EVENT_ORPHAN, verdict: word.verdict, ageMs };
  }

  // Un verdict non terminal ne contredit rien : le prestataire travaille encore.
  if (word.verdict === "PROCESSING") return null;

  /**
   * La grâce ne s'applique qu'ICI, et pas au cas orphelin : entre le rappel et
   * l'état final il y a un règlement asynchrone, qui prend des secondes.
   */
  if (ageMs <= delays.verdictGraceMs) return null;

  if (word.verdict === "SUCCESS" && !isSuccessApplied(tx)) {
    return { type: PROVIDER_ANOMALIES.PROVIDER_SUCCESS_NOT_APPLIED, verdict: "SUCCESS", ageMs };
  }

  if (word.verdict === "FAILED" && isSuccessApplied(tx) && !isFailureApplied(tx)) {
    /**
     * `!isFailureApplied` est indispensable : une transaction remboursée porte
     * `beneficiaryCredited: true` (le crédit a bien eu lieu) ET un statut
     * `refunded`. Sans cette condition, tout remboursement légitime serait
     * signalé comme un règlement d'échec — c'est-à-dire que le contrôle
     * hurlerait exactement sur les dossiers déjà traités.
     */
    return { type: PROVIDER_ANOMALIES.PROVIDER_FAILURE_APPLIED, verdict: "FAILED", ageMs };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* 6. Le silence du prestataire                                               */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ LA DATE PLANCHER N'EST PAS UN DÉTAIL : SANS ELLE, LE CONTRÔLE EST INUTILE.
 *
 * Le registre des rappels n'existe que depuis son déploiement. Toute
 * transaction antérieure n'a, par construction, aucun rappel enregistré — et
 * serait donc signalée « aucun rappel jamais reçu ». Le premier tour de
 * réconciliation lèverait des centaines d'écarts faux, et un contrôle qui
 * s'ouvre sur des centaines de faux positifs est un contrôle qu'on désactive
 * dans la semaine.
 *
 * Le plancher se CALIBRE SUR LE REGISTRE LUI-MÊME : le plus ancien rappel connu
 * est la première date à laquelle on peut affirmer qu'on enregistrait. En
 * l'absence de tout rappel, on ne peut rien affirmer : le contrôle est SAUTÉ, et
 * il le dit — c'est la seule réponse honnête.
 */
function resolveRegistryFloor({ oldestEventAt, override } = {}) {
  const forced = toTime(override);
  if (forced !== null) return { floor: forced, reason: "override" };

  const oldest = toTime(oldestEventAt);
  if (oldest !== null) return { floor: oldest, reason: "oldest-event" };

  return { floor: null, reason: "registry-empty" };
}

/**
 * Cette transaction attend-elle un rappel qui n'arrivera pas ?
 *
 * @returns {{type: string, ageMs: number}|null}
 */
function classifySettlementTimeout(tx, { now, floor, delays = DEFAULT_DELAYS } = {}) {
  if (!tx || floor === null) return null;

  /**
   * Le point de départ est la remise au prestataire, pas la création : une
   * transaction créée hier et exécutée il y a dix minutes n'attend que depuis
   * dix minutes.
   */
  const submittedAt =
    toTime(tx.executedAt) ?? toTime(tx.fundsCapturedAt) ?? toTime(tx.createdAt);

  if (submittedAt === null) return null;

  // Antérieure au registre : on ne peut PAS conclure à un silence.
  if (submittedAt < floor) return null;

  const ageMs = now - submittedAt;
  if (ageMs <= delays.settlementTimeoutMs) return null;

  return { type: PROVIDER_ANOMALIES.SETTLEMENT_TIMEOUT, ageMs };
}

/* -------------------------------------------------------------------------- */

/**
 * Les clés par lesquelles un rappel peut être rattaché à une transaction.
 *
 * L'ordre compte : l'identifiant technique est certain, la référence est
 * fournie par le prestataire et peut avoir été altérée en route.
 */
function correlationKeys(event) {
  const keys = [];

  if (event?.transactionId) keys.push(`id:${String(event.transactionId)}`);
  if (event?.transactionReference) keys.push(`ref:${String(event.transactionReference).trim()}`);

  return keys;
}

function transactionKeys(tx) {
  const keys = [];

  if (tx?._id) keys.push(`id:${String(tx._id)}`);
  if (tx?.reference) keys.push(`ref:${String(tx.reference).trim()}`);

  return keys;
}

module.exports = {
  PROVIDER_ANOMALIES,
  DEFAULT_DELAYS,
  FAILURE_STATUSES,
  canonicalVerdict,
  isSuccessApplied,
  isFailureApplied,
  classifyStuckEvent,
  lastProviderWord,
  classifyVerdict,
  resolveRegistryFloor,
  classifySettlementTimeout,
  correlationKeys,
  transactionKeys,
};
