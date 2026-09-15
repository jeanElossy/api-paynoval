"use strict";

/**
 * ============================================================================
 * REMBOURSEMENT D'UN INVITÉ — VERSEMENT VERS SON OPÉRATEUR MOBILE MONEY
 * ============================================================================
 *
 * Décision du 2026-09-15 (validée par l'utilisateur) : un invité a payé par lien
 * public, sans compte PayNoval. On ne conserve que les 4 derniers chiffres de
 * son numéro (règle B.4) : l'administrateur SAISIT le numéro de remboursement,
 * qui doit correspondre à ces 4 chiffres. Le versement part sur le même
 * opérateur, au taux d'origine, au prorata — les frais ne sont pas remboursés
 * (même règle que pour un participant de l'app).
 *
 * Ordre des opérations — l'argent d'abord réservé, puis envoyé :
 *
 *   1. RÉSERVER (une transaction Mongo) : garde de concurrence sur le cumul
 *      remboursé, débit conditionnel de la position du coffre, règlement
 *      `payout_pending`, écritures au grand livre vers le compte de SORTIE
 *      prestataire. Aucun appel réseau dans la transaction.
 *   2. VERSER, hors transaction, par l'adaptateur de l'opérateur, avec la
 *      référence du remboursement (idempotence côté opérateur).
 *   3. SELON LA RÉPONSE :
 *        refus explicite  → contre-écriture exacte, coffre recrédité ;
 *        accepté          → `payout_submitted`, en attente du rappel ;
 *        succès immédiat  → `payout_succeeded` ;
 *        pas de réponse   → `payout_uncertain` : RIEN n'est contre-passé
 *                           (l'argent a peut-être quitté l'opérateur) ; le
 *                           rappel ou un rejeu avec la même référence tranche.
 *   4. RAPPEL OPÉRATEUR (`handleGuestRefundWebhook`) : succès → acquis ;
 *      échec → contre-écriture, une seule fois (transition gardée).
 *
 * Logique pure sur des dépendances injectées (`repo`, `getAdapter`, `now`) :
 * les transactions Mongo vivent dans `guestRefundRepo.js`.
 */

const { computeRefundAmounts, buildCagnotteGuestRefundLots } = require("../ledger/cagnotteLegs");

const STATUS = Object.freeze({
  PENDING: "payout_pending",
  UNCERTAIN: "payout_uncertain",
  SUBMITTED: "payout_submitted",
  SUCCEEDED: "payout_succeeded",
  REVERSED: "failed_reversed",
});

/** États dont le sort n'est pas encore tranché. */
const OPEN_STATUSES = Object.freeze([STATUS.PENDING, STATUS.UNCERTAIN, STATUS.SUBMITTED]);

/** États d'où l'on peut (re)soumettre le versement : l'opérateur n'a rien accepté. */
const RESUBMITTABLE = Object.freeze([STATUS.PENDING, STATUS.UNCERTAIN]);

const SUCCESS = new Set(["SUCCESS", "SUCCEEDED", "SUCCESSFUL", "COMPLETED", "PAID", "CONFIRMED", "DONE"]);
const FAILURE = new Set(["FAILED", "FAILURE", "REJECTED", "CANCELLED", "CANCELED", "EXPIRED", "ERROR", "DECLINED", "REVERSED"]);

function guestRefundError(status, code, message, details) {
  const err = new Error(message);
  err.status = status;
  err.statusCode = status;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

const str = (v) => String(v ?? "").trim();
const upper = (v) => str(v).toUpperCase();

/** Numéro saisi → chiffres (préfixe `+` toléré), ou `null` s'il est illisible. */
function normalizePayoutPhone(raw) {
  const compact = str(raw).replace(/[\s.\-()]/g, "");
  return /^\+?\d{8,15}$/.test(compact) ? compact : null;
}

function phoneLast4(phone) {
  const digits = str(phone).replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/** Statut opérateur → SUCCESS | FAILED | PENDING. Un statut inconnu ne tranche rien. */
function payoutOutcome(status) {
  const s = upper(status);
  if (SUCCESS.has(s)) return "SUCCESS";
  if (FAILURE.has(s)) return "FAILED";
  return "PENDING";
}

/** Vue sortante — jamais de numéro complet (il n'est d'ailleurs pas stocké). */
function refundToJSON(refund) {
  if (!refund) return null;

  return {
    reference: refund.reference,
    kind: refund.kind || "WALLET",
    status: refund.status,
    cagnotteId: refund.cagnotteId,
    vaultId: refund.vaultId,
    participationReference: refund.participationReference,
    refundTarget: refund.refundTarget,
    refundSource: refund.refundSource,
    isFinal: Boolean(refund.isFinal),
    payout: refund.payout
      ? {
          rail: refund.payout.rail,
          provider: refund.payout.provider,
          phoneLast4: refund.payout.phoneLast4,
          providerReference: refund.payout.providerReference || null,
          submittedAt: refund.payout.submittedAt || null,
          settledAt: refund.payout.settledAt || null,
          lastError: refund.payout.lastError?.code ? refund.payout.lastError : null,
          mock: Boolean(refund.payout.mock),
        }
      : null,
    createdAt: refund.createdAt || null,
  };
}

function reversalLotsFor(refund) {
  return buildCagnotteGuestRefundLots({
    rail: refund.payout.rail,
    sourceCurrency: refund.refundSource.currency,
    targetCurrency: refund.refundTarget.currency,
    refundSource: refund.refundSource.amount,
    refundTarget: refund.refundTarget.amount,
    reverse: true,
  });
}

/** Contre-écriture gardée : ne s'applique qu'une fois, depuis un état ouvert. */
async function compensate(refund, error, { repo, now }) {
  return repo.compensate({
    refund,
    error: { code: error.code, message: str(error.message).slice(0, 300) || null },
    reversalLots: reversalLotsFor(refund),
    at: now(),
  });
}

function buildPayoutPayload(refund, phone) {
  return {
    reference: refund.reference,
    txReference: refund.reference,
    idempotencyKey: refund.reference,
    amount: refund.refundSource.amount,
    currency: refund.refundSource.currency,
    phone,
    recipient: { phone, name: null },
    operator: refund.payout.provider,
    description: "Remboursement de participation à une cagnotte PayNoval",
    metadata: {
      kind: "cagnotte_guest_refund",
      provider: refund.payout.provider,
      rail: refund.payout.rail,
      cagnotteId: refund.cagnotteId,
      refundReference: refund.reference,
    },
  };
}

async function submitPayout(refund, phone, deps) {
  const { repo, getAdapter, now } = deps;

  let adapter = null;
  try {
    adapter = getAdapter({ rail: refund.payout.rail, provider: refund.payout.provider });
  } catch {
    adapter = null;
  }

  if (!adapter || typeof adapter.payout !== "function") {
    // Rien n'est parti : on rend l'argent au coffre, puis on le dit.
    await compensate(refund, { code: "PAYOUT_ADAPTER_UNAVAILABLE", message: "Adaptateur de versement indisponible." }, deps);
    throw guestRefundError(
      503,
      "PAYOUT_ADAPTER_UNAVAILABLE",
      `Versement impossible : l'opérateur ${refund.payout.provider} n'est pas branché. Le coffre est recrédité, rien n'a été remboursé.`
    );
  }

  await repo.incrementAttempts(refund._id);

  let result;
  try {
    result = await adapter.payout(buildPayoutPayload(refund, phone));
  } catch (err) {
    const updated = await repo.setStatus(refund._id, RESUBMITTABLE, STATUS.UNCERTAIN, {
      "payout.lastError": { code: "PAYOUT_CALL_FAILED", message: str(err?.message).slice(0, 300) || null },
    });
    return { refund: updated || refund, outcome: "UNCERTAIN" };
  }

  const outcome = result?.ok === false ? "FAILED" : payoutOutcome(result?.providerStatus || result?.status);

  if (outcome === "FAILED") {
    await compensate(
      refund,
      { code: result?.errorCode || "PAYOUT_REFUSED", message: result?.errorMessage || "Versement refusé par l'opérateur." },
      deps
    );
    throw guestRefundError(
      409,
      "PAYOUT_REFUSED",
      "L'opérateur a refusé le versement : le coffre est recrédité, rien n'a été remboursé.",
      { providerCode: result?.errorCode || null }
    );
  }

  const set = {
    "payout.providerReference": str(result?.providerReference) || null,
    "payout.providerStatus": str(result?.providerStatus || result?.status) || null,
    "payout.submittedAt": now(),
    "payout.mock": Boolean(result?.mock || result?.raw?.mock),
  };

  if (outcome === "SUCCESS") {
    const updated = await repo.setStatus(refund._id, OPEN_STATUSES, STATUS.SUCCEEDED, { ...set, "payout.settledAt": now() });
    return { refund: updated || refund, outcome: "SUCCEEDED" };
  }

  const updated = await repo.setStatus(refund._id, RESUBMITTABLE, STATUS.SUBMITTED, set);
  return { refund: updated || refund, outcome: "SUBMITTED" };
}

/**
 * @param {object} input  reference, idempotencyKey, participationReference,
 *                        initiatedByUserId, payoutPhone, reason?, amount?
 */
async function initiateGuestRefund(input, deps) {
  const { repo } = deps;

  const reference = str(input?.reference);
  const idempotencyKey = str(input?.idempotencyKey);
  const participationReference = str(input?.participationReference);
  const initiatedByUserId = str(input?.initiatedByUserId);
  const reason = str(input?.reason).slice(0, 500);
  const requestedTarget = input?.amount == null || input?.amount === "" ? null : Number(input.amount);

  if (!reference || !idempotencyKey || !participationReference || !initiatedByUserId) {
    throw guestRefundError(400, "INVALID_REQUEST", "reference, idempotencyKey, participationReference et initiatedByUserId sont requis.");
  }

  const phone = normalizePayoutPhone(input?.payoutPhone);
  if (!phone) {
    throw guestRefundError(400, "PAYOUT_PHONE_INVALID", "Numéro de versement illisible (8 à 15 chiffres attendus).");
  }

  const existing = await repo.findRefundByReference(reference);

  if (existing) {
    if (existing.kind !== "PAYOUT" || existing.participationReference !== participationReference) {
      throw guestRefundError(409, "REFERENCE_CONFLICT", "Cette référence de remboursement est déjà utilisée pour autre chose.");
    }

    if (RESUBMITTABLE.includes(existing.status)) {
      if (phoneLast4(phone) !== existing.payout?.phoneLast4) {
        throw guestRefundError(422, "PAYOUT_PHONE_MISMATCH", "Le numéro ne correspond pas au remboursement en cours.");
      }
      const out = await submitPayout(existing, phone, deps);
      return { ...out, alreadyProcessed: true };
    }

    return { refund: existing, outcome: null, alreadyProcessed: true };
  }

  const original = await repo.findExternalSettlement(participationReference);
  if (!original) throw guestRefundError(404, "PARTICIPATION_NOT_FOUND", "Participation par lien public introuvable.");

  if (Number(original.schemaVersion || 1) < 2 || original.netSource == null || !original.netToVault) {
    throw guestRefundError(
      409,
      "LEGACY_SETTLEMENT_NOT_REFUNDABLE",
      "Participation antérieure au règlement v2 : son taux n'a pas été figé. Traiter par ajustement manuel audité."
    );
  }

  if (original.rail !== "mobilemoney") {
    throw guestRefundError(
      501,
      "CARD_REFUND_UNSUPPORTED",
      "Remboursement vers une carte : aucun partenaire carte n'est encore branché."
    );
  }

  const intent = await repo.findCollectionIntent({
    providerReference: original.providerReference,
    cagnotteId: original.cagnotteId,
  });

  if (!intent || !/^\d{4}$/.test(str(intent.payerPhoneLast4))) {
    throw guestRefundError(
      409,
      "PAYER_UNVERIFIABLE",
      "Le payeur d'origine ne peut pas être vérifié (demande d'encaissement introuvable) : remboursement refusé."
    );
  }

  if (phoneLast4(phone) !== intent.payerPhoneLast4) {
    throw guestRefundError(
      422,
      "PAYOUT_PHONE_MISMATCH",
      "Ce numéro ne correspond pas au payeur d'origine (4 derniers chiffres différents)."
    );
  }

  const S = upper(original.collected?.currency);
  const T = upper(original.netToVault?.currency);
  const refundedSource = Number(original.refunded?.source || 0);
  const refundedTarget = Number(original.refunded?.target || 0);

  const amounts = computeRefundAmounts({
    sourceCurrency: S,
    targetCurrency: T,
    netSource: original.netSource,
    netTarget: original.netToVault.amount,
    refundedSource,
    refundedTarget,
    requestedTarget,
  });

  const lots = buildCagnotteGuestRefundLots({
    rail: original.rail,
    sourceCurrency: S,
    targetCurrency: T,
    refundSource: amounts.refundSource,
    refundTarget: amounts.refundTarget,
  });

  const doc = {
    reference,
    idempotencyKey,
    kind: "PAYOUT",
    participationReference,
    participationSettlementId: String(original._id),
    cagnotteId: original.cagnotteId,
    vaultId: original.vaultId,
    payerUserId: "",
    initiatedByUserId,
    reason,
    refundTarget: { amount: amounts.refundTarget, currency: T },
    refundSource: { amount: amounts.refundSource, currency: S },
    isFinal: amounts.isFinal,
    status: STATUS.PENDING,
    payout: {
      rail: original.rail,
      provider: original.provider,
      phoneLast4: phoneLast4(phone),
      attempts: 0,
    },
    meta: { settlementKind: "cagnotte_guest_refund" },
  };

  const reserved = await repo.reserve({ original, refundedSource, refundedTarget, amounts, doc, lots });

  if (reserved.replay) return { refund: reserved.refund, outcome: null, alreadyProcessed: true };

  return submitPayout(reserved.refund, phone, deps);
}

/**
 * Rappel d'un opérateur. Rend `null` s'il ne concerne pas un remboursement
 * invité — l'appelant continue alors vers ses autres traitements.
 */
async function handleGuestRefundWebhook(payload, deps) {
  const reference = str(payload?.reference);
  const providerReference = str(payload?.providerReference);
  if (!reference && !providerReference) return null;

  const refund = await deps.repo.findRefundForWebhook({ reference, providerReference });
  if (!refund) return null;

  const outcome = payoutOutcome(payload?.providerStatus || payload?.status);

  if (outcome === "SUCCESS") {
    const updated = await deps.repo.setStatus(refund._id, OPEN_STATUSES, STATUS.SUCCEEDED, { "payout.settledAt": deps.now() });
    return {
      statusCode: 200,
      body: { success: true, refund: refund.reference, status: updated ? STATUS.SUCCEEDED : refund.status },
    };
  }

  if (outcome === "FAILED") {
    const applied = await compensate(
      refund,
      { code: "PAYOUT_FAILED_AT_PROVIDER", message: str(payload?.providerStatus || payload?.status) },
      deps
    );
    return {
      statusCode: 200,
      body: { success: true, refund: refund.reference, status: applied ? STATUS.REVERSED : refund.status },
    };
  }

  return { statusCode: 200, body: { success: true, refund: refund.reference, status: refund.status } };
}

module.exports = {
  STATUS,
  OPEN_STATUSES,
  normalizePayoutPhone,
  phoneLast4,
  payoutOutcome,
  refundToJSON,
  initiateGuestRefund,
  handleGuestRefundWebhook,
  guestRefundError,
};
