"use strict";

const mongoose = require("mongoose");

const {
  LEASE_MS,
  computeEventFingerprint,
  resolveEventKey,
  decideFromRecord,
} = require("./webhookIdempotency");

/**
 * ============================================================================
 * RÉSERVATION ET CLÔTURE D'UN RAPPEL PRESTATAIRE
 * ============================================================================
 *
 * La couche d'accès. Toute la DÉCISION vit dans `webhookIdempotency.js`, qui est
 * pur ; ici on ne fait que l'appliquer à MongoDB.
 *
 * ⚠️ LA RÉSERVATION S'APPUIE SUR L'INDEX UNIQUE, PAS SUR UNE LECTURE PRÉALABLE.
 *
 * « Lire puis écrire » laisse une fenêtre entre les deux : deux instances
 * recevant le même rappel — ce qui arrive, les prestataires réémettent en
 * parallèle — liraient toutes deux « rien », et régleraient toutes deux. C'est
 * exactement le double crédit qu'on veut empêcher.
 *
 * On tente donc l'INSERTION d'abord et on laisse l'index trancher : un seul
 * gagne, l'autre reçoit une violation d'unicité et relit pour savoir quoi faire.
 * C'est la même discipline que l'index de déduplication du grand livre.
 */

let _model = null;

function eventModel() {
  if (_model) return _model;

  const { getTxConn } = require("../../config/db");
  _model = require("../../models/ProviderWebhookEvent")(getTxConn());
  return _model;
}

/** Pour les tests : injecter une doublure sans toucher à `require.cache`. */
function setEventModel(model) {
  _model = model;
}

/**
 * ⚠️ CE QU'ON CONSERVE 90 JOURS EST UN CHOIX, PAS UN RESTE.
 *
 * `buildSettlementPayload` transporte `raw` — le corps brut du prestataire —
 * parce que le règlement en a besoin dans la seconde qui suit. Le registre, lui,
 * n'en a aucun usage : il sert à reconnaître un rejeu et à réconcilier, et les
 * deux se font sur les champs normalisés.
 *
 * Or ce corps brut porte, selon le rail, le numéro de téléphone et le nom du
 * bénéficiaire, ou les quatre derniers chiffres d'une carte. La politique du
 * projet interdit de journaliser ces données ; les stocker trois mois dans une
 * collection dont personne ne surveille les accès est strictement pire.
 *
 * On garde donc UNIQUEMENT ce qui décrit le fait — c'est la même liste que
 * l'empreinte d'idempotence, et ce n'est pas un hasard : si un champ ne sert pas
 * à distinguer deux événements, il ne sert pas non plus à les rejouer.
 */
const STORED_PAYLOAD_FIELDS = Object.freeze([
  "transactionId",
  "reference",
  "providerReference",
  "provider",
  "rail",
  "eventId",
  "eventType",
  "providerStatus",
  "status",
  "amount",
  "currency",
  "reason",

  /**
   * `verified` — AJOUTÉ : le rejeu l'INFÉRAIT au lieu de le lire.
   *
   * `appendWebhookHistory` (`controllers/externalSettlementController.js`)
   * écrit `verified: payload.verified !== false`. Tant que ce champ n'était pas
   * conservé, il valait `undefined` au rejeu — donc `!== false` — donc **`true`**.
   * Autrement dit : un événement rejoué depuis le registre s'inscrivait sur la
   * transaction comme « signature vérifiée », alors que personne n'avait
   * revérifié quoi que ce soit. Une observation remplacée par une supposition,
   * sur le champ qui dit si l'on peut faire confiance au message.
   *
   * ⚠️ Ce champ ne participe PAS à l'empreinte d'idempotence
   * (`computeEventFingerprint`, liste distincte de huit champs) : l'ajouter ici
   * ne change ni la déduplication ni le rejeu d'un événement déjà enregistré.
   */
  "verified",
]);

/**
 * Bornes de conservation. `reason` est du **texte libre rendu par le
 * prestataire** — `providerWebhookController` le remplit depuis `raw.message`,
 * `raw.error` ou `raw.data.message`. C'est le seul champ de la liste blanche
 * dont nous ne choisissons pas le contenu, et il était conservé 90 jours **sans
 * borne** : un opérateur qui renvoie son corps d'erreur complet dans ce champ
 * réintroduisait par la fenêtre ce que la liste blanche ferme à la porte.
 *
 * Même borne que `lastError` ci-dessous, et pour la même raison.
 */
const MAX_REASON_LENGTH = 300;

function truncateReason(value) {
  if (value === undefined || value === null) return value;

  const text = String(value);

  return text.length > MAX_REASON_LENGTH ? text.slice(0, MAX_REASON_LENGTH) : text;
}

function sanitizeStoredPayload(payload = {}) {
  const kept = {};

  for (const field of STORED_PAYLOAD_FIELDS) {
    const value = payload?.[field];
    if (value !== undefined) kept[field] = value;
  }

  if (kept.reason !== undefined) kept.reason = truncateReason(kept.reason);

  return kept;
}

/**
 * Rattachement direct à la transaction, quand le prestataire nous renvoie notre
 * propre identifiant technique. Toute valeur non castable est ignorée : un
 * identifiant fantaisiste ne doit ni faire échouer l'enregistrement du rappel,
 * ni créer un lien faux.
 */
function toObjectIdOrNull(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;

  const asString = String(value).trim();
  if (!mongoose.Types.ObjectId.isValid(asString)) return null;

  // `isValid` accepte toute chaîne de 12 caractères : on exige les 24 hexa.
  if (!/^[a-f\d]{24}$/i.test(asString)) return null;

  return new mongoose.Types.ObjectId(asString);
}

function isDuplicateKeyError(err) {
  if (!err) return false;
  if (err.code === 11000 || err.code === 11001) return true;

  const writeErrors = err.writeErrors || err?.result?.writeErrors;
  return Array.isArray(writeErrors)
    ? writeErrors.some((e) => (e?.code ?? e?.err?.code) === 11000)
    : false;
}

/**
 * Réserve l'événement, ou dit pourquoi c'est impossible.
 *
 * @returns {Promise<{action, status, record, key, derived}>}
 *   `action` vaut `process` (à traiter), `replay` (déjà traité) ou
 *   `conflict` (en cours ailleurs).
 */
async function claimEvent(payload = {}, { now = Date.now, leaseMs = LEASE_MS } = {}) {
  const Model = eventModel();
  const { key, derived } = resolveEventKey(payload);
  const fingerprint = computeEventFingerprint(payload);

  const base = {
    provider: String(payload.provider || "").trim().toLowerCase(),
    rail: String(payload.rail || "").trim().toLowerCase(),
    eventId: key,
    fingerprint,
    status: "processing",
    attempts: 1,
    startedAt: new Date(now()),
    transactionId: toObjectIdOrNull(payload.transactionId),
    transactionReference: payload.reference || null,
    providerReference: payload.providerReference || null,
    providerStatus: payload.providerStatus || null,
    eventType: payload.eventType || null,
    amount: typeof payload.amount === "number" ? payload.amount : null,
    currency: payload.currency || null,
    payload: sanitizeStoredPayload(payload),
  };

  try {
    const record = await Model.create(base);
    return { action: "process", status: 200, record, key, derived };
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
  }

  // L'index a tranché : quelqu'un d'autre a l'événement. Que fait-on ?
  const existing = await Model.findOne({ provider: base.provider, eventId: key }).lean();
  const decision = decideFromRecord(existing, { now: now(), leaseMs });

  if (decision.action !== "retake") {
    return { ...decision, record: existing, key, derived };
  }

  /**
   * Reprise d'un bail périmé ou d'un échec. Le filtre REPREND la condition
   * d'origine : sans elle, deux instances constatant simultanément l'expiration
   * reprendraient toutes deux. `findOneAndUpdate` est atomique, donc une seule
   * voit le document.
   */
  const repris = await Model.findOneAndUpdate(
    {
      provider: base.provider,
      eventId: key,
      $or: [
        { status: "failed" },
        { status: "processing", startedAt: { $lte: new Date(now() - leaseMs) } },
      ],
    },
    {
      $set: { status: "processing", startedAt: new Date(now()), lastError: null },
      $inc: { attempts: 1 },
    },
    { new: true }
  );

  if (!repris) {
    // Une autre instance a repris entre-temps : elle s'en occupe.
    return { action: "conflict", status: 409, record: existing, key, derived };
  }

  return { action: "process", status: 200, record: repris, key, derived };
}

/**
 * Clôture APRÈS que le règlement a réussi. Jamais avant : marquer d'abord
 * ferait perdre l'événement pour de bon si le règlement échouait ensuite.
 */
async function markProcessed(key, provider, { responseStatus = 200, now = Date.now } = {}) {
  const Model = eventModel();

  await Model.updateOne(
    { provider: String(provider || "").trim().toLowerCase(), eventId: key },
    { $set: { status: "processed", responseStatus, processedAt: new Date(now()) } }
  );
}

/**
 * Libère la réservation sur échec, pour que le rejeu du prestataire puisse
 * repartir immédiatement au lieu d'attendre l'expiration du bail.
 *
 * Le message d'erreur est TRONQUÉ : il peut contenir une réponse prestataire
 * entière, parfois porteuse de données personnelles.
 */
async function markFailed(key, provider, err) {
  const Model = eventModel();

  await Model.updateOne(
    { provider: String(provider || "").trim().toLowerCase(), eventId: key },
    {
      $set: {
        status: "failed",
        lastError: String(err?.message || err || "").slice(0, 300),
      },
    }
  );
}

module.exports = {
  claimEvent,
  sanitizeStoredPayload,
  toObjectIdOrNull,
  STORED_PAYLOAD_FIELDS,
  markProcessed,
  markFailed,
  setEventModel,
  isDuplicateKeyError,
};
