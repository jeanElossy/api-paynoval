"use strict";

/**
 * ============================================================================
 * RÉCONCILIATION CONTRE LE PRESTATAIRE — LA COUCHE D'ACCÈS
 * ============================================================================
 *
 * Toute la DÉCISION vit dans `providerReconciliationRules.js`, qui est pur. Ici
 * on ne fait que lire Mongo et lui poser les questions.
 *
 * ⚠️ LECTURE SEULE, SANS EXCEPTION. Même règle que
 * `transactionReconciliationService` : ce service lit, compare et signale.
 * Jamais une écriture. Une réconciliation qui répare est une seconde source de
 * mouvements d'argent, déclenchée par un travail de fond que personne ne
 * regarde — donc un second risque de double crédit. Ce qui est signalé ici se
 * corrige par le chemin normal, ou à la main, en connaissance de cause.
 *
 * ⚠️ CE SERVICE N'EST PAS UN DOUBLON DU VOISIN.
 * `transactionReconciliationService` vérifie la cohérence INTERNE (portefeuille
 * ↔ grand livre ↔ transaction). Tous ses contrôles peuvent être verts pendant
 * que l'argent est perdu : il suffit que nous soyons cohéremment en désaccord
 * avec le prestataire. C'est ce second axe qu'on ouvre ici.
 */

const { getTxConn } = require("../../config/db");
const { LEASE_MS } = require("../webhooks/webhookIdempotency");
const { NOT_SANDBOX } = require("./transactionReconciliationService");

const {
  PROVIDER_ANOMALIES,
  DEFAULT_DELAYS,
  canonicalVerdict,
  classifyStuckEvent,
  lastProviderWord,
  classifyVerdict,
  resolveRegistryFloor,
  classifySettlementTimeout,
  correlationKeys,
  transactionKeys,
} = require("./providerReconciliationRules");

let logger = console;
try {
  logger = require("../../logger");
} catch {}

function model(name) {
  const conn = getTxConn();
  if (!conn.models[name]) throw new Error(`Modèle ${name} non enregistré`);
  return conn.models[name];
}

/**
 * Les délais viennent de l'environnement, avec le défaut documenté du module de
 * règles. On les résout à CHAQUE passe et non au chargement : un défaut de
 * calibrage doit pouvoir se corriger par une variable, sans redéploiement.
 */
function resolveDelays(overrides = {}) {
  const fromEnv = {
    unsettledGraceMs: Number(process.env.RECONCILE_PROVIDER_UNSETTLED_GRACE_MS),
    failedGraceMs: Number(process.env.RECONCILE_PROVIDER_FAILED_GRACE_MS),
    verdictGraceMs: Number(process.env.RECONCILE_PROVIDER_VERDICT_GRACE_MS),
    settlementTimeoutMs: Number(process.env.RECONCILE_SETTLEMENT_TIMEOUT_MS),
  };

  const delays = { ...DEFAULT_DELAYS };

  for (const [key, value] of Object.entries(fromEnv)) {
    if (Number.isFinite(value) && value > 0) delays[key] = value;
  }

  return { ...delays, ...overrides };
}

/**
 * Ce qu'on expose d'un rappel dans un rapport.
 *
 * ⚠️ NI `payload`, NI `lastError` COMPLET. Le rapport est stocké 90 jours dans
 * `reconciliation_runs` et relu par des humains : y recopier la charge d'un
 * rappel étendrait à une seconde collection les données personnelles qu'on
 * vient justement de retirer du registre.
 */
function describeEvent(event) {
  return {
    eventRecordId: String(event._id),
    provider: event.provider || null,
    rail: event.rail || null,
    eventId: event.eventId || null,
    eventType: event.eventType || null,
    providerStatus: canonicalVerdict(event.providerStatus),
    transactionReference: event.transactionReference || null,
    transactionId: event.transactionId ? String(event.transactionId) : null,
    providerReference: event.providerReference || null,
    amount: typeof event.amount === "number" ? event.amount : null,
    currency: event.currency || null,
    attempts: event.attempts ?? null,
    receivedAt: event.createdAt || event.startedAt || null,
  };
}

function hours(ms) {
  return Math.round((ms / 3600000) * 10) / 10;
}

/* -------------------------------------------------------------------------- */
/* 1 et 2. Rappels réservés puis abandonnés                                   */
/* -------------------------------------------------------------------------- */

/**
 * Les rappels que NOUS n'avons pas su clore.
 *
 * C'est le seul contrôle du fichier où l'anomalie vient de notre côté et où
 * personne ne réémettra : le prestataire n'a jamais reçu de 2xx, ses rejeux ont
 * fini par s'arrêter, et l'événement dort dans le registre.
 */
async function checkStuckProviderEvents({ sinceHours, limit, delays, now }) {
  const ProviderWebhookEvent = model("ProviderWebhookEvent");
  const since = new Date(now - sinceHours * 3600 * 1000);
  const anomalies = [];

  const events = await ProviderWebhookEvent.find({
    status: { $in: ["processing", "failed"] },
    createdAt: { $gte: since },
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

  for (const event of events) {
    const verdict = classifyStuckEvent(event, { now, leaseMs: LEASE_MS, delays });
    if (!verdict) continue;

    anomalies.push({
      type: verdict.type,
      ...describeEvent(event),
      status: event.status,
      ageHours: hours(verdict.ageMs),
      lastError: event.lastError ? String(event.lastError).slice(0, 200) : null,
      detail:
        verdict.type === PROVIDER_ANOMALIES.PROVIDER_EVENT_UNSETTLED
          ? "rappel réservé puis jamais clôturé : règlement interrompu, aucun rejeu à attendre"
          : "rappel en échec jamais repris : l'événement est perdu si personne ne le rejoue",
    });
  }

  return { checked: events.length, anomalies };
}

/* -------------------------------------------------------------------------- */
/* 3 à 5. Le dernier mot du prestataire contre notre état                      */
/* -------------------------------------------------------------------------- */

const DETAILS = Object.freeze({
  [PROVIDER_ANOMALIES.PROVIDER_EVENT_ORPHAN]:
    "rappel authentifié portant sur une transaction introuvable",
  [PROVIDER_ANOMALIES.PROVIDER_SUCCESS_NOT_APPLIED]:
    "le prestataire déclare un SUCCÈS que nous n'avons jamais appliqué : le client a payé et n'a rien reçu",
  [PROVIDER_ANOMALIES.PROVIDER_FAILURE_APPLIED]:
    "le prestataire déclare un ÉCHEC alors que nous avons crédité : argent livré sans financement",
});

/**
 * Regroupe les rappels par transaction, puis confronte le dernier verdict à
 * l'état réel.
 *
 * Le rattachement se fait par DEUX chemins (identifiant technique et
 * référence), parce que les prestataires ne renvoient pas tous la même chose :
 * certains ne connaissent que notre référence, d'autres ne renvoient que
 * l'identifiant qu'on leur a passé en métadonnée.
 */
async function checkProviderVerdicts({ sinceHours, limit, delays, now }) {
  const ProviderWebhookEvent = model("ProviderWebhookEvent");
  const Transaction = model("Transaction");

  const since = new Date(now - sinceHours * 3600 * 1000);
  const anomalies = [];

  const events = await ProviderWebhookEvent.find({
    createdAt: { $gte: since },
    $or: [{ transactionReference: { $ne: null } }, { transactionId: { $ne: null } }],
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

  if (!events.length) return { checked: 0, anomalies };

  /**
   * Regroupement par clé de corrélation. Un même rappel peut porter les deux
   * clés : il est alors rangé sous les deux, et le dédoublonnage se fait à la
   * fin sur l'identifiant de transaction résolu. Regrouper sur une seule clé
   * ferait passer à côté du cas — fréquent — où le premier rappel porte la
   * référence et le second l'identifiant.
   */
  const byKey = new Map();
  const ids = new Set();
  const refs = new Set();

  for (const event of events) {
    for (const key of correlationKeys(event)) {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(event);

      if (key.startsWith("id:")) ids.add(key.slice(3));
      else refs.add(key.slice(4));
    }
  }

  const transactions = await Transaction.find({
    $or: [
      ...(ids.size ? [{ _id: { $in: [...ids] } }] : []),
      ...(refs.size ? [{ reference: { $in: [...refs] } }] : []),
    ],
    ...NOT_SANDBOX,
  })
    .select(
      "_id reference status flow provider providerStatus fundsCaptured " +
        "beneficiaryCredited executedAt createdAt amount currency"
    )
    .lean();

  /** Une transaction est atteignable par ses deux clés. */
  const txByKey = new Map();
  for (const tx of transactions) {
    for (const key of transactionKeys(tx)) txByKey.set(key, tx);
  }

  /**
   * Rassemble tous les rappels d'une MÊME transaction, quelle que soit la clé
   * qui les y rattache.
   */
  const groupes = new Map();

  for (const [key, list] of byKey) {
    const tx = txByKey.get(key) || null;
    const groupKey = tx ? String(tx._id) : key;

    if (!groupes.has(groupKey)) groupes.set(groupKey, { tx, events: [] });

    const groupe = groupes.get(groupKey);
    if (!groupe.tx && tx) groupe.tx = tx;

    for (const event of list) {
      if (!groupe.events.some((e) => String(e._id) === String(event._id))) {
        groupe.events.push(event);
      }
    }
  }

  for (const [groupKey, { tx, events: list }] of groupes) {
    const word = lastProviderWord(list);
    const verdict = classifyVerdict(tx, word, { now, delays });
    if (!verdict) continue;

    anomalies.push({
      type: verdict.type,
      transactionId: tx ? String(tx._id) : null,
      reference: tx?.reference || word.event.transactionReference || null,
      status: tx?.status || null,
      flow: tx?.flow || null,
      beneficiaryCredited: tx?.beneficiaryCredited ?? null,
      fundsCaptured: tx?.fundsCaptured ?? null,
      providerVerdict: verdict.verdict,
      eventCount: list.length,
      ageHours: hours(verdict.ageMs),
      lastEvent: describeEvent(word.event),
      correlation: tx ? null : groupKey,
      detail: DETAILS[verdict.type],
    });
  }

  return { checked: events.length, anomalies };
}

/* -------------------------------------------------------------------------- */
/* 6. Le silence du prestataire                                               */
/* -------------------------------------------------------------------------- */

const EXTERNAL_FLOWS = Object.freeze([
  "PAYNOVAL_TO_MOBILEMONEY_PAYOUT",
  "PAYNOVAL_TO_BANK_PAYOUT",
  "PAYNOVAL_TO_CARD_PAYOUT",
  "MOBILEMONEY_COLLECTION_TO_PAYNOVAL",
  "BANK_TRANSFER_TO_PAYNOVAL",
  "CARD_TOPUP_TO_PAYNOVAL",
]);

const PENDING_STATUSES = Object.freeze([
  "pending",
  "pending_review",
  "processing",
  "locked",
  "relaunch",
]);

/**
 * Les transactions remises au prestataire dont aucun rappel n'est jamais
 * revenu.
 *
 * Le contrôle est SAUTÉ tant que le registre est vide : avant son premier
 * rappel, on ne peut pas distinguer « le prestataire n'a rien dit » de « on
 * n'enregistrait pas encore ». Voir `resolveRegistryFloor`.
 */
async function checkSettlementTimeouts({ sinceHours, limit, delays, now }) {
  const ProviderWebhookEvent = model("ProviderWebhookEvent");
  const Transaction = model("Transaction");

  const oldest = await ProviderWebhookEvent.findOne({})
    .sort({ createdAt: 1 })
    .select("createdAt")
    .lean();

  const { floor, reason } = resolveRegistryFloor({
    oldestEventAt: oldest?.createdAt,
    override: process.env.RECONCILE_PROVIDER_REGISTRY_SINCE,
  });

  if (floor === null) {
    logger.info?.(
      "[RECONCILE][PROVIDER] contrôle des silences sauté — registre des rappels vide"
    );
    return { checked: 0, anomalies: [], skipped: true, reason };
  }

  const since = new Date(Math.max(now - sinceHours * 3600 * 1000, floor));

  const candidates = await Transaction.find({
    flow: { $in: EXTERNAL_FLOWS },
    status: { $in: PENDING_STATUSES },
    provider: { $ne: null },
    createdAt: { $gte: since },
    ...NOT_SANDBOX,
  })
    .select(
      "_id reference status flow provider providerReference providerStatus " +
        "executedAt fundsCapturedAt createdAt amount currency"
    )
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

  if (!candidates.length) {
    return { checked: 0, anomalies: [], floorAt: new Date(floor), reason };
  }

  /**
   * On ne retient d'abord que celles dont l'attente dépasse le seuil : inutile
   * d'interroger le registre pour une transaction soumise il y a dix minutes.
   */
  const attendues = candidates
    .map((tx) => ({ tx, verdict: classifySettlementTimeout(tx, { now, floor, delays }) }))
    .filter((entry) => entry.verdict);

  if (!attendues.length) {
    return { checked: candidates.length, anomalies: [], floorAt: new Date(floor), reason };
  }

  const ids = attendues.map(({ tx }) => tx._id);
  const references = attendues.map(({ tx }) => tx.reference).filter(Boolean);

  const events = await ProviderWebhookEvent.find({
    $or: [
      { transactionId: { $in: ids } },
      ...(references.length ? [{ transactionReference: { $in: references } }] : []),
    ],
  })
    .select("transactionId transactionReference")
    .lean();

  const vus = new Set();
  for (const e of events) {
    if (e.transactionId) vus.add(`id:${String(e.transactionId)}`);
    if (e.transactionReference) vus.add(`ref:${String(e.transactionReference).trim()}`);
  }

  const anomalies = [];

  for (const { tx, verdict } of attendues) {
    if (transactionKeys(tx).some((key) => vus.has(key))) continue;

    anomalies.push({
      type: verdict.type,
      transactionId: String(tx._id),
      reference: tx.reference || null,
      status: tx.status,
      flow: tx.flow,
      provider: tx.provider || null,
      providerReference: tx.providerReference || null,
      submittedAt: tx.executedAt || tx.fundsCapturedAt || tx.createdAt,
      ageHours: hours(verdict.ageMs),
      detail:
        "remise au prestataire sans aucun rappel en retour : interroger le prestataire, les fonds restent immobilisés",
    });
  }

  return {
    checked: candidates.length,
    anomalies,
    floorAt: new Date(floor),
    reason,
  };
}

/* -------------------------------------------------------------------------- */

/**
 * Passe complète sur l'axe prestataire. Ne modifie RIEN.
 *
 * @returns {Promise<{healthy: boolean, checked: object, anomalies: Array}>}
 */
async function reconcileAgainstProviders({
  sinceHours = Number(process.env.RECONCILIATION_WINDOW_HOURS || 48),
  limit = Number(process.env.RECONCILIATION_LIMIT || 5000),
  now = Date.now(),
  delays: delayOverrides = {},
} = {}) {
  const delays = resolveDelays(delayOverrides);
  const args = { sinceHours, limit, delays, now };

  const [stuck, verdicts, timeouts] = await Promise.all([
    checkStuckProviderEvents(args),
    checkProviderVerdicts(args),
    checkSettlementTimeouts(args),
  ]);

  const anomalies = [...stuck.anomalies, ...verdicts.anomalies, ...timeouts.anomalies];

  const report = {
    healthy: anomalies.length === 0,
    window: { sinceHours, since: new Date(now - sinceHours * 3600 * 1000) },
    checked: {
      providerEvents: stuck.checked + verdicts.checked,
      awaitingSettlement: timeouts.checked,
    },
    registry: {
      floorAt: timeouts.floorAt || null,
      reason: timeouts.reason || null,
      settlementTimeoutSkipped: timeouts.skipped === true,
    },
    anomalies,
  };

  if (report.healthy) {
    logger.info?.("[RECONCILE][PROVIDER] aucun écart", { checked: report.checked });
  } else {
    logger.warn?.("[RECONCILE][PROVIDER] écarts détectés", {
      count: anomalies.length,
      types: [...new Set(anomalies.map((a) => a.type))],
    });
  }

  return report;
}

module.exports = {
  reconcileAgainstProviders,
  checkStuckProviderEvents,
  checkProviderVerdicts,
  checkSettlementTimeouts,
  resolveDelays,
  describeEvent,
  EXTERNAL_FLOWS,
  PENDING_STATUSES,
  PROVIDER_ANOMALIES,
};
