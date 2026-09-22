"use strict";

/**
 * TRÉSORERIE ↔ GRAND LIVRE — le solde d'un compte interne est une PROJECTION
 * =============================================================================
 *
 * Invariant 2 : le grand livre fait foi ; un solde est une projection, jamais la
 * référence. Le contrôle existait pour les portefeuilles clients
 * (`walletLedgerReconciliation.js`) et **manquait pour les comptes internes** —
 * ceux qui encaissent les frais, la marge de change et les commissions.
 *
 * Or ce sont précisément les comptes que personne ne regarde au quotidien : un
 * client voit son solde faux en une journée, une trésorerie peut dériver des
 * mois. Le 2026-09-22, trois d'entre elles étaient d'ailleurs rattachées à des
 * propriétaires qui n'existaient plus (`services/treasuryRegistry.js`).
 *
 * ── Ce que ce module compare ───────────────────────────────────────────────
 *
 * Pour chaque devise d'un compte interne :
 *
 *     solde stocké (`balances[DEVISE]`)   contre   Σ CREDIT − Σ DEBIT
 *                                                  sur `treasury:<TYPE>:<id>:<DEVISE>`
 *
 * Il NE CORRIGE RIEN — comme la réconciliation des transactions, il lit,
 * compare et signale. Une réconciliation qui répare devient une seconde source
 * de mouvements d'argent, déclenchée par un travail de fond que personne ne
 * regarde.
 *
 * Module **pur** : ni base, ni réseau. L'appelant fournit le compte et ses
 * écritures (`scripts/reconcileTreasuries.js`).
 */

const D = require("./decimalMoney");
const { treasuryAccountId } = require("./doubleEntry");

const ANOMALIES = Object.freeze({
  /** Le solde stocké ne vaut pas le cumul des écritures de ce compte. */
  BALANCE_DRIFT: "TREASURY_LEDGER_BALANCE_DRIFT",
  /** Des écritures existent pour une devise absente du solde stocké. */
  MISSING_BALANCE: "TREASURY_LEDGER_MISSING_BALANCE",
  /** Un solde non nul sans AUCUNE écriture : origine inconnue. */
  UNBACKED_BALANCE: "TREASURY_LEDGER_UNBACKED_BALANCE",
  /** Un montant est illisible : verdict INDÉTERMINÉ, jamais « OK ». */
  UNREADABLE_AMOUNT: "TREASURY_LEDGER_UNREADABLE_AMOUNT",
  /** Une écriture vise un compte qui n'est pas celui contrôlé. */
  UNEXPECTED_ACCOUNT: "TREASURY_LEDGER_UNEXPECTED_ACCOUNT",
  /** Statut d'écriture non interprétable par ce contrôle. */
  UNEXPECTED_ENTRY_STATUS: "TREASURY_LEDGER_UNEXPECTED_ENTRY_STATUS",
});

const VERDICTS = Object.freeze({
  OK: "OK",
  DRIFT: "DRIFT",
  INDETERMINATE: "INDETERMINATE",
});

/** Même valeur que `walletLedgerReconciliation` : deux contrôles du même grand
 *  livre ne doivent pas se contredire sur ce qui compte comme un écart. */
const DEFAULT_TOLERANCE = "0.005";
const COUNTED_STATUSES = Object.freeze(["POSTED"]);

const normCurrency = (v) => String(v || "").trim().toUpperCase();
const normId = (v) => String(v || "").trim();

/** Cumul signé d'un jeu d'écritures : CREDIT ajoute, DEBIT retranche. */
function accumulate(entries, { statuses = COUNTED_STATUSES } = {}) {
  let credit = D.zero();
  let debit = D.zero();
  const unreadable = [];
  const unexpectedStatus = [];
  let counted = 0;

  for (const e of entries) {
    const status = String(e?.status || "POSTED").toUpperCase();

    if (!statuses.includes(status)) {
      unexpectedStatus.push({ entryId: e?._id ? String(e._id) : null, status });
      continue;
    }

    const amount = D.parseDecimal(e?.amount);

    if (amount === null) {
      unreadable.push({ entryId: e?._id ? String(e._id) : null, reason: "montant illisible" });
      continue;
    }

    if (String(e?.direction || "").toUpperCase() === "DEBIT") {
      debit = D.add(debit, amount);
    } else {
      credit = D.add(credit, amount);
    }

    counted += 1;
  }

  return { credit, debit, net: D.sub(credit, debit), counted, unreadable, unexpectedStatus };
}

/** Devises à contrôler : celles du solde ET celles vues au grand livre. */
function currenciesOf(wallet, byCurrency) {
  const out = new Set();

  for (const cur of Object.keys(wallet?.balances || {})) {
    const c = normCurrency(cur);
    if (c) out.add(c);
  }

  for (const cur of byCurrency.keys()) out.add(cur);

  return [...out].sort();
}

/**
 * Réconcilie UN compte interne, devise par devise.
 *
 * @param {object} wallet   document `TxSystemBalance` (`userId`, `systemType`, `balances`)
 * @param {Array}  entries  écritures du grand livre visant ce compte
 */
function reconcileTreasury({
  wallet,
  entries = [],
  tolerance = DEFAULT_TOLERANCE,
  statuses = COUNTED_STATUSES,
} = {}) {
  if (!wallet) throw new Error("reconcileTreasury : compte interne requis");

  const userId = normId(wallet.userId ?? wallet.ownerId);
  const systemType = String(wallet.systemType || "").trim().toUpperCase();

  if (!userId) throw new Error("reconcileTreasury : compte sans propriétaire");
  if (!systemType) throw new Error("reconcileTreasury : compte sans type");

  const tol = D.parseDecimal(tolerance);
  if (tol === null) throw new Error(`reconcileTreasury : tolérance illisible (${tolerance})`);

  const byCurrency = new Map();
  const anomalies = [];

  for (const entry of entries) {
    const accountId = String(entry?.accountId || "").trim();
    const currency = normCurrency(entry?.currency);
    const expected = treasuryAccountId({ treasuryUserId: userId, treasurySystemType: systemType, currency });

    if (!currency || accountId !== expected) {
      anomalies.push({
        code: ANOMALIES.UNEXPECTED_ACCOUNT,
        entryId: entry?._id ? String(entry._id) : null,
        accountId: accountId || null,
      });
      continue;
    }

    if (!byCurrency.has(currency)) byCurrency.set(currency, []);
    byCurrency.get(currency).push(entry);
  }

  const parCurrency = [];

  for (const currency of currenciesOf(wallet, byCurrency)) {
    const { credit, debit, net, counted, unreadable, unexpectedStatus } = accumulate(
      byCurrency.get(currency) || [],
      { statuses }
    );

    for (const u of unreadable) {
      anomalies.push({ code: ANOMALIES.UNREADABLE_AMOUNT, currency, ...u });
    }
    for (const u of unexpectedStatus) {
      anomalies.push({ code: ANOMALIES.UNEXPECTED_ENTRY_STATUS, currency, ...u });
    }

    const rawStored = wallet?.balances?.[currency];
    const stored = rawStored === undefined ? null : D.parseDecimal(rawStored);

    if (rawStored !== undefined && stored === null) {
      anomalies.push({ code: ANOMALIES.UNREADABLE_AMOUNT, currency, reason: "solde stocké illisible" });
      parCurrency.push({ currency, verdict: VERDICTS.INDETERMINATE, counted });
      continue;
    }

    if (stored === null) {
      // Des écritures existent, mais la devise n'apparaît pas au solde.
      anomalies.push({ code: ANOMALIES.MISSING_BALANCE, currency, ledger: D.format(net) });
      parCurrency.push({ currency, verdict: VERDICTS.DRIFT, stored: null, ledger: D.format(net), counted });
      continue;
    }

    const ecart = D.sub(stored, net);
    const derive = D.exceeds(D.abs(ecart), tol);

    if (derive) {
      // Un solde non nul sans aucune écriture se nomme autrement : son origine
      // est inconnue, ce n'est pas une dérive de quelques centimes.
      anomalies.push({
        code: counted === 0 && !D.isZero(stored) ? ANOMALIES.UNBACKED_BALANCE : ANOMALIES.BALANCE_DRIFT,
        currency,
        stored: D.format(stored),
        ledger: D.format(net),
        ecart: D.format(ecart),
      });
    }

    parCurrency.push({
      currency,
      verdict: derive ? VERDICTS.DRIFT : VERDICTS.OK,
      stored: D.format(stored),
      ledger: D.format(net),
      credit: D.format(credit),
      debit: D.format(debit),
      ecart: D.format(ecart),
      counted,
    });
  }

  const indetermine = anomalies.some((a) =>
    [ANOMALIES.UNREADABLE_AMOUNT, ANOMALIES.UNEXPECTED_ENTRY_STATUS, ANOMALIES.UNEXPECTED_ACCOUNT].includes(a.code)
  );

  const derive = parCurrency.some((c) => c.verdict === VERDICTS.DRIFT);

  return {
    systemType,
    userId,
    verdict: indetermine ? VERDICTS.INDETERMINATE : derive ? VERDICTS.DRIFT : VERDICTS.OK,
    currencies: parCurrency,
    anomalies,
  };
}

/** Résumé d'un lot de comptes internes, pour le journal et les métriques. */
function summarize(results = []) {
  const summary = { total: results.length, ok: 0, drift: 0, indeterminate: 0, anomalies: 0 };

  for (const r of results) {
    if (r.verdict === VERDICTS.OK) summary.ok += 1;
    else if (r.verdict === VERDICTS.DRIFT) summary.drift += 1;
    else summary.indeterminate += 1;

    summary.anomalies += r.anomalies.length;
  }

  return summary;
}

module.exports = {
  ANOMALIES,
  VERDICTS,
  COUNTED_STATUSES,
  DEFAULT_TOLERANCE,
  accumulate,
  reconcileTreasury,
  summarize,
};
