"use strict";

/**
 * ============================================================================
 * OUTBOX TRANSACTIONNEL DU PARRAINAGE
 * ============================================================================
 *
 * LE PROBLÈME QU'IL RÉSOUT
 * ------------------------
 * Avant : la confirmation d'une transaction appelait le backend principal en
 * HTTP, en ligne, juste après le commit. Sans file, sans reprise. Si le
 * principal était indisponible une seconde, si le processus était tué par un
 * redéploiement, si le réseau hoquetait — l'événement était perdu DÉFINITIVEMENT.
 * Le filleul ne touchait son bonus que si, par chance, il refaisait plus tard
 * une transaction qualifiante. Un filleul qui cesse d'utiliser l'app après avoir
 * rempli les conditions ne le touchait jamais.
 *
 * LA GARANTIE APPORTÉE
 * --------------------
 * L'événement est écrit dans la MÊME transaction Mongo que la confirmation de
 * la transaction financière. Il en résulte une équivalence stricte :
 *
 *     la transaction est confirmée  ⟺  l'événement existe
 *
 * Impossible d'avoir l'un sans l'autre. Le commit les rend visibles ensemble ;
 * un abandon les efface ensemble. C'est le motif « transactional outbox », celui
 * qu'emploient Stripe pour ses events et PayPal pour ses webhooks.
 *
 * La livraison est ensuite garantie AU MOINS UNE FOIS — jamais exactement une.
 * C'est assumé : l'exactitude n'est pas la responsabilité du transport, elle est
 * celle du registre d'idempotence (`ReferralPayout`). Un transport qui
 * garantirait « exactement une fois » n'existe pas ; un consommateur idempotent,
 * si.
 */

const crypto = require("crypto");
const os = require("os");

let logger = console;
try {
  logger = require("../../logger");
} catch {}

const { getTxConn } = require("../../config/db");
const OutboxModel = require("../../models/Outbox");
const { computeBackoffMs } = require("./referralKeys");

const SERVICE = "referral";
const EVENT_ACTIVITY_CONFIRMED = "referral.activity.confirmed";

/** Durée de vie d'un verrou de traitement. Au-delà, l'item est repris. */
const LOCK_TTL_MS = Number(process.env.REFERRAL_OUTBOX_LOCK_TTL_MS || 120_000);

/** Base du délai de réessai. Croissance exponentielle, plafonnée. */
const RETRY_BASE_MS = Number(process.env.REFERRAL_OUTBOX_RETRY_BASE_MS || 15_000);
const RETRY_MAX_MS = Number(process.env.REFERRAL_OUTBOX_RETRY_MAX_MS || 3_600_000);

/**
 * Nombre de tentatives avant abandon.
 *
 * 10 tentatives à backoff exponentiel plafonné à une heure couvrent environ une
 * demi-journée d'indisponibilité du backend principal. Au-delà, insister
 * n'apporte plus rien : c'est le job de réconciliation qui rattrapera, et un
 * humain doit être au courant.
 */
const MAX_ATTEMPTS = Number(process.env.REFERRAL_OUTBOX_MAX_ATTEMPTS || 10);

function getOutbox() {
  return OutboxModel(getTxConn());
}

function buildWorkerId() {
  return `${os.hostname()}#${process.pid}#${crypto
    .randomBytes(4)
    .toString("hex")}`;
}

/**
 * Identifiant de corrélation du parcours (§22).
 *
 * Un seul identifiant relie la transaction qualifiante, l'évaluation
 * d'éligibilité, le versement, le grand livre et les notifications. C'est ce qui
 * permet au support de répondre à « qu'est-il arrivé à ce bonus ? » sans
 * toucher à une donnée financière.
 */
function buildCorrelationId() {
  return `REF-BONUS-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

/**
 * Met en file l'événement d'activité qualifiante.
 *
 * ⚠️ DOIT être appelé AVANT le commit, avec les options de session du handler
 * appelant — les MÊMES que celles employées pour écrire la transaction
 * elle-même (`maybeSessionOpts(session)`).
 *
 * MODE DÉGRADÉ ASSUMÉ. Lorsque la base Users et la base Transactions vivent sur
 * deux clusters distincts, `canUseSharedSession()` est faux et le handler
 * n'ouvre aucune transaction : ses écritures, y compris le mouvement financier,
 * ne sont déjà pas atomiques entre elles. Refuser d'écrire l'événement dans
 * cette configuration reviendrait à protéger l'accessoire mieux que le
 * principal. On écrit donc dans le même régime que l'appelant : exact quand une
 * transaction existe, durable et rejouable dans tous les cas — ce qui reste très
 * supérieur à l'appel HTTP en ligne qu'on remplace.
 *
 * @param {object} params
 * @param {object} params.transaction  transaction confirmée
 * @param {object} [params.sessionOpts] `{session}` ou `{}` — le régime de
 *   l'appelant, jamais un choix propre à cette fonction
 */
async function enqueueReferralActivityEvent({ transaction, sessionOpts = {} }) {
  const tx = transaction || {};
  const txId = String(tx?._id || tx?.id || "").trim();
  const actorUserId = String(tx?.userId || tx?.sender || "").trim();

  if (!txId || !actorUserId) {
    logger.warn?.("[REFERRAL][OUTBOX] evenement ignore : identifiants manquants", {
      txId,
      hasActor: !!actorUserId,
    });
    return { enqueued: false, reason: "MISSING_IDENTIFIERS" };
  }

  const Outbox = getOutbox();
  const correlationId = buildCorrelationId();

  const doc = {
    service: SERVICE,
    event: EVENT_ACTIVITY_CONFIRMED,
    aggregateType: "transaction",
    aggregateId: txId,
    status: "pending",
    attempts: 0,
    maxAttempts: MAX_ATTEMPTS,
    availableAt: new Date(),
    payload: {
      refereeId: actorUserId,
      triggerTxId: txId,
      reference: String(tx?.reference || ""),
      flow: String(tx?.flow || ""),
      confirmedAt: tx?.confirmedAt || new Date(),
      correlationId,
    },
    /**
     * Une transaction ne peut produire qu'un seul événement de parrainage.
     * L'index unique de l'Outbox le garantit même si la transaction Mongo est
     * rejouée après un conflit d'écriture.
     */
    idempotencyKey: `referral:activity:${txId}`,
  };

  try {
    await Outbox.create([doc], sessionOpts || {});

    logger.info?.("[REFERRAL][OUTBOX] evenement mis en file", {
      txId,
      correlationId,
      transactional: !!sessionOpts?.session,
    });

    return { enqueued: true, correlationId };
  } catch (err) {
    if (err?.code === 11000) {
      // Déjà en file : c'est le comportement voulu, pas un incident.
      return { enqueued: false, reason: "ALREADY_QUEUED" };
    }

    throw err;
  }
}

/**
 * Réclame un lot d'événements à traiter.
 *
 * Réclamation atomique document par document : `findOneAndUpdate` avec filtre
 * sur le statut, de sorte que deux workers concurrents ne puissent jamais
 * obtenir le même item. Le verrou porte une date d'expiration pour qu'un
 * worker tué ne bloque pas définitivement ce qu'il tenait.
 */
async function claimBatch({ workerId, limit = 50 }) {
  const Outbox = getOutbox();
  const now = new Date();
  const claimed = [];

  for (let i = 0; i < limit; i++) {
    const item = await Outbox.findOneAndUpdate(
      {
        service: SERVICE,
        status: { $in: ["pending", "retry"] },
        availableAt: { $lte: now },
      },
      {
        $set: {
          status: "processing",
          lockedAt: now,
          lockedBy: String(workerId),
        },
        $inc: { attempts: 1 },
      },
      { new: true, sort: { availableAt: 1, createdAt: 1 } }
    ).lean();

    if (!item) break;
    claimed.push(item);
  }

  return claimed;
}

/**
 * Remet en file les items dont le verrou a expiré.
 *
 * Sans ce ramassage, chaque redéploiement perdrait définitivement ce qui était
 * en vol au moment du SIGTERM : les items resteraient `processing` pour
 * toujours, et personne ne s'en apercevrait.
 */
async function reapExpiredLocks() {
  const Outbox = getOutbox();
  const threshold = new Date(Date.now() - LOCK_TTL_MS);

  const res = await Outbox.updateMany(
    {
      service: SERVICE,
      status: "processing",
      lockedAt: { $lte: threshold },
    },
    {
      $set: {
        status: "retry",
        availableAt: new Date(),
        lockedAt: null,
        lockedBy: "",
        lastError: "LOCK_EXPIRED",
      },
    }
  );

  const reclaimed = res?.modifiedCount || 0;

  if (reclaimed) {
    logger.warn?.("[REFERRAL][OUTBOX] verrous expires recuperes", { reclaimed });
  }

  return reclaimed;
}

async function settleSuccess(itemId) {
  const Outbox = getOutbox();

  await Outbox.updateOne(
    { _id: itemId },
    {
      $set: {
        status: "processed",
        processedAt: new Date(),
        lockedAt: null,
        lockedBy: "",
        lastError: "",
      },
    }
  );
}

async function settleFailure(item, error) {
  const Outbox = getOutbox();
  const attempts = Number(item?.attempts || 0);
  const maxAttempts = Number(item?.maxAttempts || MAX_ATTEMPTS);
  const message = String(error?.message || error || "UNKNOWN").slice(0, 4000);

  if (attempts >= maxAttempts) {
    await Outbox.updateOne(
      { _id: item._id },
      {
        $set: {
          status: "failed",
          lockedAt: null,
          lockedBy: "",
          lastError: message,
        },
      }
    );

    /**
     * Un abandon définitif doit être bruyant : il signifie qu'un bonus
     * potentiellement dû n'a pas été traité. La réconciliation le rattrapera,
     * mais quelqu'un doit savoir que le transport a renoncé.
     */
    logger.error?.("[REFERRAL][OUTBOX] abandon apres tentatives epuisees", {
      outboxId: String(item._id),
      aggregateId: item.aggregateId,
      correlationId: item?.payload?.correlationId || "",
      attempts,
      lastError: message,
    });

    return "failed";
  }

  const delay = computeBackoffMs(attempts, {
    baseMs: RETRY_BASE_MS,
    maxMs: RETRY_MAX_MS,
  });

  await Outbox.updateOne(
    { _id: item._id },
    {
      $set: {
        status: "retry",
        availableAt: new Date(Date.now() + delay),
        lockedAt: null,
        lockedBy: "",
        lastError: message,
      },
    }
  );

  return "retry";
}

module.exports = {
  SERVICE,
  EVENT_ACTIVITY_CONFIRMED,
  MAX_ATTEMPTS,
  buildWorkerId,
  buildCorrelationId,
  enqueueReferralActivityEvent,
  claimBatch,
  reapExpiredLocks,
  computeBackoffMs,
  settleSuccess,
  settleFailure,
};
