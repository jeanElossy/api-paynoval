"use strict";

/**
 * ============================================================================
 * IDEMPOTENCE DE L'API — SÉMANTIQUE STRIPE
 * ============================================================================
 *
 * Quatre situations, quatre réponses distinctes :
 *
 *   1. clé inconnue                    → on exécute, et on fige la réponse ;
 *   2. clé connue, même requête, finie → on rend la RÉPONSE D'ORIGINE, à
 *                                        l'identique (en-tête `Idempotency-Replayed`) ;
 *   3. clé connue, requête DIFFÉRENTE  → 400. Rendre la réponse du premier
 *                                        virement à un second, différent, serait
 *                                        mentir au client ;
 *   4. clé connue, traitement en cours → 409. Deux exécutions simultanées de la
 *                                        même intention n'ont aucun sens ; on
 *                                        demande de réessayer.
 *
 * CE QUI N'EST PAS FIGÉ, ET POURQUOI
 * ----------------------------------
 * Les réponses 5xx ne sont pas conservées : une panne serveur n'est pas un
 * résultat. Figer un 500 condamnerait le client à recevoir éternellement la même
 * erreur pour une intention parfaitement valide. La clé est donc libérée, et le
 * rejeu suivant repart proprement. C'est exactement la règle de Stripe.
 *
 * Les réponses 4xx, elles, SONT figées : un refus pour solde insuffisant ou
 * bénéficiaire invalide est un résultat stable, que rejouer ne changera pas.
 */

const { getTxConn } = require("../config/db");
const buildIdempotencyRecordModel = require("../models/IdempotencyRecord");

const {
  extractIdempotencyKey,
  isValidIdempotencyKey,
  buildScope,
  computeRequestFingerprint,
  MIN_KEY_LENGTH,
  MAX_KEY_LENGTH,
} = require("../utils/idempotencyKeys");

const { IN_PROGRESS_LEASE_MS } = buildIdempotencyRecordModel;

let logger = console;
try {
  logger = require("../logger");
} catch {}

/** Résolution paresseuse : la connexion n'existe pas au chargement du module. */
function getModel() {
  return buildIdempotencyRecordModel(getTxConn());
}

function resolveUserId(req) {
  return String(
    req?.user?._id || req?.user?.id || req?.userId || "anonymous"
  );
}

/**
 * Une clé est-elle exigée ?
 *
 * L'exigence est le DÉFAUT — cohérent avec la règle « refus par défaut » du
 * projet : une création d'argent sans clé d'idempotence est une création qu'on
 * ne saura pas dédoublonner si le réseau la rejoue.
 *
 * `IDEMPOTENCY_REQUIRED=false` l'assouplit **sans redéploiement**, le temps que
 * le parc mobile installé passe à une version qui envoie la clé. C'est
 * l'échappatoire de déploiement, pas le régime normal : on la retire dès que le
 * parc a basculé.
 */
function idempotencyIsRequired() {
  return String(process.env.IDEMPOTENCY_REQUIRED || "true").toLowerCase() !== "false";
}

/**
 * @param {object} options
 * @param {boolean} [options.required]  Force l'exigence pour cette route.
 *                                      Par défaut : la valeur d'environnement.
 */
function idempotency({ required } = {}) {
  return async function idempotencyMiddleware(req, res, next) {
    const rawKey = extractIdempotencyKey(req);

    if (!rawKey) {
      const mustHaveKey = required === undefined ? idempotencyIsRequired() : required;

      if (!mustHaveKey) return next();

      return res.status(400).json({
        success: false,
        status: 400,
        message:
          "En-tête Idempotency-Key requis sur cette opération. " +
          "Il garantit qu'un rejeu ne produit pas un second mouvement.",
      });
    }

    if (!isValidIdempotencyKey(rawKey)) {
      return res.status(400).json({
        success: false,
        status: 400,
        message:
          `Idempotency-Key invalide (${MIN_KEY_LENGTH} à ${MAX_KEY_LENGTH} caractères, ` +
          "lettres, chiffres, point, tiret, souligné, deux-points).",
      });
    }

    const userId = resolveUserId(req);
    const method = req.method;
    const path = req.baseUrl ? `${req.baseUrl}${req.path}` : req.path;

    const scope = buildScope({ userId, method, path });
    const fingerprint = computeRequestFingerprint({ method, path, body: req.body });

    let IdempotencyRecord;
    try {
      IdempotencyRecord = getModel();
    } catch (err) {
      // Base indisponible : on ne bloque pas le paiement pour autant. Le risque
      // de doublon reste couvert en aval par les index uniques.
      logger.warn?.("[IDEMPOTENCY] registre indisponible", { message: err?.message });
      return next();
    }

    let record = null;

    try {
      record = await IdempotencyRecord.create({
        scope,
        key: rawKey,
        requestFingerprint: fingerprint,
        status: "in_progress",
        userId,
        method,
        path,
        startedAt: new Date(),
      });
    } catch (err) {
      if (err?.code !== 11000) return next(err);

      const existing = await IdempotencyRecord.findOne({ scope, key: rawKey }).lean();

      if (!existing) {
        // Disparue entre-temps (expiration) : on laisse passer.
        return next();
      }

      if (existing.requestFingerprint !== fingerprint) {
        return res.status(400).json({
          success: false,
          status: 400,
          message:
            "Cette Idempotency-Key a déjà été utilisée avec des paramètres différents. " +
            "Utilisez une clé distincte pour une opération distincte.",
        });
      }

      if (existing.status === "completed") {
        res.setHeader("Idempotency-Replayed", "true");
        return res
          .status(existing.responseStatus || 200)
          .json(existing.responseBody ?? { success: true });
      }

      const staleBefore = Date.now() - IN_PROGRESS_LEASE_MS;

      if (new Date(existing.startedAt || 0).getTime() > staleBefore) {
        return res.status(409).json({
          success: false,
          status: 409,
          message:
            "Une requête portant cette Idempotency-Key est déjà en cours de traitement.",
        });
      }

      /**
       * Bail expiré : le processus qui tenait la clé n'a jamais conclu. On la
       * reprend — mais uniquement si personne d'autre ne l'a fait entre-temps,
       * d'où la garde sur `startedAt` dans le filtre.
       */
      const taken = await IdempotencyRecord.findOneAndUpdate(
        { scope, key: rawKey, status: "in_progress", startedAt: existing.startedAt },
        { $set: { startedAt: new Date(), requestFingerprint: fingerprint } },
        { new: true }
      );

      if (!taken) {
        return res.status(409).json({
          success: false,
          status: 409,
          message:
            "Une requête portant cette Idempotency-Key est déjà en cours de traitement.",
        });
      }

      record = taken;
    }

    /**
     * Interception de la réponse. On ne peut pas figer ce qu'on n'a pas vu :
     * c'est ici, et seulement ici, qu'on sait ce que le contrôleur a répondu.
     */
    const originalJson = res.json.bind(res);
    let settled = false;

    res.json = (body) => {
      if (settled) return originalJson(body);
      settled = true;

      const statusCode = res.statusCode || 200;

      const persist =
        statusCode >= 500
          ? IdempotencyRecord.deleteOne({ scope, key: rawKey })
          : IdempotencyRecord.updateOne(
              { scope, key: rawKey },
              {
                $set: {
                  status: "completed",
                  responseStatus: statusCode,
                  responseBody: body,
                  completedAt: new Date(),
                },
              }
            );

      // La réponse ne dépend pas de l'écriture du registre : mieux vaut un
      // client servi et une clé non figée que l'inverse.
      persist.catch((err) =>
        logger.warn?.("[IDEMPOTENCY] enregistrement de la réponse impossible", {
          message: err?.message,
        })
      );

      return originalJson(body);
    };

    /**
     * Si le contrôleur lève sans jamais répondre, la clé resterait « en cours »
     * jusqu'à expiration du bail. On la libère dès la fin de la requête.
     */
    res.on("close", () => {
      if (settled) return;
      settled = true;

      IdempotencyRecord.deleteOne({ scope, key: rawKey }).catch(() => {});
    });

    return next();
  };
}

module.exports = idempotency;
module.exports.idempotencyIsRequired = idempotencyIsRequired;
