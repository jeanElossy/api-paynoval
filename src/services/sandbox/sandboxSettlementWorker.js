"use strict";

/**
 * ============================================================================
 * WORKER DE SIMULATION — LIVRE LES RAPPELS PRESTATAIRE FICTIFS
 * ============================================================================
 *
 * Il prend les ordres simulés échus (`SandboxProviderEvent`) et livre leur
 * rappel au MÊME moteur de règlement que les vrais prestataires :
 * `settleExternalTransaction`. Rien n'est réimplémenté — capture, crédit du
 * bénéficiaire, frais, remboursement sur échec, machine à états et
 * notifications sont ceux de la production. C'est ce qui fait de la
 * simulation une vraie transaction de bout en bout.
 *
 * ── Ce qui distingue ce rappel d'un vrai ────────────────────────────────────
 * `sourceMode: "sandbox"`. Le moteur refuse de régler une transaction live
 * avec un rappel sandbox, et une transaction sandbox avec un rappel venu de
 * l'extérieur (`externalSettlementController`). Un rappel sandbox ne peut
 * naître qu'ici : il n'existe AUCUNE route HTTP qui en accepte.
 *
 * ── Idempotence ─────────────────────────────────────────────────────────────
 * `eventId` est dérivé de l'événement (`sbx_<id>`) : une double livraison
 * (verrou expiré pendant un règlement lent) est reconnue par
 * `hasWebhookEventBeenSeen` et ne règle rien deux fois.
 */

const os = require("os");
const crypto = require("crypto");

const logger = require("../../logger");
const { isSandboxEnabled } = require("../../utils/accountMode");
const events = require("./sandboxProviderEvents");

const DEFAULT_POLL_MS = 2000;
const BATCH_LIMIT = 20;

function buildWorkerId() {
  return `sandbox-settlement:${os.hostname()}:${process.pid}:${crypto
    .randomBytes(3)
    .toString("hex")}`;
}

/** Charge de règlement d'un événement simulé. Fonction pure. */
function buildSandboxSettlementPayload(event) {
  const status = event.settle === "success" ? "completed" : "failed";

  return {
    sourceMode: "sandbox",
    transactionId: String(event.transactionId),
    reference: event.reference || null,
    providerReference: event.providerReference,
    provider: event.provider,
    rail: event.rail,
    eventId: `sbx_${String(event._id)}`,
    eventType: "sandbox.settlement",
    status,
    providerStatus: status,
    reason: event.failureCode || null,
    message: event.failureMessage || null,
    verified: true,
  };
}

function defaultSettle(payload) {
  // Paresseux : le contrôleur résout ses modèles au chargement.
  const { settleExternalTransaction } = require("../../controllers/externalSettlementController");
  return settleExternalTransaction(payload);
}

/**
 * Livre UN événement déjà pris. Un refus métier du moteur (409 transition
 * refusée, 404) n'est pas réessayé : rejouer ne changerait pas sa réponse. Il
 * est clos avec sa raison, et journalisé.
 */
async function deliverEvent(event, workerId, { settle = defaultSettle } = {}) {
  const payload = buildSandboxSettlementPayload(event);

  try {
    const result = await settle(payload);
    const code = Number(result?.statusCode || 200);

    if (code >= 200 && code < 300) {
      await events.markDelivered(event, workerId);
      return { delivered: true, statusCode: code };
    }

    logger.warn?.("[sandbox] rappel simulé refusé par le moteur", {
      eventId: payload.eventId,
      transactionId: payload.transactionId,
      statusCode: code,
      reason: result?.body?.reason || null,
    });

    await events.markDelivered(event, workerId, {
      note: `refusé par le moteur (${code}) : ${result?.body?.reason || "?"}`,
    });

    return { delivered: false, statusCode: code };
  } catch (err) {
    logger.error?.("[sandbox] livraison du rappel simulé en échec", {
      eventId: payload.eventId,
      transactionId: payload.transactionId,
      attempt: event.attempts,
      message: err?.message || String(err),
      consequence:
        Number(event.attempts || 0) >= events.MAX_ATTEMPTS
          ? "abandon : la transaction de simulation reste en cours"
          : "nouvel essai planifié",
    });

    await events.markRetry(event, workerId, err);
    return { delivered: false, error: err };
  }
}

async function runOnce({ workerId = buildWorkerId(), limit = BATCH_LIMIT, deps = {} } = {}) {
  let processed = 0;

  for (let i = 0; i < limit; i += 1) {
    const event = await events.claimNextDueEvent({ workerId });
    if (!event) break;

    await deliverEvent(event, workerId, deps);
    processed += 1;
  }

  return { workerId, processed };
}

/**
 * Démarre la boucle si — et seulement si — la simulation est ouverte. Le
 * démarrage DIT ce qu'il fait et ce que cela implique (règle B.6).
 */
function startSandboxSettlementWorker({
  intervalMs = Number(process.env.SANDBOX_SETTLEMENT_POLL_MS || DEFAULT_POLL_MS),
} = {}) {
  if (!isSandboxEnabled()) {
    logger.info?.(
      "[sandbox] simulation FERMÉE (SANDBOX_MODE_ENABLED absente) : aucun compte " +
        "sandbox n'est servi et aucun rappel simulé n'est livré."
    );
    return { stop() {}, started: false };
  }

  const workerId = buildWorkerId();
  const period = Number.isFinite(intervalMs) && intervalMs >= 500 ? intervalMs : DEFAULT_POLL_MS;
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;

    try {
      await runOnce({ workerId });
    } catch (err) {
      logger.error?.("[sandbox] passage du worker de simulation en échec", {
        message: err?.message || String(err),
        consequence: "les rappels simulés échus seront repris au passage suivant",
      });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, period);
  if (typeof timer.unref === "function") timer.unref();

  logger.info?.(
    `[sandbox] simulation OUVERTE : comptes sandbox servis, rappels simulés livrés ` +
      `toutes les ${period} ms par ${workerId}. Aucun prestataire réel n'est appelé pour ces comptes.`
  );

  return {
    started: true,
    workerId,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

module.exports = {
  buildSandboxSettlementPayload,
  deliverEvent,
  runOnce,
  startSandboxSettlementWorker,
};
