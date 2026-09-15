"use strict";

/**
 * ============================================================================
 * POSITION D'UN COFFRE — LES SEULES FAÇONS DE LA FAIRE BOUGER
 * ============================================================================
 *
 * Toute écriture de `CagnotteVaultPosition` passe par ce module. Chaque débit
 * est CONDITIONNEL (`balance >= montant` dans le filtre) : c'est la base, pas
 * le code, qui refuse un retrait supérieur à ce qui a été réglé — deux
 * retraits concurrents ne peuvent pas passer tous les deux.
 *
 * Un refus n'est jamais un `null` muet : `diagnose*` relit le document et rend
 * une erreur NOMMÉE (position absente, devise divergente, coffre clos, solde
 * insuffisant, objectif dépassé). Les fonctions de diagnostic sont pures.
 *
 * ⚠️ `openPosition` peut être appelée hors transaction (création idempotente) ;
 * `credit`, `debit` et `close` doivent l'être DANS la session du règlement,
 * avec le grand livre.
 */

const mongoose = require("mongoose");
const { roundMoney, decimalsForCurrency } = require("../pricing/pricingEngine");

function positionError(status, code, message, details) {
  const err = new Error(message);
  err.status = status;
  err.statusCode = status;
  err.code = code;
  if (details) err.details = details;
  return err;
}

function upper(v) {
  return String(v ?? "").trim().toUpperCase();
}

function toDec(amount, currency, { negative = false } = {}) {
  const r = roundMoney(Number(amount), currency);

  if (!Number.isFinite(r) || r < 0) {
    throw positionError(
      500,
      "VAULT_POSITION_INVALID_AMOUNT",
      `Montant de position illisible (${amount} ${currency}).`
    );
  }

  const d = decimalsForCurrency(currency);
  return mongoose.Types.Decimal128.fromString((negative ? -r : r).toFixed(d));
}

function decToNumber(v) {
  if (v === null || v === undefined) return 0;
  const n = Number(typeof v === "object" && typeof v.toString === "function" ? v.toString() : v);
  return Number.isFinite(n) ? n : 0;
}

function positionToJSON(doc) {
  if (!doc) return null;
  const p = typeof doc.toObject === "function" ? doc.toObject() : doc;

  return {
    vaultId: p.vaultId,
    cagnotteId: p.cagnotteId,
    currency: p.currency,
    balance: decToNumber(p.balance),
    collected: decToNumber(p.collected),
    credited: decToNumber(p.credited),
    refunded: decToNumber(p.refunded),
    withdrawn: decToNumber(p.withdrawn),
    closureFees: decToNumber(p.closureFees),
    closedAt: p.closedAt || null,
    lastMovementAt: p.lastMovementAt || null,
    origin: p.origin || "live",
  };
}

/** PURE — la position appartient-elle bien à ce coffre, dans cette devise ? */
function assertPositionIdentity(doc, { cagnotteId = null, currency = null } = {}) {
  if (!doc) {
    throw positionError(
      404,
      "VAULT_POSITION_MISSING",
      "Aucune position Tx-Core pour ce coffre. Un coffre sans position ne peut " +
        "être ni débité ni crédité : exécuter le rattrapage des positions."
    );
  }

  if (currency && upper(doc.currency) !== upper(currency)) {
    throw positionError(
      409,
      "VAULT_CURRENCY_MISMATCH",
      `Le coffre est tenu en ${doc.currency}, l'opération présente ${upper(currency)}. ` +
        "La devise d'un coffre est immuable : aucune opération ne la re-libelle.",
      { positionCurrency: doc.currency, requestedCurrency: upper(currency) }
    );
  }

  if (cagnotteId && String(doc.cagnotteId) !== String(cagnotteId)) {
    throw positionError(
      409,
      "VAULT_CAGNOTTE_MISMATCH",
      "Ce coffre appartient à une autre cagnotte."
    );
  }

  return doc;
}

/** PURE — pourquoi un crédit conditionnel n'a rien trouvé à mettre à jour. */
function diagnoseCreditRefusal(doc, { currency, amount, goalCap = null, allowClosed = false }) {
  assertPositionIdentity(doc, { currency });

  if (!allowClosed && doc.closedAt) {
    return positionError(409, "VAULT_CLOSED", "La cagnotte est clôturée : elle ne reçoit plus de participation.");
  }

  if (goalCap != null) {
    const collected = decToNumber(doc.collected);
    const remaining = Math.max(0, roundMoney(Number(goalCap) - collected, doc.currency));

    if (roundMoney(collected + Number(amount), doc.currency) > Number(goalCap)) {
      return positionError(
        409,
        remaining > 0 ? "GOAL_EXCEEDED" : "GOAL_REACHED",
        remaining > 0
          ? `Cette participation dépasserait l'objectif. Restant : ${remaining} ${doc.currency}.`
          : "L'objectif de cette cagnotte est atteint.",
        { remaining, currency: doc.currency }
      );
    }
  }

  return positionError(409, "VAULT_POSITION_CONFLICT", "La position du coffre a changé pendant l'opération. Réessayer.");
}

/** PURE — pourquoi un débit conditionnel n'a rien trouvé à mettre à jour. */
function diagnoseDebitRefusal(doc, { currency, amount, requireClosed = false, forbidClosed = false }) {
  assertPositionIdentity(doc, { currency });

  if (requireClosed && !doc.closedAt) {
    return positionError(
      409,
      "VAULT_NOT_CLOSED",
      "Retrait impossible avant la clôture : les frais de clôture doivent d'abord être réglés."
    );
  }

  if (forbidClosed && doc.closedAt) {
    return positionError(409, "VAULT_CLOSED", "La cagnotte est clôturée : opération impossible.");
  }

  const available = decToNumber(doc.balance);

  if (available + 1e-9 < roundMoney(Number(amount), doc.currency)) {
    return positionError(
      409,
      "VAULT_INSUFFICIENT_BALANCE",
      `Solde du coffre insuffisant : disponible ${available} ${doc.currency}, demandé ${amount}.`,
      { available, currency: doc.currency }
    );
  }

  return positionError(409, "VAULT_POSITION_CONFLICT", "La position du coffre a changé pendant l'opération. Réessayer.");
}

/**
 * Ouvre la position si elle n'existe pas, et VÉRIFIE qu'elle correspond.
 * Idempotent. À appeler HORS transaction : l'upsert concurrent sur l'index
 * unique est rejoué par le serveur, alors qu'un conflit de clé dans une
 * transaction l'annulerait entière.
 */
async function openPosition({ Model, vaultId, cagnotteId, currency }) {
  const cur = upper(currency);
  const vId = String(vaultId || "").trim();
  const cId = String(cagnotteId || "").trim();

  if (!vId || !cId || !/^[A-Z]{3}$/.test(cur)) {
    throw positionError(400, "VAULT_POSITION_INVALID", "vaultId, cagnotteId et devise ISO sont requis.");
  }

  const doc = await Model.findOneAndUpdate(
    { vaultId: vId },
    { $setOnInsert: { vaultId: vId, cagnotteId: cId, currency: cur, origin: "live" } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return assertPositionIdentity(doc, { cagnotteId: cId, currency: cur });
}

async function getPosition({ Model, vaultId, session = null }) {
  const q = Model.findOne({ vaultId: String(vaultId || "").trim() });
  if (session) q.session(session);
  return q;
}

async function creditPosition({
  Model,
  vaultId,
  currency,
  amount,
  goalCap = null,
  allowClosed = false,
  session,
}) {
  const cur = upper(currency);
  const inc = toDec(amount, cur);
  const filter = { vaultId: String(vaultId), currency: cur };

  if (!allowClosed) filter.closedAt = null;

  if (goalCap != null) {
    filter.$expr = { $lte: [{ $add: ["$collected", inc] }, toDec(goalCap, cur)] };
  }

  const updated = await Model.findOneAndUpdate(
    filter,
    {
      $inc: { balance: inc, collected: inc, credited: inc },
      $set: { lastMovementAt: new Date() },
    },
    { new: true, session }
  );

  if (!updated) {
    const doc = await getPosition({ Model, vaultId, session });
    throw diagnoseCreditRefusal(doc, { currency: cur, amount, goalCap, allowClosed });
  }

  return updated;
}

const DEBIT_KINDS = Object.freeze({
  WITHDRAWAL: "withdrawn",
  CLOSURE_FEE: "closureFees",
  REFUND: "refunded",
});

async function debitPosition({
  Model,
  vaultId,
  currency,
  amount,
  kind,
  requireClosed = false,
  forbidClosed = false,
  session,
}) {
  const cur = upper(currency);
  const counter = DEBIT_KINDS[kind];

  if (!counter) {
    throw positionError(500, "VAULT_POSITION_INVALID", `Nature de débit inconnue : ${kind}.`);
  }

  const pos = toDec(amount, cur);
  const neg = toDec(amount, cur, { negative: true });

  const filter = { vaultId: String(vaultId), currency: cur, balance: { $gte: pos } };
  if (requireClosed) filter.closedAt = { $ne: null };
  if (forbidClosed) filter.closedAt = null;

  const inc = { balance: neg, [counter]: pos };

  // Un remboursement retire aussi la participation du « collecté ».
  if (kind === "REFUND") {
    inc.collected = neg;
    filter.collected = { $gte: pos };
  }

  const updated = await Model.findOneAndUpdate(
    filter,
    { $inc: inc, $set: { lastMovementAt: new Date() } },
    { new: true, session }
  );

  if (!updated) {
    const doc = await getPosition({ Model, vaultId, session });
    throw diagnoseDebitRefusal(doc, { currency: cur, amount, requireClosed, forbidClosed });
  }

  return updated;
}

/**
 * Inverse EXACT de `debitPosition({ kind: "REFUND" })` — pour un remboursement
 * invité dont le versement a été refusé par l'opérateur (2026-09-15).
 *
 * Solde et « collecté » rétablis, compteur de remboursements diminué. Pas de
 * garde de clôture : l'argent n'a jamais quitté PayNoval, il revient au coffre
 * même clos. La garde porte sur le compteur : on ne rend pas plus qu'on n'a
 * débité.
 */
async function reverseRefundDebit({ Model, vaultId, currency, amount, session }) {
  const cur = upper(currency);
  const counter = DEBIT_KINDS.REFUND;
  const pos = toDec(amount, cur);
  const neg = toDec(amount, cur, { negative: true });

  const updated = await Model.findOneAndUpdate(
    { vaultId: String(vaultId), currency: cur, [counter]: { $gte: pos } },
    { $inc: { balance: pos, collected: pos, [counter]: neg }, $set: { lastMovementAt: new Date() } },
    { new: true, session }
  );

  if (!updated) {
    throw positionError(
      409,
      "VAULT_POSITION_REVERSAL_REFUSED",
      "Contre-passation du remboursement impossible : position introuvable, devise différente ou compteur incohérent."
    );
  }

  return updated;
}

/** Idempotent : une position déjà close est rendue telle quelle. */
async function closePosition({ Model, vaultId, session }) {
  const now = new Date();

  const updated = await Model.findOneAndUpdate(
    { vaultId: String(vaultId), closedAt: null },
    { $set: { closedAt: now, lastMovementAt: now } },
    { new: true, session }
  );

  if (updated) return updated;

  const doc = await getPosition({ Model, vaultId, session });
  return assertPositionIdentity(doc);
}

module.exports = {
  openPosition,
  getPosition,
  creditPosition,
  debitPosition,
  reverseRefundDebit,
  closePosition,
  positionToJSON,
  assertPositionIdentity,
  diagnoseCreditRefusal,
  diagnoseDebitRefusal,
  decToNumber,
  toDec,
  positionError,
  DEBIT_KINDS,
};
