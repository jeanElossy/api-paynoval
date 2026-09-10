// "use strict";

// const createError = require("http-errors");
// const logger = require("../logger");

// const { getProviderAdapter } = require("../providers/providerSelector");
// const {
//   settleExternalTransactionWebhook,
// } = require("./externalSettlementController");

// function norm(v) {
//   return String(v || "").trim().toLowerCase();
// }

// function cleanValue(v) {
//   if (Array.isArray(v)) return v[0] ?? "";
//   return v;
// }

// function pickProvider(req) {
//   return norm(
//     cleanValue(req.params?.provider) ||
//       cleanValue(req.query?.provider) ||
//       cleanValue(req.headers?.["x-provider"]) ||
//       cleanValue(req.body?.provider) ||
//       cleanValue(req.body?.metadata?.provider) ||
//       ""
//   );
// }

// function pickRail(req) {
//   return norm(
//     cleanValue(req.params?.rail) ||
//       cleanValue(req.query?.rail) ||
//       cleanValue(req.headers?.["x-rail"]) ||
//       cleanValue(req.body?.rail) ||
//       cleanValue(req.body?.metadata?.rail) ||
//       ""
//   );
// }

// function inferRailFromProvider(provider) {
//   const p = norm(provider);

//   if (["wave", "orange", "mtn", "moov", "flutterwave"].includes(p)) {
//     return "mobilemoney";
//   }

//   if (["stripe", "visa_direct", "visadirect", "visa-direct"].includes(p)) {
//     return "card";
//   }

//   if (
//     ["bank", "bank_generic", "bankgeneric", "bank-transfer", "bank_transfer"].includes(p)
//   ) {
//     return "bank";
//   }

//   return "";
// }

// function canonicalProviderStatus(status) {
//   const s = norm(status);

//   if (
//     [
//       "success",
//       "successful",
//       "completed",
//       "confirmed",
//       "paid",
//       "settled",
//       "captured",
//       "succeeded",
//       "approved",
//       "ok",
//     ].includes(s)
//   ) {
//     return "SUCCESS";
//   }

//   if (
//     [
//       "failed",
//       "failure",
//       "error",
//       "cancelled",
//       "canceled",
//       "expired",
//       "rejected",
//       "reversed",
//       "declined",
//       "voided",
//     ].includes(s)
//   ) {
//     return "FAILED";
//   }

//   return "PROCESSING";
// }

// function pickTransactionId(parsed, raw) {
//   return (
//     parsed?.transactionId ||
//     raw?.transactionId ||
//     raw?.txCoreTransactionId ||
//     raw?.metadata?.txCoreTransactionId ||
//     null
//   );
// }

// function pickReference(parsed, raw) {
//   return (
//     parsed?.txReference ||
//     raw?.reference ||
//     raw?.txReference ||
//     raw?.merchantReference ||
//     raw?.clientReference ||
//     raw?.metadata?.txReference ||
//     raw?.metadata?.txCoreReference ||
//     null
//   );
// }

// function pickProviderReference(parsed, raw) {
//   return (
//     parsed?.providerReference ||
//     raw?.providerReference ||
//     raw?.externalReference ||
//     raw?.provider_ref ||
//     raw?.reference ||
//     null
//   );
// }

// function pickEventId(parsed, raw) {
//   return (
//     parsed?.eventId ||
//     raw?.eventId ||
//     raw?.event_id ||
//     raw?.id ||
//     raw?.webhookId ||
//     null
//   );
// }

// function pickEventType(parsed, raw) {
//   return (
//     parsed?.eventType ||
//     raw?.eventType ||
//     raw?.type ||
//     raw?.event ||
//     null
//   );
// }

// function buildSettlementPayload(parsed, req, rail, provider) {
//   const raw = parsed?.raw && typeof parsed.raw === "object" ? parsed.raw : req.body || {};

//   const normalizedStatus = canonicalProviderStatus(
//     parsed?.externalStatus ||
//       parsed?.status ||
//       raw?.status ||
//       raw?.providerStatus ||
//       raw?.event ||
//       raw?.state
//   );

//   return {
//     transactionId: pickTransactionId(parsed, raw),
//     reference: pickReference(parsed, raw),
//     providerReference: pickProviderReference(parsed, raw),

//     provider:
//       provider ||
//       parsed?.provider ||
//       raw?.provider ||
//       raw?.metadata?.provider ||
//       null,

//     rail:
//       rail ||
//       raw?.rail ||
//       raw?.metadata?.rail ||
//       null,

//     eventId: pickEventId(parsed, raw),
//     eventType: pickEventType(parsed, raw),

//     providerStatus: normalizedStatus,
//     status: normalizedStatus,

//     amount:
//       parsed?.amount ??
//       raw?.amount ??
//       raw?.value ??
//       null,

//     currency:
//       parsed?.currency ||
//       raw?.currency ||
//       null,

//     reason:
//       raw?.reason ||
//       raw?.error ||
//       raw?.message ||
//       parsed?.verificationReason ||
//       null,

//     verified: Boolean(parsed?.verified),
//     verificationReason: parsed?.verificationReason || null,

//     raw,
//   };
// }

// async function providerWebhookController(req, res, next) {
//   try {
//     const provider = pickProvider(req);
//     if (!provider) {
//       throw createError(400, "Provider webhook manquant");
//     }

//     const rail = pickRail(req) || inferRailFromProvider(provider);
//     if (!rail) {
//       throw createError(400, `Rail introuvable pour provider ${provider}`);
//     }

//     let adapter;
//     try {
//       adapter = getProviderAdapter({ rail, provider });
//     } catch (_err) {
//       throw createError(
//         400,
//         `Adapter webhook introuvable pour rail=${rail} provider=${provider}`
//       );
//     }

//     if (!adapter || typeof adapter.parseWebhook !== "function") {
//       throw createError(
//         400,
//         `Adapter webhook introuvable pour rail=${rail} provider=${provider}`
//       );
//     }

//     const parsed = await adapter.parseWebhook(req);

//     if (!parsed || typeof parsed !== "object") {
//       throw createError(400, "Webhook provider invalide ou vide");
//     }

//     if (parsed.verified === false) {
//       logger.warn("[providerWebhook] signature invalide", {
//         provider,
//         rail,
//         reason: parsed?.verificationReason || "BAD_SIGNATURE",
//         ip: req.ip,
//         path: req.originalUrl,
//       });

//       throw createError(401, `Signature webhook invalide (${provider})`);
//     }

//     const settlementPayload = buildSettlementPayload(parsed, req, rail, provider);

//     logger.info("[providerWebhook] webhook normalisé", {
//       provider,
//       rail,
//       eventId: settlementPayload.eventId,
//       reference: settlementPayload.reference,
//       providerReference: settlementPayload.providerReference,
//       providerStatus: settlementPayload.providerStatus,
//       verified: settlementPayload.verified,
//     });

//     req.body = settlementPayload;

//     return settleExternalTransactionWebhook(req, res, next);
//   } catch (err) {
//     return next(err);
//   }
// }

// module.exports = {
//   providerWebhookController,
// };






// File: src/controllers/providerWebhookController.js
"use strict";

const createError = require("http-errors");
const logger = require("../logger");

const { getProviderAdapter } = require("../providers/providerSelector");
const {
  settleExternalTransaction,
} = require("./externalSettlementController");

function norm(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanValue(value) {
  if (Array.isArray(value)) return value[0] ?? "";
  return value;
}

function pickNested(obj, paths = []) {
  for (const path of paths) {
    const parts = String(path || "").split(".").filter(Boolean);
    let cursor = obj;

    for (const part of parts) {
      if (!cursor || typeof cursor !== "object") {
        cursor = undefined;
        break;
      }

      cursor = cursor[part];
    }

    if (cursor !== undefined && cursor !== null && String(cursor).trim()) {
      return cursor;
    }
  }

  return null;
}

function pickProvider(req) {
  return norm(
    cleanValue(req.params?.provider) ||
      cleanValue(req.query?.provider) ||
      cleanValue(req.headers?.["x-provider"]) ||
      cleanValue(req.body?.provider) ||
      cleanValue(req.body?.metadata?.provider) ||
      cleanValue(req.body?.data?.provider) ||
      ""
  );
}

function pickRail(req) {
  return norm(
    cleanValue(req.params?.rail) ||
      cleanValue(req.query?.rail) ||
      cleanValue(req.headers?.["x-rail"]) ||
      cleanValue(req.body?.rail) ||
      cleanValue(req.body?.metadata?.rail) ||
      cleanValue(req.body?.data?.rail) ||
      ""
  );
}

function inferRailFromProvider(provider) {
  const p = norm(provider);

  if (["wave", "orange", "mtn", "moov", "flutterwave"].includes(p)) {
    return "mobilemoney";
  }

  if (["stripe", "visa_direct", "visadirect", "visa-direct"].includes(p)) {
    return "card";
  }

  /* Les cinq alias bancaires ont été retirés le 2026-09-10. Un rappel
     prestataire annonçant un rail bancaire ne peut plus être classé : il tombe
     en chaîne vide, donc refusé. C'est voulu — PayNoval n'a plus de rail
     bancaire, donc aucun prestataire bancaire n'a de raison de nous rappeler. */

  return "";
}

function canonicalProviderStatus(status) {
  const s = norm(status);

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
    ].includes(s)
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
    ].includes(s)
  ) {
    return "FAILED";
  }

  return "PROCESSING";
}

function pickTransactionId(parsed, raw) {
  return (
    parsed?.transactionId ||
    parsed?.txCoreTransactionId ||
    parsed?.metadata?.txCoreTransactionId ||
    parsed?.data?.transactionId ||
    parsed?.data?.txCoreTransactionId ||
    raw?.transactionId ||
    raw?.txCoreTransactionId ||
    raw?.metadata?.txCoreTransactionId ||
    raw?.data?.transactionId ||
    raw?.data?.txCoreTransactionId ||
    null
  );
}

function pickReference(parsed, raw) {
  return (
    parsed?.txReference ||
    parsed?.reference ||
    parsed?.merchantReference ||
    parsed?.clientReference ||
    parsed?.metadata?.txReference ||
    parsed?.metadata?.txCoreReference ||
    parsed?.data?.reference ||
    parsed?.data?.txReference ||
    raw?.reference ||
    raw?.txReference ||
    raw?.merchantReference ||
    raw?.clientReference ||
    raw?.metadata?.txReference ||
    raw?.metadata?.txCoreReference ||
    raw?.data?.reference ||
    raw?.data?.txReference ||
    null
  );
}

function pickProviderReference(parsed, raw) {
  return (
    parsed?.providerReference ||
    parsed?.externalReference ||
    parsed?.provider_ref ||
    parsed?.providerRef ||
    parsed?.data?.providerReference ||
    parsed?.data?.externalReference ||
    raw?.providerReference ||
    raw?.externalReference ||
    raw?.provider_ref ||
    raw?.providerRef ||
    raw?.data?.providerReference ||
    raw?.data?.externalReference ||
    raw?.reference ||
    null
  );
}

function pickEventId(parsed, raw) {
  return (
    parsed?.eventId ||
    parsed?.event_id ||
    parsed?.webhookId ||
    parsed?.id ||
    parsed?.data?.eventId ||
    parsed?.data?.id ||
    raw?.eventId ||
    raw?.event_id ||
    raw?.id ||
    raw?.webhookId ||
    raw?.data?.eventId ||
    raw?.data?.id ||
    null
  );
}

function pickEventType(parsed, raw) {
  return (
    parsed?.eventType ||
    parsed?.event_type ||
    parsed?.type ||
    parsed?.event ||
    parsed?.data?.eventType ||
    parsed?.data?.type ||
    raw?.eventType ||
    raw?.event_type ||
    raw?.type ||
    raw?.event ||
    raw?.data?.eventType ||
    raw?.data?.type ||
    null
  );
}

function buildSettlementPayload(parsed, req, rail, provider) {
  const raw =
    parsed?.raw && typeof parsed.raw === "object" ? parsed.raw : req.body || {};

  const rawStatus =
    parsed?.externalStatus ||
    parsed?.status ||
    parsed?.providerStatus ||
    parsed?.event ||
    parsed?.state ||
    parsed?.data?.status ||
    parsed?.data?.state ||
    raw?.status ||
    raw?.providerStatus ||
    raw?.event ||
    raw?.state ||
    raw?.data?.status ||
    raw?.data?.state ||
    pickNested(raw, ["payment.status", "transaction.status"]);

  const normalizedStatus = canonicalProviderStatus(rawStatus);

  return {
    transactionId: pickTransactionId(parsed, raw),
    reference: pickReference(parsed, raw),
    providerReference: pickProviderReference(parsed, raw),

    provider:
      provider ||
      parsed?.provider ||
      parsed?.metadata?.provider ||
      parsed?.data?.provider ||
      raw?.provider ||
      raw?.metadata?.provider ||
      raw?.data?.provider ||
      null,

    rail:
      rail ||
      parsed?.rail ||
      parsed?.metadata?.rail ||
      parsed?.data?.rail ||
      raw?.rail ||
      raw?.metadata?.rail ||
      raw?.data?.rail ||
      null,

    eventId: pickEventId(parsed, raw),
    eventType: pickEventType(parsed, raw),

    providerStatus: normalizedStatus,
    status: normalizedStatus,

    amount:
      parsed?.amount ??
      parsed?.value ??
      parsed?.data?.amount ??
      raw?.amount ??
      raw?.value ??
      raw?.data?.amount ??
      null,

    currency:
      parsed?.currency ||
      parsed?.data?.currency ||
      raw?.currency ||
      raw?.data?.currency ||
      null,

    reason:
      parsed?.reason ||
      parsed?.error ||
      parsed?.message ||
      raw?.reason ||
      raw?.error ||
      raw?.message ||
      raw?.data?.reason ||
      raw?.data?.error ||
      raw?.data?.message ||
      parsed?.verificationReason ||
      null,

    // Idem : `true` explicite exigé, pas « tout sauf false ».
    verified: parsed?.verified === true,
    verificationReason: parsed?.verificationReason || null,

    raw,
  };
}

function assertSettlementHasIdentifier(payload = {}) {
  if (payload.transactionId || payload.reference || payload.providerReference) {
    return;
  }

  throw createError(
    400,
    "Webhook provider sans identifiant transaction exploitable"
  );
}

const {
  claimEvent,
  markProcessed,
  markFailed,
} = require("../services/webhooks/webhookEventStore");

const { getTransactionsConnection } = require("../config/db");
const {
  confirmCollection,
  markCollectionSettled,
} = require("../services/collections/collectionService");
const {
  notifyCagnotteParticipation,
} = require("../services/collections/collectionNotifier");

/**
 * ============================================================================
 * UN RAPPEL D'ENCAISSEMENT N'EST PAS UN RAPPEL DE VIREMENT
 * ============================================================================
 *
 * `settleExternalTransaction` cherche une `Transaction` — un mouvement SORTANT,
 * initié par un titulaire de compte PayNoval. Un encaissement entrant n'en a
 * aucune : le payeur n'a pas de compte, il n'y a rien à débiter, aucune machine
 * à états de transfert à traverser.
 *
 * Sans cette branche, le rappel confirmant un encaissement tombait sur
 * « transaction introuvable », rendait une erreur, et le prestataire
 * réémettait indéfiniment — l'argent encaissé chez lui, jamais crédité chez
 * nous, et rien dans les journaux pour dire que c'était le mauvais aiguillage.
 *
 * ⚠️ La branche est prise sur l'EXISTENCE d'une intention d'encaissement
 * portant cette référence, pas sur un champ que le prestataire renseignerait.
 * Un aiguillage confié à la charge utile d'un tiers est un aiguillage qu'un
 * tiers contrôle.
 *
 * Rend `null` quand ce n'est pas un encaissement : l'appelant poursuit alors
 * son chemin habituel.
 */
async function traiterCommeEncaissement(charge) {
  const conn = await getTransactionsConnection();

  const confirmation = await confirmCollection(conn, {
    reference: charge.reference,
    providerReference: charge.providerReference,
    providerStatus: charge.providerStatus,
  });

  if (!confirmation) return null;

  const { intent, outcome } = confirmation;

  if (outcome === "pending") {
    /**
     * Un statut intermédiaire est un accusé, pas une confirmation. On rend 200
     * pour que le prestataire cesse de réémettre CET événement-là — le suivant
     * portera le statut définitif.
     */
    return {
      statusCode: 200,
      body: { success: true, collection: intent.reference, status: "pending" },
    };
  }

  if (outcome === "failed") {
    return {
      statusCode: 200,
      body: { success: true, collection: intent.reference, status: "failed" },
    };
  }

  if (outcome === "replay") {
    return {
      statusCode: 200,
      body: { success: true, replayed: true, collection: intent.reference },
    };
  }

  /* outcome === "succeeded" — l'argent est chez le prestataire. */

  if (intent.purpose !== "cagnotte_participation") {
    /**
     * Table CLOSE. Un motif inconnu ne se devine pas : on ne saurait pas QUI
     * prévenir, et l'encaissement resterait confirmé sans destinataire. Mieux
     * vaut une erreur bruyante qu'un encaissement orphelin silencieux.
     */
    throw createError(
      500,
      `Encaissement confirmé de motif inconnu : ${intent.purpose}`
    );
  }

  const annonce = await notifyCagnotteParticipation(intent);

  await markCollectionSettled(conn, intent.reference, annonce.reference || "");

  return {
    statusCode: 200,
    body: {
      success: true,
      collection: intent.reference,
      status: "succeeded",
      alreadyProcessed: annonce.alreadyProcessed,
    },
  };
}

async function providerWebhookController(req, res, next) {
  try {
    const provider = pickProvider(req);

    if (!provider) {
      throw createError(400, "Provider webhook manquant");
    }

    const rail = pickRail(req) || inferRailFromProvider(provider);

    if (!rail) {
      throw createError(400, `Rail introuvable pour provider ${provider}`);
    }

    let adapter;

    try {
      adapter = getProviderAdapter({ rail, provider });
    } catch (_err) {
      throw createError(
        400,
        `Adapter webhook introuvable pour rail=${rail} provider=${provider}`
      );
    }

    if (!adapter || typeof adapter.parseWebhook !== "function") {
      throw createError(
        400,
        `Adapter webhook introuvable pour rail=${rail} provider=${provider}`
      );
    }

    const parsed = await adapter.parseWebhook(req);

    if (!parsed || typeof parsed !== "object") {
      throw createError(400, "Webhook provider invalide ou vide");
    }

    /**
     * REFUS PAR DÉFAUT. L'ancien test `parsed.verified === false` laissait
     * passer `undefined` : un adaptateur qui oublie le champ, ou qui sort par un
     * chemin d'erreur avant de le renseigner, rendait le webhook authentique.
     * On exige désormais un `true` explicite — c'est la posture de Stripe et de
     * PayPal : une signature qu'on n'a pas vérifiée n'est pas une signature
     * valide, c'est une signature absente.
     */
    if (parsed.verified !== true) {
      logger.warn("[providerWebhook] signature non vérifiée", {
        provider,
        rail,
        reason: parsed?.verificationReason || "BAD_SIGNATURE",
        ip: req.ip,
        path: req.originalUrl,
      });

      throw createError(401, `Signature webhook invalide (${provider})`);
    }

    const settlementPayload = buildSettlementPayload(parsed, req, rail, provider);

    assertSettlementHasIdentifier(settlementPayload);

    logger.info("[providerWebhook] webhook normalisé", {
      provider,
      rail,
      eventId: settlementPayload.eventId,
      reference: settlementPayload.reference,
      providerReference: settlementPayload.providerReference,
      providerStatus: settlementPayload.providerStatus,
      verified: settlementPayload.verified,
    });

    req.body = settlementPayload;

    /* ========================================================================
     * IDEMPOTENCE — LE REJEU EST LE COMPORTEMENT NORMAL D'UN PRESTATAIRE
     * ========================================================================
     *
     * Rien ne dédupliquait ces rappels. Or tous les prestataires réémettent
     * tant qu'ils n'ont pas reçu un 2xx, et plusieurs réémettent même après :
     * l'audit classait ce risque « probabilité élevée », et ce n'est pas un
     * accident, c'est le protocole.
     *
     * Le contrôle est posé ICI, et pas ailleurs :
     *   - APRÈS la vérification de signature — enregistrer un événement non
     *     authentifié permettrait à n'importe qui de remplir le registre, et
     *     pire, de RÉSERVER l'identifiant d'un vrai événement pour empêcher son
     *     traitement ;
     *   - AVANT le règlement — c'est lui qui déplace l'argent.
     */
    const claim = await claimEvent(settlementPayload);

    if (claim.action === "replay") {
      /**
       * Déjà traité. On répond 200 : toute autre réponse ferait réessayer le
       * prestataire indéfiniment sur un événement dont on a déjà tiré toutes
       * les conséquences.
       */
      logger.info("[providerWebhook] rejeu ignoré", {
        provider,
        rail,
        eventId: claim.key,
        derived: claim.derived,
      });

      res.set("Webhook-Replayed", "true");
      return res.status(200).json({
        success: true,
        replayed: true,
        eventId: claim.key,
      });
    }

    if (claim.action === "conflict") {
      /**
       * Le même événement est en cours de traitement ailleurs — deux instances
       * l'ont reçu en parallèle, ce que les prestataires font couramment.
       *
       * ⚠️ 409 ET SURTOUT PAS 200. Acquitter un traitement qui peut encore
       * échouer ferait cesser les réémissions, et l'événement serait perdu
       * définitivement.
       */
      logger.warn("[providerWebhook] déjà en cours ailleurs", {
        provider,
        rail,
        eventId: claim.key,
      });

      return res.status(409).json({
        success: false,
        error: "Rappel déjà en cours de traitement",
        code: "WEBHOOK_IN_PROGRESS",
        eventId: claim.key,
      });
    }

    /**
     * ⚠️ ON MARQUE APRÈS LE RÈGLEMENT, JAMAIS AVANT.
     *
     * Marquer d'abord ferait perdre l'événement pour de bon si le règlement
     * échouait ensuite : le rejeu suivant serait pris pour un doublon et
     * ignoré, l'argent n'arriverait jamais chez le bénéficiaire, et aucune
     * erreur n'apparaîtrait nulle part.
     *
     * ⚠️ ON ATTEND LE RÉSULTAT, ON N'OBSERVE PLUS `res.on("finish")`.
     *
     * L'écoute de la réponse était le seul moyen tant que le règlement écrivait
     * lui-même dans `res` et ne rendait rien. Depuis F.4, il rend
     * `{ statusCode, body }` — on peut donc clore le registre sur un fait plutôt
     * que sur une inférence. Deux gains concrets :
     *
     *   - la clôture précède l'envoi de la réponse. Avec `finish`, elle le
     *     suivait : un processus tué entre les deux laissait l'événement en
     *     `processing` pour toujours, alors même que le règlement était acquis ;
     *   - un échec est saisi comme une exception, avec son message, au lieu
     *     d'être déduit d'un code HTTP écrit par le gestionnaire d'erreurs.
     *
     * Si `markProcessed` échoue, le règlement reste acquis et l'événement paraît
     * inachevé : le rejeu suivant le retraversera, et les drapeaux monétaires de
     * la transaction l'arrêteront sans rien doubler. C'est le bon sens de
     * l'erreur.
     */
    let result;

    try {
      /**
       * ⚠️ L'ENCAISSEMENT D'ABORD. Un rappel entrant n'a pas de `Transaction` :
       * le laisser aller à `settleExternalTransaction` produirait
       * « transaction introuvable » et une réémission sans fin.
       */
      result = await traiterCommeEncaissement(req.body);

      if (!result) {
        result = await settleExternalTransaction(req.body);
      }
    } catch (err) {
      await markFailed(claim.key, provider, err).catch((e) =>
        logger.error("[providerWebhook] clôture du registre impossible", {
          eventId: claim.key,
          error: e?.message || e,
        })
      );

      throw err;
    }

    await markProcessed(claim.key, provider, {
      responseStatus: result.statusCode,
    }).catch((e) =>
      logger.error("[providerWebhook] clôture du registre impossible", {
        eventId: claim.key,
        error: e?.message || e,
      })
    );

    return res.status(result.statusCode).json(result.body);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  providerWebhookController,
  providerWebhookTransaction: providerWebhookController,
};