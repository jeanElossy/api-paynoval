"use strict";

/**
 * ============================================================================
 * RÉCONCILIATION DES FLUX FINANCIERS — TOUS LES FLUX, PAS SEULEMENT LE PARRAINAGE
 * ============================================================================
 *
 * POURQUOI CE SERVICE EXISTE
 * --------------------------
 * Les index uniques, les transactions et les clés d'idempotence empêchent les
 * incohérences **connues**. La réconciliation, elle, cherche celles qu'on n'a
 * pas prévues. C'est la différence entre se protéger et savoir. Stripe et Wise
 * réconcilient en continu, précisément parce qu'aucun garde-fou n'attrape tout.
 *
 * RÈGLE ABSOLUE : CE SERVICE NE CORRIGE RIEN
 * ------------------------------------------
 * Il lit, il compare, il signale. Jamais une écriture. Une réconciliation qui
 * répare est une seconde source de mouvements d'argent — donc un second risque
 * de double crédit, déclenché par un travail de fond que personne ne regarde.
 * Ce qui est signalé ici se corrige par le chemin normal, ou à la main, en
 * connaissance de cause.
 *
 * LES INVARIANTS VÉRIFIÉS
 * -----------------------
 *   1. `amount === availableAmount + reservedAmount` sur chaque portefeuille.
 *      Invariant local : une dérive signale un défaut dans les primitives de
 *      solde, pas dans un flux particulier.
 *   2. Un mouvement déclaré capturé doit avoir son écriture au grand livre.
 *   3. Un bénéficiaire déclaré crédité doit avoir son écriture de crédit.
 *   4. Un même mouvement ne doit pas produire deux fois la même écriture.
 *   5. Une écriture ne doit pas référencer une transaction inexistante.
 *   6. Des fonds réservés ne doivent pas rester bloqués indéfiniment.
 */

const { getTxConn } = require("../../config/db");

let logger = console;
try {
  logger = require("../../logger");
} catch {}

const ANOMALIES = Object.freeze({
  WALLET_IMBALANCE: "WALLET_IMBALANCE",
  MISSING_LEDGER_FOR_CAPTURE: "MISSING_LEDGER_FOR_CAPTURE",
  MISSING_LEDGER_FOR_CREDIT: "MISSING_LEDGER_FOR_CREDIT",
  DUPLICATE_LEDGER_ENTRY: "DUPLICATE_LEDGER_ENTRY",
  ORPHAN_LEDGER_ENTRY: "ORPHAN_LEDGER_ENTRY",
  STUCK_RESERVATION: "STUCK_RESERVATION",
});

/** Au-delà, une réservation qui n'a pas abouti est suspecte. */
const STUCK_RESERVATION_MS = Number(
  process.env.RECONCILE_STUCK_RESERVATION_MS || 24 * 60 * 60 * 1000
);

/** Tolérance d'arrondi : on compare de l'argent, pas des flottants. */
const EPSILON = 0.0001;

function decimalToNumber(value) {
  if (value === null || value === undefined) return 0;
  const n = Number(value?.toString?.() ?? value);
  return Number.isFinite(n) ? n : 0;
}

function differs(a, b) {
  return Math.abs(decimalToNumber(a) - decimalToNumber(b)) > EPSILON;
}

function model(name) {
  const conn = getTxConn();
  if (!conn.models[name]) throw new Error(`Modèle ${name} non enregistré`);
  return conn.models[name];
}

/* -------------------------------------------------------------------------- */
/* 1. Cohérence interne des portefeuilles                                     */
/* -------------------------------------------------------------------------- */

/**
 * `amount` doit toujours valoir `availableAmount + reservedAmount`.
 *
 * C'est l'invariant le plus élémentaire du portefeuille, et le plus révélateur :
 * s'il casse, ce n'est pas un flux qui est en cause mais une primitive de solde
 * — donc potentiellement TOUS les flux.
 */
async function checkWalletBalances({ limit }) {
  const TxWalletBalance = model("TxWalletBalance");
  const anomalies = [];

  const wallets = await TxWalletBalance.find({})
    .select("_id user currency amount availableAmount reservedAmount")
    .limit(limit)
    .lean();

  for (const w of wallets) {
    const total = decimalToNumber(w.availableAmount) + decimalToNumber(w.reservedAmount);

    if (differs(w.amount, total)) {
      anomalies.push({
        type: ANOMALIES.WALLET_IMBALANCE,
        walletId: String(w._id),
        userId: String(w.user),
        currency: w.currency,
        amount: decimalToNumber(w.amount),
        available: decimalToNumber(w.availableAmount),
        reserved: decimalToNumber(w.reservedAmount),
        expected: total,
        detail: "amount ≠ availableAmount + reservedAmount",
      });
    }
  }

  return { checked: wallets.length, anomalies };
}

/* -------------------------------------------------------------------------- */
/* 2 à 4. Transactions et leurs écritures                                     */
/* -------------------------------------------------------------------------- */

/**
 * Les transactions du parcours sandbox (revue Apple) ne produisent
 * DÉLIBÉRÉMENT aucune écriture comptable : elles n'engagent aucun argent réel.
 * Les signaler serait crier au loup — et une réconciliation qui crie au loup
 * finit par ne plus être lue. On les exclut donc à la source.
 *
 * Le prédicat reprend celui de `confirmTransaction.isSandboxTx`, dans sa forme
 * requêtable.
 */
const NOT_SANDBOX = Object.freeze({
  $and: [
    { isSandbox: { $ne: true } },
    { provider: { $nin: ["sandbox", "SANDBOX", "Sandbox"] } },
    { channel: { $nin: ["sandbox", "SANDBOX", "Sandbox"] } },
    { "metadata.source": { $ne: "apple_review_sandbox" } },
    { "meta.source": { $ne: "apple_review_sandbox" } },
    { "metadata.sandbox": { $ne: true } },
    { "meta.sandbox": { $ne: true } },
    { reference: { $not: /^SBX-/ } },
  ],
});

async function checkTransactionLedger({ sinceHours, limit }) {
  const Transaction = model("Transaction");
  const LedgerEntry = model("LedgerEntry");

  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
  const anomalies = [];

  const transactions = await Transaction.find({
    createdAt: { $gte: since },
    $or: [{ fundsCaptured: true }, { beneficiaryCredited: true }],
    ...NOT_SANDBOX,
  })
    .select(
      "_id reference status flow fundsCaptured beneficiaryCredited " +
        "fundsCapturedAt beneficiaryCreditedAt createdAt"
    )
    .limit(limit)
    .lean();

  if (!transactions.length) return { checked: 0, anomalies };

  const ids = transactions.map((t) => t._id);

  const entries = await LedgerEntry.find({ transactionId: { $in: ids } })
    .select("_id transactionId direction entryType amount currency accountId")
    .lean();

  /** Index : transactionId → écritures. */
  const byTx = new Map();
  for (const e of entries) {
    const key = String(e.transactionId);
    if (!byTx.has(key)) byTx.set(key, []);
    byTx.get(key).push(e);
  }

  for (const tx of transactions) {
    const own = byTx.get(String(tx._id)) || [];

    if (tx.fundsCaptured && !own.length) {
      anomalies.push({
        type: ANOMALIES.MISSING_LEDGER_FOR_CAPTURE,
        transactionId: String(tx._id),
        reference: tx.reference || null,
        flow: tx.flow || null,
        at: tx.fundsCapturedAt || tx.createdAt,
        detail: "fonds déclarés capturés, aucune écriture au grand livre",
      });
    }

    if (tx.beneficiaryCredited && !own.some((e) => e.direction === "CREDIT")) {
      anomalies.push({
        type: ANOMALIES.MISSING_LEDGER_FOR_CREDIT,
        transactionId: String(tx._id),
        reference: tx.reference || null,
        flow: tx.flow || null,
        at: tx.beneficiaryCreditedAt || tx.createdAt,
        detail: "bénéficiaire déclaré crédité, aucune écriture de crédit",
      });
    }

    /**
     * Deux écritures identiques (même compte, même sens, même type) pour un même
     * mouvement : c'est la signature d'un rejeu qui a franchi les gardes.
     */
    const seen = new Map();

    for (const e of own) {
      const key = `${e.accountId}|${e.direction}|${e.entryType}`;
      seen.set(key, (seen.get(key) || 0) + 1);
    }

    for (const [key, count] of seen) {
      if (count > 1) {
        anomalies.push({
          type: ANOMALIES.DUPLICATE_LEDGER_ENTRY,
          transactionId: String(tx._id),
          reference: tx.reference || null,
          signature: key,
          count,
          detail: "écriture comptable produite plusieurs fois pour un même mouvement",
        });
      }
    }
  }

  return { checked: transactions.length, anomalies };
}

/* -------------------------------------------------------------------------- */
/* 5. Écritures orphelines                                                    */
/* -------------------------------------------------------------------------- */

async function checkOrphanLedgerEntries({ sinceHours, limit }) {
  const Transaction = model("Transaction");
  const LedgerEntry = model("LedgerEntry");

  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
  const anomalies = [];

  const entries = await LedgerEntry.find({
    createdAt: { $gte: since },
    transactionId: { $ne: null },
  })
    .select("_id transactionId reference entryType amount currency")
    .limit(limit)
    .lean();

  if (!entries.length) return { checked: 0, anomalies };

  const ids = [...new Set(entries.map((e) => String(e.transactionId)))];

  const existing = await Transaction.find({ _id: { $in: ids } })
    .select("_id")
    .lean();

  const known = new Set(existing.map((t) => String(t._id)));

  for (const e of entries) {
    if (!known.has(String(e.transactionId))) {
      anomalies.push({
        type: ANOMALIES.ORPHAN_LEDGER_ENTRY,
        ledgerEntryId: String(e._id),
        transactionId: String(e.transactionId),
        reference: e.reference || null,
        entryType: e.entryType,
        amount: decimalToNumber(e.amount),
        currency: e.currency,
        detail: "écriture comptable rattachée à une transaction inexistante",
      });
    }
  }

  return { checked: entries.length, anomalies };
}

/* -------------------------------------------------------------------------- */
/* 6. Réservations bloquées                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Des fonds réservés que rien ne libère, c'est de l'argent que l'utilisateur
 * voit disparaître de son solde disponible sans explication. Le worker
 * d'annulation automatique doit les rendre ; s'il ne l'a pas fait passé le
 * délai, il faut le savoir.
 */
async function checkStuckReservations({ limit }) {
  const Transaction = model("Transaction");

  const before = new Date(Date.now() - STUCK_RESERVATION_MS);
  const anomalies = [];

  const stuck = await Transaction.find({
    fundsReserved: true,
    fundsCaptured: { $ne: true },
    reserveReleased: { $ne: true },
    fundsReservedAt: { $lt: before },
    status: { $nin: ["cancelled", "failed", "completed", "refunded"] },
    ...NOT_SANDBOX,
  })
    .select("_id reference status flow fundsReservedAt amount currency")
    .limit(limit)
    .lean();

  for (const tx of stuck) {
    anomalies.push({
      type: ANOMALIES.STUCK_RESERVATION,
      transactionId: String(tx._id),
      reference: tx.reference || null,
      status: tx.status,
      flow: tx.flow || null,
      reservedAt: tx.fundsReservedAt,
      amount: decimalToNumber(tx.amount),
      currency: tx.currency || null,
      detail: "fonds réservés ni capturés ni libérés au-delà du délai",
    });
  }

  return { checked: stuck.length, anomalies };
}

/* -------------------------------------------------------------------------- */

/**
 * Passe complète. Ne modifie RIEN.
 *
 * @returns {Promise<{healthy: boolean, checked: object, anomalies: Array}>}
 */
async function reconcileTransactions({ sinceHours = 48, limit = 5000 } = {}) {
  const [wallets, ledger, orphans, reservations] = await Promise.all([
    checkWalletBalances({ limit }),
    checkTransactionLedger({ sinceHours, limit }),
    checkOrphanLedgerEntries({ sinceHours, limit }),
    checkStuckReservations({ limit }),
  ]);

  const anomalies = [
    ...wallets.anomalies,
    ...ledger.anomalies,
    ...orphans.anomalies,
    ...reservations.anomalies,
  ];

  const report = {
    healthy: anomalies.length === 0,
    window: { sinceHours, since: new Date(Date.now() - sinceHours * 3600 * 1000) },
    checked: {
      wallets: wallets.checked,
      transactions: ledger.checked,
      ledgerEntries: orphans.checked,
      reservations: reservations.checked,
    },
    anomalies,
  };

  if (report.healthy) {
    logger.info?.("[RECONCILE][TX] aucun écart", { checked: report.checked });
  } else {
    logger.warn?.("[RECONCILE][TX] écarts détectés", {
      count: anomalies.length,
      types: [...new Set(anomalies.map((a) => a.type))],
    });
  }

  return report;
}

module.exports = {
  reconcileTransactions,
  NOT_SANDBOX,
  checkWalletBalances,
  checkTransactionLedger,
  checkOrphanLedgerEntries,
  checkStuckReservations,
  ANOMALIES,
};
