"use strict";

/**
 * Exécution des ajustements manuels de solde décidés depuis le back-office.
 *
 * Ce service est le SEUL endroit où un mouvement d'argent naît d'une décision
 * humaine plutôt que d'une opération client. Il est appelé exclusivement par le
 * backend principal, via `/api/v1/internal/admin/adjustments/execute`, une fois
 * la demande **doublement validée** (demandeur ≠ valideur). Aucune règle
 * d'autorisation n'est rejouée ici : le TX Core ne connaît pas les rôles du
 * back-office, il exécute une décision déjà prise et tracée.
 *
 * Trois garanties structurent le code :
 *
 * 1. **Double écriture.** Un crédit client débite `OPERATIONS_TREASURY`, un
 *    débit client la crédite. Le grand livre reste équilibré et le coût réel
 *    des gestes commerciaux demeure lisible dans l'analytique de trésorerie.
 *
 * 2. **Idempotence garantie par la base.** La référence est déterministe
 *    (`ADJ-<adjustmentId>`) et l'index unique partiel `{userId, reference}` de
 *    `Transaction` refuse physiquement un second enregistrement. Un rejeu de
 *    l'approbation, un double clic ou un retry réseau ne peuvent pas produire
 *    deux mouvements — c'est la base qui l'interdit, pas une lecture préalable
 *    qui pourrait être doublée par une course.
 *
 * 3. **Atomicité.** Transaction d'historique, solde du portefeuille, solde de
 *    trésorerie et écritures comptables vivent tous sur la connexion
 *    « transactions » : ils sont écrits dans une seule session Mongo. En cas
 *    d'échec à mi-parcours, rien n'est écrit — pas de compte crédité sans
 *    écriture comptable en face.
 *
 * ⚠️ `ledgerService` appelle `getTxConn()` **au chargement du module**
 * (ledgerService.js, ligne 21). Il est donc requis à l'usage, jamais en tête de
 * fichier : c'est le piège documenté dans le CLAUDE.md du dépôt.
 */

const mongoose = require("mongoose");
const createError = require("http-errors");

const { getTxConn } = require("../config/db");
const { roundMoney } = require("./pricingSnapshotNormalizer");

let logger = console;
try {
  logger = require("../utils/logger");
} catch {}

/** Contrepartie unique de tout ajustement manuel. */
const TREASURY_SYSTEM_TYPE = "OPERATIONS_TREASURY";
const TREASURY_LABEL = "PayNoval Operations Treasury";

const DIRECTIONS = new Set(["credit", "debit"]);

/**
 * Catégories de motif, alignées sur `models/AdminAdjustment.js` du backend
 * principal. Le TX Core ne les valide pas : il les consigne. Une catégorie
 * inconnue serait le signe d'une désynchronisation entre les deux dépôts, pas
 * une raison de refuser un mouvement déjà validé par deux personnes.
 */
const KNOWN_CATEGORIES = new Set([
  "commercial_gesture",
  "fee_refund",
  "incident_repair",
  "chargeback",
  "correction",
  "other",
]);

/* -------------------------------------------------------------------------- */
/* Normalisation des entrées                                                  */
/* -------------------------------------------------------------------------- */

function normalizeCurrency(value) {
  const cur = String(value || "").trim().toUpperCase();

  // Codes ISO uniquement : jamais de symbole. `F CFA` couvre XOF et XAF, deux
  // devises distinctes — un symbole rendrait le grand livre ambigu.
  if (!/^[A-Z]{3,4}$/.test(cur)) {
    throw createError(422, `Devise invalide : ${value}`);
  }

  return cur;
}

function normalizeObjectId(value, fieldName) {
  const id = String(value || "").trim();

  if (!id) {
    throw createError(422, `${fieldName} requis`);
  }

  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw createError(422, `${fieldName} invalide : ${id}`);
  }

  return id;
}

function normalizeDirection(value) {
  const direction = String(value || "").trim().toLowerCase();

  if (!DIRECTIONS.has(direction)) {
    throw createError(
      422,
      `Sens d'ajustement invalide : ${value} (attendu « credit » ou « debit »)`
    );
  }

  return direction;
}

function normalizeAmount(value, currency) {
  const amount = Number(roundMoney(Number(value || 0), currency));

  if (!Number.isFinite(amount) || amount <= 0) {
    // Le sens est porté par `direction`, jamais par le signe : un montant
    // négatif inverserait silencieusement l'opération validée.
    throw createError(422, `Montant invalide : ${value}`);
  }

  return amount;
}

function resolveTreasuryUserId() {
  const treasuryUserId = String(
    process.env.OPERATIONS_TREASURY_USER_ID || ""
  ).trim();

  if (!treasuryUserId) {
    throw createError(
      500,
      "OPERATIONS_TREASURY_USER_ID manquant : aucune contrepartie configurée pour les ajustements"
    );
  }

  if (!mongoose.Types.ObjectId.isValid(treasuryUserId)) {
    throw createError(
      500,
      `OPERATIONS_TREASURY_USER_ID invalide : ${treasuryUserId}`
    );
  }

  return treasuryUserId;
}

/** Référence déterministe : c'est elle qui porte l'idempotence. */
function buildReference(adjustmentId) {
  return `ADJ-${String(adjustmentId).trim().toUpperCase()}`;
}

function getModels() {
  const conn = getTxConn();

  return {
    conn,
    Transaction: require("../models/Transaction")(conn),
    TxWalletBalance: require("../models/TxWalletBalance")(conn),
  };
}

function isDuplicateKeyError(err) {
  return err?.code === 11000 || err?.code === 11001;
}

/* -------------------------------------------------------------------------- */
/* Session Mongo                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Les transactions multi-documents exigent un replica set. Atlas en est un, mais
 * un MongoDB local autonome ne l'est pas : plutôt que de casser le
 * développement, on retombe sur une exécution séquentielle. L'idempotence, elle,
 * ne dépend pas de la session — elle repose sur l'index unique.
 */
function isTransactionUnsupported(err) {
  const message = String(err?.message || "");

  return (
    err?.code === 20 ||
    err?.codeName === "IllegalOperation" ||
    /Transaction numbers are only allowed on a replica set/i.test(message) ||
    /Transactions are not supported/i.test(message)
  );
}

async function runInSession(work) {
  const conn = getTxConn();

  let session = null;

  try {
    session = await conn.startSession();
  } catch (err) {
    logger.warn?.(
      `[TX-CORE][ADJUSTMENT] Session Mongo indisponible, exécution séquentielle : ${err?.message}`
    );
    return work(null);
  }

  try {
    let result = null;

    await session.withTransaction(async () => {
      result = await work(session);
    });

    return result;
  } catch (err) {
    if (isTransactionUnsupported(err)) {
      logger.warn?.(
        "[TX-CORE][ADJUSTMENT] Transactions Mongo non supportées, exécution séquentielle"
      );
      return work(null);
    }

    throw err;
  } finally {
    try {
      session.endSession();
    } catch {}
  }
}

/* -------------------------------------------------------------------------- */
/* Construction de la transaction visible par le client                       */
/* -------------------------------------------------------------------------- */

/**
 * Un ajustement apparaît dans l'historique du client comme un mouvement interne
 * entre la trésorerie des opérations et son portefeuille. Le rendre invisible
 * serait doublement fautif : le client verrait son solde bouger sans
 * explication, et l'opération échapperait à tous les écrans qui lisent
 * `Transaction`.
 */
function buildAdjustmentTransaction({
  adjustmentId,
  reference,
  idempotencyKey,
  userId,
  treasuryUserId,
  direction,
  amount,
  currency,
  reason,
  category,
  requestedByEmail,
  approvedByEmail,
}) {
  const now = new Date();
  const isCredit = direction === "credit";

  const shared = {
    adjustmentId: String(adjustmentId),
    category,
    reason,
    direction,
    requestedByEmail: requestedByEmail || "",
    approvedByEmail: approvedByEmail || "",
    treasurySystemType: TREASURY_SYSTEM_TYPE,
  };

  return {
    reference,
    idempotencyKey,
    internalImported: false,

    flow: "PAYNOVAL_INTERNAL_TRANSFER",
    operationKind: isCredit ? "adjustment_credit" : "adjustment_debit",
    initiatedBy: "admin",
    context: "admin_adjustment",
    contextId: String(adjustmentId),
    provider: "paynoval",

    userId,
    sender: isCredit ? treasuryUserId : userId,
    receiver: isCredit ? userId : treasuryUserId,
    senderName: isCredit ? TREASURY_LABEL : null,
    receiverName: isCredit ? null : TREASURY_LABEL,

    amount,
    localAmount: amount,
    currency,
    currencySource: currency,
    currencyTarget: currency,
    senderCurrencySymbol: currency,
    localCurrencySymbol: currency,

    status: "confirmed",
    confirmedAt: now,
    completedAt: now,
    description: String(reason || "").slice(0, 200),

    requiresSecurityValidation: false,
    securityAttempts: 0,
    securityLockedUntil: null,

    treasuryUserId,
    treasurySystemType: TREASURY_SYSTEM_TYPE,
    treasuryLabel: TREASURY_LABEL,

    metadata: shared,
    meta: shared,

    createdAt: now,
    updatedAt: now,
  };
}

/* -------------------------------------------------------------------------- */
/* Lecture d'un ajustement déjà exécuté                                       */
/* -------------------------------------------------------------------------- */

async function findExecutedAdjustment({ userId, reference }) {
  const { Transaction } = getModels();

  const existing = await Transaction.findOne({ userId, reference })
    .select("_id reference amount currency status metadata createdAt")
    .lean();

  return existing || null;
}

async function readWalletAmount({ userId, currency, session = null }) {
  const { TxWalletBalance } = getModels();

  const query = TxWalletBalance.findOne({ user: userId, currency }).select(
    "amount availableAmount"
  );

  if (session) query.session(session);

  const wallet = await query.lean();

  return {
    amount: Number(wallet?.amount || 0),
    availableAmount: Number(wallet?.availableAmount || 0),
  };
}

/* -------------------------------------------------------------------------- */
/* Exécution                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Exécute un ajustement déjà validé.
 *
 * Renvoie `{ transactionId, reference, balanceBefore, balanceAfter, replayed }`.
 * `replayed: true` signale que le mouvement avait déjà été passé : l'appelant
 * doit alors considérer la demande comme exécutée, surtout pas la rejouer.
 */
async function executeAdminAdjustment(payload = {}) {
  const adjustmentId = normalizeObjectId(payload.adjustmentId, "adjustmentId");
  const userId = normalizeObjectId(payload.userId, "userId");
  const direction = normalizeDirection(payload.direction);
  const currency = normalizeCurrency(payload.currency);
  const amount = normalizeAmount(payload.amount, currency);

  const reason = String(payload.reason || "").trim();
  if (!reason) {
    throw createError(422, "Motif requis : un ajustement sans motif est intraçable");
  }

  const category = String(payload.category || "other").trim();
  if (!KNOWN_CATEGORIES.has(category)) {
    logger.warn?.(
      `[TX-CORE][ADJUSTMENT] Catégorie inconnue « ${category} » — ` +
        "désynchronisation probable avec le backend principal"
    );
  }

  const treasuryUserId = resolveTreasuryUserId();
  const reference = buildReference(adjustmentId);

  const idempotencyKey =
    String(payload.idempotencyKey || "").trim() || `adjustment:${adjustmentId}`;

  const requestedByEmail = String(payload.requestedByEmail || "").trim();
  const approvedByEmail = String(payload.approvedByEmail || "").trim();

  // Rejeu déjà connu : on répond sans rien écrire. Le contrôle ci-dessous est un
  // raccourci de confort ; la vraie garantie reste l'index unique, testé plus bas.
  const alreadyExecuted = await findExecutedAdjustment({ userId, reference });

  if (alreadyExecuted) {
    logger.info?.(
      `[TX-CORE][ADJUSTMENT] Rejeu ignoré pour ${reference} ` +
        `(transaction ${alreadyExecuted._id})`
    );

    const balance = await readWalletAmount({ userId, currency });

    return {
      transactionId: String(alreadyExecuted._id),
      reference,
      balanceBefore: null,
      balanceAfter: balance.amount,
      currency,
      replayed: true,
    };
  }

  const isCredit = direction === "credit";

  try {
    return await runInSession(async (session) => {
      const { Transaction } = getModels();
      const sessionOpts = session ? { session } : {};

      const ledger = require("./ledgerService");

      const balanceBefore = await readWalletAmount({
        userId,
        currency,
        session,
      });

      /* Étape 1 — poser la trace. L'insertion échoue si un autre appel a déjà
         exécuté cet ajustement : c'est la barrière d'idempotence. */
      const [transaction] = await Transaction.create(
        [
          buildAdjustmentTransaction({
            adjustmentId,
            reference,
            idempotencyKey,
            userId,
            treasuryUserId,
            direction,
            amount,
            currency,
            reason,
            category,
            requestedByEmail,
            approvedByEmail,
          }),
        ],
        sessionOpts
      );

      /* Étape 2 — déplacer l'argent. La jambe susceptible d'échouer passe en
         premier (solde insuffisant côté client pour un débit, côté trésorerie
         pour un crédit) : sans session Mongo, cet ordre évite de créditer
         quelqu'un avant de découvrir que la contrepartie est à sec. */
      const { TxWalletBalance } = getModels();

      if (isCredit) {
        await ledger.debitSystemWallet({
          treasuryUserId,
          treasurySystemType: TREASURY_SYSTEM_TYPE,
          amount,
          currency,
          treasuryLabel: TREASURY_LABEL,
          session,
        });

        await TxWalletBalance.credit(userId, currency, amount, sessionOpts);
      } else {
        await TxWalletBalance.debit(userId, currency, amount, sessionOpts);

        await ledger.creditSystemWallet({
          treasuryUserId,
          treasurySystemType: TREASURY_SYSTEM_TYPE,
          amount,
          currency,
          treasuryLabel: TREASURY_LABEL,
          session,
        });
      }

      /* Étape 3 — écritures comptables, posées à la main plutôt que via
         `creditReceiverFunds` / `debitReceiverFunds` : ces primitives typent les
         écritures `USER_CREDIT` et `REVERSAL`, ce qui noierait les ajustements
         parmi les transferts ordinaires. Les deux jambes portent ici le type
         `ADJUSTMENT`, seul moyen d'isoler ces mouvements dans l'analytique. */
      const ledgerMetadata = {
        adjustmentId: String(adjustmentId),
        category,
        reason,
        requestedByEmail,
        approvedByEmail,
        stage: "admin_adjustment",
      };

      // Les deux jambes sont toujours écrites, en sens opposés : c'est ce qui
      // rend le grand livre équilibré et vérifiable poste par poste.
      await ledger.createLedgerEntry({
        transactionId: transaction._id,
        reference,
        userId,
        accountType: "USER_WALLET",
        accountId: `user_wallet:${userId}:${currency}`,
        direction: isCredit ? "CREDIT" : "DEBIT",
        entryType: "ADJUSTMENT",
        amount,
        currency,
        metadata: {
          ...ledgerMetadata,
          counterpartyUserId: String(treasuryUserId),
          counterpartySystemType: TREASURY_SYSTEM_TYPE,
        },
        session,
      });

      await ledger.createLedgerEntry({
        transactionId: transaction._id,
        reference,
        userId: treasuryUserId,
        accountType: "TREASURY",
        accountId: `treasury:${TREASURY_SYSTEM_TYPE}:${treasuryUserId}:${currency}`,
        direction: isCredit ? "DEBIT" : "CREDIT",
        entryType: "ADJUSTMENT",
        amount,
        currency,
        metadata: {
          ...ledgerMetadata,
          counterpartyUserId: String(userId),
        },
        session,
      });

      const balanceAfter = await readWalletAmount({ userId, currency, session });

      logger.info?.(
        `[TX-CORE][ADJUSTMENT] ${direction} ${amount} ${currency} ` +
          `sur ${userId} — ${reference} (transaction ${transaction._id})`
      );

      return {
        transactionId: String(transaction._id),
        reference,
        balanceBefore: balanceBefore.amount,
        balanceAfter: balanceAfter.amount,
        currency,
        treasurySystemType: TREASURY_SYSTEM_TYPE,
        replayed: false,
      };
    });
  } catch (err) {
    /* Course perdue contre un appel concurrent : l'index unique a tranché.
       Le mouvement de l'autre appel fait foi, on ne rejoue rien. */
    if (isDuplicateKeyError(err)) {
      const existing = await findExecutedAdjustment({ userId, reference });
      const balance = await readWalletAmount({ userId, currency });

      logger.warn?.(
        `[TX-CORE][ADJUSTMENT] Exécution concurrente détectée pour ${reference}`
      );

      return {
        transactionId: existing ? String(existing._id) : null,
        reference,
        balanceBefore: null,
        balanceAfter: balance.amount,
        currency,
        replayed: true,
      };
    }

    if (err?.status || err?.statusCode) {
      throw err;
    }

    const message = String(err?.message || "Erreur inconnue");

    // Solde insuffisant : ce n'est pas un défaut du serveur mais un refus
    // métier. Le back-office doit pouvoir l'afficher tel quel à l'opérateur.
    if (/[Ss]olde insuffisant/.test(message)) {
      throw createError(409, message);
    }

    logger.error?.(
      `[TX-CORE][ADJUSTMENT] Échec ${direction} ${amount} ${currency} ` +
        `sur ${userId} (${reference}) : ${message}`
    );

    throw createError(500, message);
  }
}

module.exports = {
  executeAdminAdjustment,
  TREASURY_SYSTEM_TYPE,
  buildReference,
};
