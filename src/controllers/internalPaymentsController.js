"use strict";

const mongoose = require("mongoose");
const crypto = require("crypto");
const createError = require("http-errors");

const { getUsersConn, getTxConn } = require("../config/db");
const config = require("../config");
const logger = require("../utils/logger");

const usersConn = getUsersConn();
const txConn = getTxConn();

const User = require("../models/User")(usersConn);
const TxWalletBalance = require("../models/TxWalletBalance")(txConn);
const Transaction = require("../models/Transaction")(txConn);
const { runWithTransaction } = require("../utils/transactionRunner");

/**
 * ⚠️ L'ARGENT NE BOUGE PAS SANS ÉCRITURE COMPTABLE.
 *
 * Ce contrôleur déplaçait des portefeuilles par `TxWalletBalance.debit` et
 * `.credit` **sans écrire une seule ligne au grand livre** — le fichier ne
 * contenait aucune occurrence de « ledger ». Et ce n'est pas un chemin
 * marginal : c'est là qu'aboutit `POST /api/v1/pay` du backend principal.
 *
 * Deux invariants tombaient ensemble : le **2** (le grand livre fait foi, le
 * solde n'en est qu'une projection — une projection qui bouge seule n'en est
 * plus une) et le **4** (toute écriture financière est auditable ; il n'y avait
 * rien à auditer).
 *
 * Corrigé le 2026-08-28. Les écritures sont posées **dans la même transaction**
 * que les mouvements de portefeuille : hors transaction, un échec entre les deux
 * laisserait exactement l'incohérence qu'on vient de fermer.
 */
const { postInternalPaymentEntries } = require("../services/ledgerService");

const sanitize = (text) =>
  String(text || "").replace(/[<>\\/{};]/g, "").trim();

const ADMIN_EMAIL = config.adminEmail || "admin@paynoval.com";

/* ------------------------------------------------------------------ */
/* Multi-conn session safety                                          */
/* ------------------------------------------------------------------ */
function sameMongoClient(connA, connB) {
  try {
    const a = connA?.getClient?.();
    const b = connB?.getClient?.();
    return !!a && !!b && a === b;
  } catch {
    return false;
  }
}

/**
 * ⚠️ ÉVALUÉE À CHAQUE APPEL, jamais figée au chargement du fichier.
 *
 * Une constante calculée au `require` vaudrait `false` pour toujours si le
 * module était chargé avant la connexion. Ce serait sans gravité pour la
 * session — on retomberait en mode dégradé — mais la COMPENSATION MANUELLE du
 * bloc `catch` s'appuie sur cette valeur : figée à `false` alors que la
 * transaction est réelle, elle rembourserait un débit que l'annulation a déjà
 * défait. Soit un crédit en double.
 */
function canShareSession() {
  return sameMongoClient(usersConn, txConn);
}

async function startTxSession() {
  if (!canShareSession()) return null;
  if (typeof txConn?.startSession === "function") return txConn.startSession();
  return mongoose.startSession();
}

function maybeSessionOpts(session) {
  return session ? { session } : {};
}

function isValidObjectId(v) {
  return mongoose.Types.ObjectId.isValid(String(v || ""));
}

function normalizeCurrency(v) {
  const cur = String(v || "").trim().toUpperCase();
  if (!cur) return "XOF";
  return cur;
}

/* ------------------------------------------------------------------ */
/* Kind resolver                                                      */
/* ------------------------------------------------------------------ */
function resolveKind(kind) {
  switch (kind) {
    case "bonus":
    case "cashback":
    case "adjustment_credit":
    case "cagnotte_withdrawal":
      return { mode: "credit" };

    case "adjustment_debit":
      return { mode: "debit" };

    case "purchase":
      return { mode: "transfer" };

    case "cagnotte_participation":
      return { mode: "debit_only" };

    case "generic":
    default:
      return { mode: "generic" };
  }
}

function getCorrelationId(req) {
  return (
    req.headers["x-correlation-id"] ||
    req.headers["x-request-id"] ||
    crypto.randomBytes(8).toString("hex")
  );
}

function ensureDbReady() {
  const usersReady = usersConn?.readyState === 1;
  const txReady = txConn?.readyState === 1;
  return {
    usersReady,
    txReady,
    usersState: usersConn?.readyState,
    txState: txConn?.readyState,
  };
}

function getIdempotencyKey(req, metadata) {
  const h =
    req.headers["idempotency-key"] ||
    req.headers["Idempotency-Key"] ||
    req.headers["x-idempotency-key"] ||
    null;

  return (
    (h && String(h).trim()) ||
    (metadata && metadata.idempotencyKey
      ? String(metadata.idempotencyKey).trim()
      : null)
  );
}

async function createInternalTransactionDocument({
  session,
  kind,
  senderUser,
  receiverUser,
  amount,
  currencyCode,
  country,
  reason,
  description,
  context,
  contextId,
  orderId,
  metadata,
  receiverOverrideId,
  receiverOverrideName,
  idempotencyKey,
}) {
  const now = new Date();
  const senderName = senderUser.fullName || senderUser.email;

  const receiverId =
    receiverOverrideId || (receiverUser ? receiverUser._id : senderUser._id);

  const receiverName =
    receiverOverrideName ||
    (receiverUser ? receiverUser.fullName || receiverUser.email : "Système PayNoval");

  const normalizedCurrency = normalizeCurrency(currencyCode);
  const decAmount = mongoose.Types.Decimal128.fromString(Number(amount).toFixed(2));
  const decFees = mongoose.Types.Decimal128.fromString("0.00");
  const decNet = decAmount;
  const decLocal = decAmount;
  const decExchange = mongoose.Types.Decimal128.fromString("1");

  const reference = crypto.randomBytes(8).toString("hex").toUpperCase();

  const txMetadata = Object.assign({}, metadata || {}, {
    internal: true,
    operationKind: kind,
    context: context || null,
    contextId: contextId || null,
    receiverType: receiverOverrideId ? "vault" : "user",
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });

  const securityQuestion = `INTERNAL:${kind}`;
  const securityCode = crypto.randomBytes(8).toString("hex");

  const [tx] = await Transaction.create(
    [
      {
        reference,
        sender: senderUser._id,
        receiver: receiverId,
        amount: decAmount,
        transactionFees: decFees,
        netAmount: decNet,
        senderCurrencySymbol: normalizedCurrency,
        exchangeRate: decExchange,
        localAmount: decLocal,
        localCurrencySymbol: normalizedCurrency,
        senderName,
        senderEmail: senderUser.email,
        nameDestinataire: receiverName,
        recipientEmail: receiverUser ? receiverUser.email : null,
        country: sanitize(country || senderUser.country || "Unknown"),
        securityQuestion,
        securityCode,
        destination: "paynoval",
        funds: "paynoval",
        status: "confirmed",
        confirmedAt: now,
        description: description || reason || `Opération interne: ${kind}`,
        orderId: orderId || null,
        metadata: txMetadata,
        feeSnapshot: {
          kind,
          internal: true,
          appliedFees: 0,
          netAfterFees: Number(amount),
          currency: normalizedCurrency,
        },
        feeId: null,
        attemptCount: 0,
        lastAttemptAt: null,
        lockedUntil: null,
        archived: false,
      },
    ],
    maybeSessionOpts(session)
  );

  return tx;
}

/**
 * POST /api/v1/internal-payments
 */
exports.createInternalPayment = async (req, res, next) => {
  const correlationId = getCorrelationId(req);

  res.setTimeout(70_000);

  const db = ensureDbReady();
  if (!db.usersReady || !db.txReady) {
    logger.error("[internal-payments] DB not ready", { correlationId, ...db });
    return res.status(503).json({
      success: false,
      error: "Base de données indisponible (connexion en cours). Réessayez.",
      details: { correlationId, db },
    });
  }

  const session = await startTxSession();
  let debited = false;
  let credited = false;
  let creditUserId = null;
  let debitUserId = null;
  let debitAmount = 0;
  let debitCurrency = "XOF";

  try {
    /**
     * UNITÉ DE TRAVAIL REJOUABLE.
     *
     * `withTransaction` peut exécuter ce corps plusieurs fois — sur conflit
     * d'écriture, la transaction précédente est annulée et tout est rejoué. Les
     * lectures sont donc refaites, et les `$inc` de portefeuille repartent d'un
     * état propre : rien ne se cumule.
     *
     * Les trois sorties RENVOIENT un résultat au lieu de répondre. Écrire la
     * réponse ici l'enverrait autant de fois qu'il y a de tentatives.
     */
    const outcome = await runWithTransaction(session, async () => {
      const {
        kind,
        amount,
        currencySymbol,
        currency,
        fromUserId,
        toUserId,
        reason,
        description,
        country,
        context,
        contextId,
        orderId,
        metadata,
        targetVaultId,
        targetVaultName,
      } = req.body;

      const effectiveCurrency = normalizeCurrency(currency || currencySymbol || "XOF");
      const idempotencyKey = getIdempotencyKey(req, metadata);

      logger.info("[internal-payments] start", {
        correlationId,
        kind,
        amount,
        currency: effectiveCurrency,
        fromUserId,
        toUserId,
        context,
        contextId,
        orderId,
        idempotencyKey,
      });

      const amt = Number(amount);
      if (!amt || Number.isNaN(amt) || amt <= 0) {
        throw createError(400, "Montant interne invalide.");
      }
      if (amt > 1_000_000_000) {
        throw createError(400, "Montant interne trop élevé (limite de sécurité).");
      }

      const { mode } = resolveKind(kind);
      const isLogOnly = mode === "log-only";
      const isDebitOnly = mode === "debit_only";

      if (idempotencyKey) {
        const existing = await Transaction.findOne({
          "metadata.idempotencyKey": idempotencyKey,
        })
          .select("_id reference metadata sender receiver amount status confirmedAt")
          .lean()
          .session(session || null);

        if (existing) {
          logger.warn("[internal-payments] idempotent-hit", {
            correlationId,
            idempotencyKey,
            txId: existing._id,
          });

          return { outcome: "idempotent", existing, kind, mode };
        }
      }

      if (mode === "transfer") {
        if (!fromUserId || !toUserId) {
          throw createError(
            400,
            "fromUserId et toUserId sont requis pour un transfert interne."
          );
        }
        if (String(fromUserId) === String(toUserId)) {
          throw createError(400, "fromUserId et toUserId ne peuvent pas être identiques.");
        }
      }

      if (mode === "credit" && !toUserId) {
        throw createError(
          400,
          "toUserId est requis pour un crédit interne (bonus, cashback)."
        );
      }

      if ((mode === "debit" || isDebitOnly) && !fromUserId) {
        throw createError(400, "fromUserId est requis pour un débit interne.");
      }

      if (mode === "generic" && !fromUserId && !toUserId) {
        throw createError(
          400,
          "Au moins fromUserId ou toUserId doit être renseigné pour une opération générique."
        );
      }

      const vaultIdCandidate = isDebitOnly
        ? isValidObjectId(targetVaultId)
          ? String(targetVaultId)
          : isValidObjectId(contextId)
          ? String(contextId)
          : null
        : null;

      if (kind === "cagnotte_participation" && !vaultIdCandidate) {
        throw createError(
          400,
          "Participation cagnotte: targetVaultId (ObjectId) requis (ou contextId doit être un ObjectId)."
        );
      }

      logger.info("[internal-payments] load-admin", { correlationId });

      const adminUser = await User.findOne({ email: ADMIN_EMAIL })
        .select("_id email fullName country")
        .session(session || null);

      if (!adminUser) {
        throw createError(500, `Compte administrateur "${ADMIN_EMAIL}" introuvable.`);
      }

      let fromUser = null;
      let toUser = null;

      if (fromUserId) {
        logger.info("[internal-payments] load-fromUser", { correlationId, fromUserId });
        fromUser = await User.findById(fromUserId)
          .select("_id email fullName country")
          .session(session || null);

        if (!fromUser) throw createError(404, "Utilisateur fromUserId introuvable.");
      }

      if (toUserId) {
        logger.info("[internal-payments] load-toUser", { correlationId, toUserId });
        toUser = await User.findById(toUserId)
          .select("_id email fullName country")
          .session(session || null);

        if (!toUser) throw createError(404, "Utilisateur toUserId introuvable.");
      }

      if (mode === "credit" && !fromUser) fromUser = adminUser;
      if (mode === "debit" && !toUser) toUser = adminUser;

      if (isDebitOnly) {
        if (!fromUser) {
          throw createError(500, "fromUser introuvable pour une opération debit_only.");
        }
        toUser = null;
      }

      if (isLogOnly) {
        const sender = fromUser || adminUser;
        const receiver = adminUser;

        const tx = await createInternalTransactionDocument({
          session,
          kind,
          senderUser: sender,
          receiverUser: receiver,
          amount: amt,
          currencyCode: effectiveCurrency,
          country,
          reason,
          description,
          context,
          contextId,
          orderId,
          metadata,
          receiverOverrideId: null,
          receiverOverrideName: null,
          idempotencyKey,
        });

        return { outcome: "log-only", tx };
      }

      /**
       * FERMETURE — aucun mouvement d'argent sans transaction atomique.
       * ======================================================================
       *
       * Tout ce qui suit touche DEUX comptes. Sans session partagée, le débit
       * et le crédit ne sont pas atomiques, et le rattrapage était confié à une
       * compensation manuelle écrite à la main dans le bloc `catch`. Cette
       * compensation portait deux défauts, trouvés le 2026-09-03 :
       *
       *   1. **Elle était asymétrique.** Elle ne remboursait que le DÉBIT.
       *      `credited` et `creditUserId` sont pourtant suivis (lignes 266-267,
       *      502-503) et elle les ignorait : si l'erreur survenait après le
       *      crédit, l'expéditeur était remboursé et le bénéficiaire GARDAIT
       *      l'argent. De l'argent créé — la faute la plus grave possible ici.
       *
       *   2. **Elle ne produisait aucune contre-écriture.** Si
       *      `postInternalPaymentEntries` avait déjà écrit au grand livre, la
       *      compensation restaurait le solde en silence : le grand livre disait
       *      que l'argent avait bougé, le solde disait le contraire. L'invariant
       *      4 exige une contre-écriture (`REVERSAL`), jamais une restauration
       *      silencieuse.
       *
       * Rendre cette compensation correcte demanderait de rejouer à la main ce
       * qu'une transaction fait gratuitement — et de le faire juste, sur un
       * chemin d'argent, dans un bloc `catch` que personne n'exerce. On REFUSE
       * plutôt (règle B.2 : le chemin de l'argent échoue en fermeture).
       *
       * Le mode `log-only` n'est pas concerné : il ne déplace rien, et il a
       * déjà rendu son résultat plus haut.
       *
       * Portée réelle : `canShareSession()` est vrai dès que les deux bases
       * partagent le client Mongo (`useDb`), ce qui est le cas en configuration
       * normale. Ce refus ne se déclenche qu'avec deux clusters distincts ou
       * `MONGO_SHARE_CLIENT=off` — et dans ces conditions, ce point de terminaison
       * ne PEUT PAS tenir ses garanties.
       */
      if (!canShareSession()) {
        logger.error("[internal-payments] REFUS : session atomique indisponible", {
          correlationId,
          mode,
          consequence:
            "débit et crédit ne seraient pas atomiques ; aucun mouvement n'a eu lieu",
        });

        throw createError(
          503,
          "Mouvement interne refusé : les deux bases ne partagent pas de session " +
            "Mongo, le débit et le crédit ne peuvent donc pas être atomiques. " +
            "Vérifier MONGO_SHARE_CLIENT et la configuration des connexions."
        );
      }

      if (mode === "debit" || mode === "transfer" || isDebitOnly) {
        const sourceUser = fromUser || adminUser;

        logger.info("[internal-payments] debit(wallet)", {
          correlationId,
          userId: String(sourceUser._id),
          amt,
          currency: effectiveCurrency,
        });

        await TxWalletBalance.debit(
          sourceUser._id,
          effectiveCurrency,
          amt,
          maybeSessionOpts(session)
        );

        debited = true;
        debitUserId = String(sourceUser._id);
        debitAmount = amt;
        debitCurrency = effectiveCurrency;
      }

      if (mode === "credit" || mode === "transfer") {
        const targetUser = toUser || adminUser;

        logger.info("[internal-payments] credit(wallet)", {
          correlationId,
          userId: String(targetUser._id),
          amt,
          currency: effectiveCurrency,
        });

        await TxWalletBalance.credit(
          targetUser._id,
          effectiveCurrency,
          amt,
          maybeSessionOpts(session)
        );

        credited = true;
        creditUserId = String(targetUser._id);
      }

      const senderUser = fromUser || adminUser;
      const receiverUser = toUser || adminUser;

      const receiverOverrideId = isDebitOnly ? vaultIdCandidate : null;
      const receiverOverrideName = isDebitOnly
        ? targetVaultName ||
          (metadata && metadata.vaultName) ||
          "Coffre Cagnotte"
        : null;

      logger.info("[internal-payments] create-tx-doc", {
        correlationId,
        receiverOverrideId,
        receiverOverrideName,
      });

      const tx = await createInternalTransactionDocument({
        session,
        kind,
        senderUser,
        receiverUser,
        amount: amt,
        currencyCode: effectiveCurrency,
        country,
        reason,
        description,
        context,
        contextId,
        orderId,
        metadata,
        receiverOverrideId,
        receiverOverrideName,
        idempotencyKey,
      });

        /**
         * ⚠️ POSÉ APRÈS `tx`, PAS APRÈS LA TRANSACTION.
         *
         * Une écriture de grand livre doit être rattachée à une transaction :
         * `tx._id` n'existe qu'ici. Mais nous sommes toujours À L'INTÉRIEUR de
         * `runWithTransaction` — l'ordre à l'intérieur d'une transaction Mongo
         * n'a aucune importance pour l'atomicité, seule compte l'appartenance.
         *
         * Si cette pose échoue, TOUT est annulé : le document, le débit et le
         * crédit. C'est précisément la garantie qui manquait — jusqu'ici les
         * portefeuilles bougeaient et rien ne l'enregistrait.
         */
        /**
         * ⚠️ SEULEMENT S'IL Y A EU UN MOUVEMENT.
         *
         * `mode` se déduit de `kind` (`resolveKind`), et le genre `generic`
         * n'en produit AUCUN : il enregistre une transaction sans toucher à un
         * portefeuille. Une écriture comptable pour un mouvement qui n'a pas eu
         * lieu serait un faux dans le grand livre.
         *
         * La primitive refuse d'être appelée sans côté — délibérément : un
         * appel qui ne book rien masquerait un chemin qui déplace de l'argent
         * sans l'enregistrer. C'est donc à l'appelant de savoir s'il a bougé
         * quelque chose. Constaté en essai réel le 2026-08-28 : sans cette
         * garde, un `kind: "generic"` faisait échouer toute la transaction.
         */
        if (debited || credited) {
        await postInternalPaymentEntries({
          transaction: tx,
          debit: debited
            ? {
                userId: debitUserId,
                amount: debitAmount,
                currency: debitCurrency,
                mode,
              }
            : null,
          credit: credited
            ? {
                userId: creditUserId,
                amount: amt,
                currency: effectiveCurrency,
                mode,
              }
            : null,
          session,
        });
        }

        logger.info("[internal-payments] done", {
          correlationId,
          txId: String(tx._id),
          ref: tx.reference,
        });

        return { outcome: "done", tx, kind, mode };
    });

    session?.endSession?.();

    /* RÉPONSE — écrite une seule fois, après la transaction. */

    if (outcome.outcome === "idempotent") {
      return res.status(200).json({
        success: true,
        idempotent: true,
        transactionId: String(outcome.existing._id),
        reference: outcome.existing.reference,
        kind: outcome.kind,
        mode: outcome.mode,
      });
    }

    if (outcome.outcome === "log-only") {
      return res.status(201).json({
        success: true,
        mode: "log-only",
        transactionId: outcome.tx._id.toString(),
        reference: outcome.tx.reference,
      });
    }

    return res.status(201).json({
      success: true,
      transactionId: outcome.tx._id.toString(),
      reference: outcome.tx.reference,
      kind: outcome.kind,
      mode: outcome.mode,
    });
  } catch (err) {
    // `withTransaction` a déjà annulé avant de propager ; garde défensive.
    try {
      if (session?.inTransaction?.()) await session.abortTransaction();
    } catch (e) {
      logger.error("[internal-payments] rollback error", {
        message: e?.message || e,
      });
    } finally {
      session?.endSession?.();
    }

    /**
     * PLUS DE COMPENSATION MANUELLE — retirée le 2026-09-03.
     * ========================================================================
     *
     * Elle remboursait le débit à la main quand la session n'était pas
     * partagée. Deux défauts la rendaient pire que son absence : elle était
     * ASYMÉTRIQUE (elle ignorait le crédit, donc l'argent pouvait être créé) et
     * elle n'écrivait AUCUNE contre-écriture au grand livre (invariant 4).
     *
     * Elle n'a plus de cas d'emploi : le corps refuse désormais de bouger le
     * moindre montant sans session atomique. Quand la transaction est réelle,
     * `withTransaction` a déjà tout défait avant de propager — c'est la seule
     * façon correcte, et elle est gratuite.
     *
     * Le contrôle ci-dessous ne doit JAMAIS être vrai. S'il l'est, c'est qu'un
     * chemin a bougé de l'argent hors transaction : on le dit fort plutôt que
     * de tenter un rattrapage improvisé, qui est exactement ce qui a mal
     * tourné ici.
     */
    if ((debited || credited) && !canShareSession()) {
      logger.error("[internal-payments] ÉTAT IMPOSSIBLE — argent déplacé hors transaction", {
        marqueur: "MONEY_MOVED_WITHOUT_TRANSACTION",
        correlationId,
        debited,
        credited,
        debitUserId,
        creditUserId,
        debitAmount,
        debitCurrency,
        consequence:
          "solde modifié sans transaction atomique : rapprochement manuel requis, " +
          "AUCUN rattrapage automatique n'est tenté",
      });
    }

    logger.error("[internal-payments] error", {
      correlationId,
      message: err.message,
      stack: err.stack,
    });

    return next(err);
  }
};