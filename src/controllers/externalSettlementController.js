// File: src/controllers/externalSettlementController.js
"use strict";

/**
 * Webhook settlement TX Core.
 *
 * Rôle :
 * - SUCCESS inbound  => crédit wallet receiver local
 * - SUCCESS outbound => confirmation finale sans crédit local receiver
 * - FAILED outbound  => release reserve OU refund sender si déjà capturé
 *
 * Sécurité :
 * - ignore les webhooks tardifs sur une transaction auto-annulée / finale
 * - bloque une confirmation provider si autoCancelAt est déjà dépassé
 * - rend les webhooks idempotents via eventId dans webhookHistory
 */

const createError = require("http-errors");

const { publishDomainEvent } = require("../services/events/publisher");
const runtime = require("../services/transactions/shared/runtime");
const { canTransition } = require("../services/transactionStateMachine");
const logger = require("../utils/logger");
const { captureSenderReserve, releaseSenderReserve, refundSenderFunds, creditReceiverFunds, creditTreasuryRevenue, resolveTreasuryFromSystemType, normalizeTreasurySystemType, startTxSession, maybeSessionOpts, canUseSharedSession, runInTransaction } = runtime;

/**
 * Modèles liés PARESSEUSEMENT : chaque accès de propriété va chercher le
 * modèle au moment de l'usage. Les déstructurer directement résolvait la
 * connexion Mongo au chargement du fichier, ce qui rendait ce module
 * impossible à charger hors d'un serveur démarré.
 */
const { Transaction } = runtime.lazyModels(["Transaction"]);

const {
  notifyParties,
} = require("../services/transactions/shared/notifications");

const {
  round2,
  toFloat,
} = require("../services/transactions/shared/helpers");

const {
  isOutboundExternalFlow,
  isInboundExternalFlow,
} = require("../services/transactions/handlers/flowHelpers");

const DEFAULT_FEES_TREASURY_SYSTEM_TYPE = "FEES_TREASURY";
const DEFAULT_FEES_TREASURY_LABEL = "PayNoval Fees Treasury";

const FINAL_STATUSES = new Set([
  "confirmed",
  "completed",
  "success",
  "successful",
  "validated",
  "cancelled",
  "canceled",
  "failed",
  "refunded",
  "reversed",
]);

function low(value) {
  return String(value || "").trim().toLowerCase();
}

function mapProviderState(payload = {}) {
  const raw =
    payload.status ||
    payload.providerStatus ||
    payload.event ||
    payload.state ||
    "";

  const status = low(raw);

  if (
    [
      "success",
      "successful",
      "completed",
      "confirmed",
      "paid",
      "settled",
      "captured",
      "succeeded",
      "approved",
      "ok",
    ].includes(status)
  ) {
    return "SUCCESS";
  }

  if (
    [
      "failed",
      "failure",
      "error",
      "cancelled",
      "canceled",
      "expired",
      "rejected",
      "reversed",
      "declined",
      "voided",
    ].includes(status)
  ) {
    return "FAILED";
  }

  return "PROCESSING";
}

function normalizeProviderReference(payload = {}) {
  return (
    payload.providerReference ||
    payload.externalReference ||
    payload.reference ||
    payload.raw?.providerReference ||
    payload.raw?.externalReference ||
    payload.raw?.reference ||
    null
  );
}

function normalizeReference(payload = {}) {
  return (
    payload.reference ||
    payload.txReference ||
    payload.raw?.reference ||
    payload.raw?.txReference ||
    null
  );
}

function hasWebhookEventBeenSeen(tx, payload = {}) {
  const eventId = String(payload.eventId || "").trim();

  if (!eventId) return false;

  const list = Array.isArray(tx.webhookHistory) ? tx.webhookHistory : [];

  return list.some(
    (entry) => String(entry?.eventId || "").trim() === eventId
  );
}

/**
 * ⚠️ `payload.raw` N'EST PLUS CONSERVÉ ICI.
 *
 * Cette fonction recopiait le corps BRUT du prestataire sur la transaction —
 * donc, selon le rail, le numéro de téléphone et le nom du bénéficiaire, ou les
 * quatre derniers chiffres d'une carte. Deux aggravations par rapport au même
 * défaut corrigé sur `provider_webhook_events` :
 *
 *   - une transaction ne s'efface jamais, là où le registre a une rétention de
 *     90 jours ;
 *   - `webhookHistory` sortait de l'API dans chaque réponse portant une
 *     transaction (application mobile, back-office, passerelle), le sérialiseur
 *     ne l'écartant pas.
 *
 * On ne garde que ce qui DÉCRIT le fait — la même liste que le registre, et ce
 * n'est pas un hasard : ce qui ne sert pas à distinguer deux événements ne sert
 * pas non plus à comprendre ce qui s'est passé.
 *
 * `verified` reste, et reste en `!== false` : cette trace sert aussi à savoir
 * si un règlement est parti d'un rappel authentifié.
 */
function appendWebhookHistory(tx, payload = {}) {
  const list = Array.isArray(tx.webhookHistory) ? [...tx.webhookHistory] : [];

  list.push({
    at: new Date(),
    eventId: payload.eventId || null,
    eventType: payload.eventType || null,
    status:
      payload.status ||
      payload.providerStatus ||
      payload.event ||
      payload.state ||
      null,
    provider: payload.provider || null,
    rail: payload.rail || null,
    amount: typeof payload.amount === "number" ? payload.amount : null,
    currency: payload.currency || null,
    providerReference: normalizeProviderReference(payload),
    reference: normalizeReference(payload),
    verified: payload.verified !== false,
  });

  tx.webhookHistory = list.slice(-50);
}

async function findTransactionFromWebhook(payload = {}, session = null) {
  const providerReference = normalizeProviderReference(payload);
  const transactionId = payload.transactionId || null;
  const reference = normalizeReference(payload);

  if (transactionId) {
    const byId = await Transaction.findById(transactionId).session(
      session || null
    );

    if (byId) return byId;
  }

  if (providerReference) {
    const byProviderRef = await Transaction.findOne({
      providerReference,
    }).session(session || null);

    if (byProviderRef) return byProviderRef;
  }

  if (reference) {
    const byReference = await Transaction.findOne({
      reference,
    }).session(session || null);

    if (byReference) return byReference;
  }

  return null;
}

function buildReferralSyncError(err) {
  return {
    ok: false,
    skipped: true,
    reason: "REFERRAL_SYNC_EXCEPTION",
    error: err?.message || "Referral sync failed",
  };
}

function resolveFeesTreasuryMeta(tx) {
  const treasurySystemType = normalizeTreasurySystemType(
    tx?.treasurySystemType || DEFAULT_FEES_TREASURY_SYSTEM_TYPE
  );

  const treasuryUserId = String(
    tx?.treasuryUserId ||
      resolveTreasuryFromSystemType(treasurySystemType) ||
      ""
  ).trim();

  const treasuryLabel = String(
    tx?.treasuryLabel || DEFAULT_FEES_TREASURY_LABEL
  ).trim();

  if (!treasuryUserId) {
    throw createError(500, `Treasury introuvable pour ${treasurySystemType}`);
  }

  return {
    treasuryUserId,
    treasurySystemType,
    treasuryLabel,
  };
}

function isFinalOrAutoCancelled(tx) {
  const status = low(tx?.status);

  return (
    !!tx?.autoCancelledAt ||
    tx?.providerStatus === "AUTO_CANCELLED_EXPIRED" ||
    FINAL_STATUSES.has(status)
  );
}

function isExpiredBeforeSettlement(tx) {
  if (!tx?.autoCancelAt) return false;

  const autoCancelDate = new Date(tx.autoCancelAt);

  if (!Number.isFinite(autoCancelDate.getTime())) return false;
  if (autoCancelDate > new Date()) return false;

  return (
    !tx.confirmedAt &&
    !tx.executedAt &&
    tx.fundsCaptured !== true &&
    tx.beneficiaryCredited !== true
  );
}

function resolveSourceCurrency(tx) {
  return String(
    tx?.senderCurrencySymbol ||
      tx?.currencySource ||
      tx?.money?.source?.currency ||
      ""
  )
    .trim()
    .toUpperCase();
}

function resolveTargetCurrency(tx) {
  return String(
    tx?.localCurrencySymbol ||
      tx?.currencyTarget ||
      tx?.money?.target?.currency ||
      ""
  )
    .trim()
    .toUpperCase();
}

function resolveGrossSource(tx) {
  return round2(
    toFloat(
      tx?.money?.source?.amount ??
        tx?.amountSource ??
        tx?.amount ??
        0
    )
  );
}

function resolveTargetAmount(tx) {
  return round2(
    toFloat(
      tx?.money?.target?.amount ??
        tx?.amountTarget ??
        tx?.localAmount ??
        0
    )
  );
}

/**
 * `commitAndEnd` vivait ici et validait la transaction depuis SEPT endroits
 * différents — dont quatre sous-fonctions de règlement. Une transaction validée
 * au milieu d'un traitement ne peut pas être rejouée : le rejeu repartirait d'un
 * état déjà figé.
 *
 * Retirée le 2026-08-19 : le handler enveloppe désormais tout le traitement dans
 * une seule unité de travail, `withTransaction` valide une fois, et la session
 * se ferme dans le `finally` du handler.
 */

async function abortAndEnd(session) {
  try {
    if (canUseSharedSession() && session) {
      await session.abortTransaction();
    }
  } catch {}

  try {
    session?.endSession?.();
  } catch {}
}

/**
 * Publie l'événement de parrainage, dans le régime de session de l'appelant.
 *
 * ── Historique ──────────────────────────────────────────────────────────────
 *
 * 1. Appel HTTP en ligne au backend principal — ni file ni reprise : une
 *    indisponibilité momentanée du principal perdait l'événement DÉFINITIVEMENT.
 * 2. Outbox transactionnel privé (`outboxes`, `service: "referral"`).
 * 3. Bus d'événements partagé, depuis le 2026-09-10.
 *
 * ⚠️ Le passage de 2 à 3 change le TRANSPORT, pas la garantie : l'écriture
 * reste dans la session de l'appelant, donc dans la même transaction que le
 * règlement. L'équivalence « règlement acquis ⟺ événement existe » tient.
 *
 * ⚠️ `sessionOpts` est de la forme `{ session }` (ou `{}` hors transaction) ;
 * `publishDomainEvent` attend la SESSION elle-même. Passer l'objet entier ferait
 * sortir l'écriture de la transaction — en silence, car Mongoose ignorerait un
 * second argument qu'il ne reconnaît pas.
 */
async function runReferralSync(tx, sessionOpts = {}) {
  try {
    const refereeId = String(tx?.userId || tx?.sender || "").trim();

    if (!refereeId) {
      return { enqueued: false, reason: "MISSING_IDENTIFIERS" };
    }

    await publishDomainEvent(
      {
        name: "referral.activity.confirmed.v1",
        aggregateId: String(tx._id),
        occurredAt: tx.confirmedAt || new Date(),
        payload: {
          refereeId,
          triggerTxId: String(tx._id),
          reference: String(tx.reference || ""),
          flow: String(tx.flow || ""),
          confirmedAt: (tx.confirmedAt || new Date()).toISOString(),
          correlationId: `referral-${String(tx._id)}`,
        },
      },
      sessionOpts?.session || null
    );

    return { enqueued: true, transport: "event-bus" };
  } catch (err) {
    return buildReferralSyncError(err);
  }
}

async function settleProcessingWebhook({
  tx,
  payload,
  sessOpts,
  session,
}) {
  tx.status = "processing";
  tx.providerStatus =
    payload.status || payload.providerStatus || "PROVIDER_PROCESSING";

  await tx.save(sessOpts);
  return {
    statusCode: 202,
    body: {
      success: true,
      transactionId: tx._id.toString(),
      status: tx.status,
      providerStatus: tx.providerStatus,
      eventId: payload.eventId || null,
    },
  };
}

async function settleOutboundSuccess({
  tx,
  payload,
  sessOpts,
  session,
  sourceCurrency,
  grossSource,
  notifyCurrency,
}) {
  if (!sourceCurrency) {
    throw createError(409, "Devise source introuvable sur la transaction");
  }

  if (!Number.isFinite(grossSource) || grossSource <= 0) {
    throw createError(409, "Montant source invalide");
  }

  if (tx.fundsReserved && !tx.fundsCaptured) {
    await captureSenderReserve({
      transaction: tx,
      senderId: tx.sender,
      amount: grossSource,
      currency: sourceCurrency,
      session,
    });

    tx.fundsCaptured = true;
    tx.fundsCapturedAt = new Date();
  }

  if (!tx.treasuryRevenueCredited) {
    const treasuryMeta = resolveFeesTreasuryMeta(tx);

    const creditResult = await creditTreasuryRevenue({
      transaction: tx,
      pricingSnapshot: tx.pricingSnapshot || {},
      treasurySystemType: treasuryMeta.treasurySystemType,
      treasuryLabel: treasuryMeta.treasuryLabel,
      session,
    });

    tx.treasuryRevenue = creditResult?.treasuryRevenue || null;
    tx.treasuryRevenueCredited = true;
    tx.treasuryRevenueCreditedAt = new Date();
    tx.treasuryUserId = treasuryMeta.treasuryUserId;
    tx.treasurySystemType = treasuryMeta.treasurySystemType;
    tx.treasuryLabel = treasuryMeta.treasuryLabel;
  }

  tx.status = "confirmed";
  tx.confirmedAt = new Date();
  tx.executedAt = new Date();
  tx.providerStatus = payload.status || payload.providerStatus || "SUCCESS";
  tx.settlement = {
    ...(tx.settlement || {}),
    settledAt: new Date(),
    providerResult: "SUCCESS",
    eventId: payload.eventId || null,
    eventType: payload.eventType || null,
  };

  await tx.save(sessOpts);
  await notifyParties(tx, "confirmed", session, notifyCurrency);

  // Mise en file AVANT le commit : l'evenement de parrainage est solidaire de
  // la confirmation. Motif « outbox transactionnel » : voir l'en-tete de
  // services/events/publisher.js, qui porte desormais cette garantie.
  const referralSync = await runReferralSync(tx, sessOpts);

  return {
    statusCode: 200,
    body: {
      success: true,
      transactionId: tx._id.toString(),
      flow: tx.flow,
      status: tx.status,
      providerStatus: tx.providerStatus,
      treasuryRevenue: tx.treasuryRevenue || null,
      treasuryRevenueCredited: !!tx.treasuryRevenueCredited,
      treasuryUserId: tx.treasuryUserId || null,
      treasurySystemType: tx.treasurySystemType || null,
      treasuryLabel: tx.treasuryLabel || null,
      referralSync,
    },
  };
}

async function settleInboundSuccess({
  tx,
  payload,
  sessOpts,
  session,
  targetCurrency,
  targetAmount,
  notifyCurrency,
}) {
  if (!targetCurrency) {
    throw createError(409, "Devise destination introuvable sur la transaction");
  }

  if (!Number.isFinite(targetAmount) || targetAmount <= 0) {
    throw createError(409, "Montant destination invalide");
  }

  if (!tx.beneficiaryCredited) {
    await creditReceiverFunds({
      transaction: tx,
      receiverId: tx.receiver,
      amount: targetAmount,
      currency: targetCurrency,
      session,
    });

    tx.beneficiaryCredited = true;
    tx.beneficiaryCreditedAt = new Date();
  }

  if (!tx.treasuryRevenueCredited) {
    const treasuryMeta = resolveFeesTreasuryMeta(tx);

    const creditResult = await creditTreasuryRevenue({
      transaction: tx,
      pricingSnapshot: tx.pricingSnapshot || {},
      treasurySystemType: treasuryMeta.treasurySystemType,
      treasuryLabel: treasuryMeta.treasuryLabel,
      session,
    });

    tx.treasuryRevenue = creditResult?.treasuryRevenue || null;
    tx.treasuryRevenueCredited = true;
    tx.treasuryRevenueCreditedAt = new Date();
    tx.treasuryUserId = treasuryMeta.treasuryUserId;
    tx.treasurySystemType = treasuryMeta.treasurySystemType;
    tx.treasuryLabel = treasuryMeta.treasuryLabel;
  }

  tx.status = "confirmed";
  tx.confirmedAt = new Date();
  tx.executedAt = new Date();
  tx.providerStatus = payload.status || payload.providerStatus || "SUCCESS";
  tx.settlement = {
    ...(tx.settlement || {}),
    settledAt: new Date(),
    providerResult: "SUCCESS",
    eventId: payload.eventId || null,
    eventType: payload.eventType || null,
  };

  await tx.save(sessOpts);
  await notifyParties(tx, "confirmed", session, notifyCurrency);

  // Mise en file AVANT le commit : l'evenement de parrainage est solidaire de
  // la confirmation. Motif « outbox transactionnel » : voir l'en-tete de
  // services/events/publisher.js, qui porte desormais cette garantie.
  const referralSync = await runReferralSync(tx, sessOpts);

  return {
    statusCode: 200,
    body: {
      success: true,
      transactionId: tx._id.toString(),
      flow: tx.flow,
      status: tx.status,
      providerStatus: tx.providerStatus,
      treasuryRevenue: tx.treasuryRevenue || null,
      treasuryRevenueCredited: !!tx.treasuryRevenueCredited,
      treasuryUserId: tx.treasuryUserId || null,
      treasurySystemType: tx.treasurySystemType || null,
      treasuryLabel: tx.treasuryLabel || null,
      referralSync,
    },
  };
}

async function settleFailureWebhook({
  tx,
  payload,
  sessOpts,
  session,
  sourceCurrency,
  grossSource,
  notifyCurrency,
}) {
  if (isOutboundExternalFlow(tx.flow)) {
    if (!sourceCurrency) {
      throw createError(409, "Devise source introuvable sur la transaction");
    }

    if (!Number.isFinite(grossSource) || grossSource <= 0) {
      throw createError(409, "Montant source invalide");
    }

    if (tx.fundsCaptured) {
      await refundSenderFunds({
        transaction: tx,
        senderId: tx.sender,
        amount: grossSource,
        currency: sourceCurrency,
        session,
      });

      tx.reversedAt = new Date();
    } else if (tx.fundsReserved && !tx.reserveReleased) {
      await releaseSenderReserve({
        transaction: tx,
        senderId: tx.sender,
        amount: grossSource,
        currency: sourceCurrency,
        session,
      });

      tx.reserveReleased = true;
      tx.reserveReleasedAt = new Date();
    }
  }

  tx.status = "failed";
  tx.providerStatus = payload.status || payload.providerStatus || "FAILED";
  tx.failure = {
    ...(tx.failure || {}),
    failedAt: new Date(),
    providerResult: "FAILED",
    eventId: payload.eventId || null,
    eventType: payload.eventType || null,
    reason:
      payload.reason ||
      payload.error ||
      payload.message ||
      "Provider failure",
  };

  await tx.save(sessOpts);
  await notifyParties(tx, "failed", session, notifyCurrency);
  return {
    statusCode: 200,
    body: {
      success: true,
      transactionId: tx._id.toString(),
      flow: tx.flow,
      status: tx.status,
      providerStatus: tx.providerStatus,
      eventId: payload.eventId || null,
    },
  };
}

/**
 * ============================================================================
 * LE MOTEUR DE RÈGLEMENT — F.4
 * ============================================================================
 *
 * ⚠️ CE QUI CHANGE : LE RÈGLEMENT NE DÉPEND PLUS D'UNE REQUÊTE HTTP.
 *
 * Toute la logique vivait dans `settleExternalTransactionWebhook(req, res,
 * next)` : elle lisait `req.body` et écrivait `res`. Conséquence, une seule et
 * lourde : **rien ne pouvait relancer un règlement, sauf le prestataire.**
 *
 * Or F.3 a montré que c'est insuffisant. Le registre des rappels retient
 * durablement des événements authentifiés dont le règlement ne s'est jamais
 * terminé — `PROVIDER_EVENT_UNSETTLED` (processus mort en plein règlement) et
 * `PROVIDER_EVENT_FAILED` (rejeux du prestataire taris). Nous avions la matière
 * et aucun moyen de nous en servir : il fallait attendre un rappel qui ne
 * viendrait plus.
 *
 * `settleExternalTransaction(payload)` est donc le moteur, et il rend
 * `{ statusCode, body }` au lieu d'écrire une réponse. Trois appelants :
 *   1. la route signée du prestataire (via l'adaptateur HTTP ci-dessous) ;
 *   2. la route interne héritée `POST /webhooks/:provider` ;
 *   3. le rejeu depuis le registre (`services/settlement/settlementReplay.js`).
 *
 * Les trois exécutent EXACTEMENT le même code. C'est le point : une seconde
 * implémentation du règlement serait une seconde façon de créditer un
 * bénéficiaire, donc un second risque de double crédit.
 *
 * L'idempotence ne change pas de nature — elle est déjà portée par
 * `hasWebhookEventBeenSeen`, les drapeaux monétaires de la transaction
 * (`fundsCaptured`, `beneficiaryCredited`…) et la transaction Mongo. Un rejeu
 * depuis le registre franchit les mêmes gardes qu'un rejeu du prestataire.
 *
 * @param {object} payload  Charge NORMALISÉE (sortie de `buildSettlementPayload`).
 * @returns {Promise<{statusCode: number, body: object}>}
 */
async function settleExternalTransaction(payload = {}) {
  const session = await startTxSession();

  try {
    /**
     * UNITÉ DE TRAVAIL UNIQUE.
     *
     * Le règlement validait auparavant depuis sept endroits — trois ici, quatre
     * dans les sous-fonctions. Une transaction validée en cours de route ne peut
     * pas être rejouée : le rejeu repartirait d'un état déjà figé, et une moitié
     * de règlement serait acquise sans l'autre.
     *
     * Tout le traitement tient désormais dans un seul `withTransaction`. Chaque
     * chemin RENVOIE `{statusCode, body}` ; la réponse HTTP s'écrit après, une
     * seule fois.
     *
     * Rejouabilité : lectures, écritures sur la transaction, et mise en file de
     * l'événement de parrainage dans l'Outbox — aucun appel réseau, aucun envoi
     * direct. Un rejeu refait la file dans une transaction annulée, donc sans
     * doublon.
     */
    const result = await runInTransaction(session, async (activeSession) => {
    const sessOpts = maybeSessionOpts(activeSession);
    const mapped = mapProviderState(payload);

    const tx = await findTransactionFromWebhook(
      payload,
      sessOpts.session || null
    );

    if (!tx) {
      throw createError(404, "Transaction webhook introuvable");
    }

    if (hasWebhookEventBeenSeen(tx, payload)) {
      return {
        statusCode: 200,
        body: {
          success: true,
          duplicate: true,
          ignored: true,
          transactionId: tx._id.toString(),
          status: tx.status,
          providerStatus: tx.providerStatus,
          eventId: payload.eventId || null,
        },
      };
    }

    appendWebhookHistory(tx, payload);

    const providerReference = normalizeProviderReference(payload);

    if (providerReference) {
      tx.providerReference = providerReference;
    }

    if (isFinalOrAutoCancelled(tx)) {
      await tx.save(sessOpts);
      return {
        statusCode: 200,
        body: {
          success: true,
          ignored: true,
          reason: tx.autoCancelledAt
            ? "TRANSACTION_ALREADY_AUTO_CANCELLED"
            : "TRANSACTION_ALREADY_FINAL",
          transactionId: tx._id.toString(),
          status: tx.status,
          providerStatus: tx.providerStatus,
          eventId: payload.eventId || null,
        },
      };
    }

    if (isExpiredBeforeSettlement(tx)) {
      tx.providerStatus = tx.providerStatus || "EXPIRED_PENDING_AUTO_CANCEL";
      tx.lastAutoCancelError = "Webhook reçu après expiration autoCancelAt";

      await tx.save(sessOpts);
      return {
        statusCode: 200,
        body: {
          success: true,
          ignored: true,
          reason: "TRANSACTION_EXPIRED_PENDING_AUTO_CANCEL",
          transactionId: tx._id.toString(),
          status: tx.status,
          providerStatus: tx.providerStatus,
          autoCancelAt: tx.autoCancelAt || null,
          eventId: payload.eventId || null,
        },
      };
    }

    const sourceCurrency = resolveSourceCurrency(tx);
    const targetCurrency = resolveTargetCurrency(tx);
    const notifyCurrency = sourceCurrency || targetCurrency || "XOF";
    const grossSource = resolveGrossSource(tx);
    const targetAmount = resolveTargetAmount(tx);

    /**
     * LA MACHINE À ÉTATS TRANCHE — AVANT TOUT MOUVEMENT D'ARGENT
     * ========================================================================
     *
     * Jusqu'au 2026-09-03, ce chemin — celui qui crédite un bénéficiaire sur
     * rappel prestataire — écrivait `tx.status` EN DIRECT à quatre endroits
     * (`settleProcessingWebhook`, `settleOutboundSuccess`, `settleInboundSuccess`,
     * `settleFailureWebhook`), sans jamais consulter `assertTransition`. C'est le
     * chemin le plus exposé du service : il est déclenché par un TIERS.
     *
     * `isFinalOrAutoCancelled` ci-dessus couvrait déjà les états FINAUX
     * (confirmed, cancelled, refunded, failed…) et l'auto-annulation. Restaient
     * ouverts les états que la machine refuse sans qu'ils soient finaux :
     * `created → processing`, `locked → confirmed`, `relaunch → confirmed`.
     * Un rappel prestataire sur une transaction VERROUILLÉE créditait le
     * bénéficiaire.
     *
     * ── Pourquoi ICI et pas dans les quatre fonctions ────────────────────────
     *
     * Parce qu'elles écrivent le statut APRÈS avoir déplacé l'argent : à
     * `settleOutboundSuccess`, le bénéficiaire et la trésorerie sont déjà
     * crédités quand `tx.status = "confirmed"` est atteint. Une vérification à
     * cet endroit refuserait le statut sans annuler le crédit — le pire des
     * deux. La barrière doit précéder le mouvement.
     *
     * ── Pourquoi 409 et pas une exception ────────────────────────────────────
     *
     * Un 4xx dit au prestataire « ne rejoue pas » : l'incohérence est chez nous,
     * pas dans son rappel. L'événement reste dans `provider_webhook_events`, et
     * la réconciliation prestataire le relèvera en `PROVIDER_SUCCESS_NOT_APPLIED`
     * — le client a payé, il n'a rien reçu — ce qui est exactement le signal
     * qu'on veut voir remonter plutôt qu'un crédit sur un état incohérent.
     */
    const statutVise =
      mapped === "PROCESSING" ? "processing" : mapped === "SUCCESS" ? "confirmed" : "failed";

    if (!canTransition(tx.status, statutVise)) {
      logger.error("[settlement] transition REFUSÉE par la machine à états", {
        transactionId: tx._id.toString(),
        reference: tx.reference,
        statutActuel: tx.status,
        statutVise,
        mapped,
        flow: tx.flow,
      });

      return {
        statusCode: 409,
        body: {
          success: false,
          reason: "INVALID_STATE_TRANSITION",
          message:
            `Règlement refusé : transition ${tx.status} -> ${statutVise} ` +
            "non autorisée par la machine à états. Aucun mouvement d'argent n'a eu lieu.",
          transactionId: tx._id.toString(),
        },
      };
    }

    let result;

    if (mapped === "PROCESSING") {
      result = await settleProcessingWebhook({
        tx,
        payload,
        sessOpts,
        session,
      });

      return result;
    }

    if (mapped === "SUCCESS") {
      if (isOutboundExternalFlow(tx.flow)) {
        result = await settleOutboundSuccess({
          tx,
          payload,
          sessOpts,
          session,
          sourceCurrency,
          grossSource,
          notifyCurrency,
        });

        return result;
      }

      if (isInboundExternalFlow(tx.flow)) {
        result = await settleInboundSuccess({
          tx,
          payload,
          sessOpts,
          session,
          targetCurrency,
          targetAmount,
          notifyCurrency,
        });

        return result;
      }

      throw createError(400, `Flow externe non supporté en SUCCESS: ${tx.flow}`);
    }

    result = await settleFailureWebhook({
      tx,
      payload,
      sessOpts,
      session,
      sourceCurrency,
      grossSource,
      notifyCurrency,
    });

      return result;
    });

    return result;
  } catch (err) {
    await abortAndEnd(session);
    throw err;
  } finally {
    try {
      session?.endSession?.();
    } catch {}
  }
}

/**
 * Adaptateur HTTP — et rien d'autre.
 *
 * Il ne contient AUCUNE règle de règlement, délibérément : toute logique
 * ajoutée ici échapperait au rejeu depuis le registre, et le rejeu produirait
 * alors un résultat différent du direct. C'est précisément le genre de
 * divergence qui ne se voit qu'en incident.
 */
async function settleExternalTransactionWebhook(req, res, next) {
  try {
    const result = await settleExternalTransaction(req.body || {});

    // Réponse écrite APRÈS la transaction, une seule fois.
    return res.status(result.statusCode).json(result.body);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  settleExternalTransaction,
  settleExternalTransactionWebhook,
};