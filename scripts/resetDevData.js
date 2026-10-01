#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * ============================================================================
 * REMISE À ZÉRO DES DONNÉES DE DÉVELOPPEMENT — « Delete all test data »
 * ============================================================================
 *
 * Le bouton « Delete all test data » de Stripe, pour PayNoval en développement :
 * efface toute l'ACTIVITÉ financière (transactions, grand livre, soldes,
 * cagnottes, coffres, notifications…) et garde les COMPTES et la CONFIGURATION.
 *
 * Ce qui est PROTÉGÉ :
 *   - les comptes système (`isSystem`, `*_TREASURY_USER_ID`) et leurs soldes —
 *     trésoreries (`txsystembalances`) et portefeuilles ;
 *   - les comptes de revue Apple (`isSandbox`, `isReviewerAccount`,
 *     `APPLE_REVIEW_EMAIL`) avec leur portefeuille, leurs transactions et les
 *     écritures qui s'y rattachent.
 *
 * LE GRAND LIVRE RESTE ÉQUILIBRÉ (invariant A.2). Garder un solde dont les
 * écritures d'origine disparaissent rendrait le solde orphelin : la
 * réconciliation le signalerait aussitôt. Chaque solde conservé reçoit donc UNE
 * écriture d'ouverture (`OPENING_BALANCE`, contrepartie
 * `system_clearing:OPENING_BALANCE:<DEVISE>`) égale à l'écart restant — le
 * même mécanisme que `postTreasuryOpeningBalances.js`.
 *
 * ⚠️ CET OUTIL EFFACE DES ÉCRITURES DU GRAND LIVRE. L'invariant A.4 l'interdit
 * en exploitation, et les gardes de `LedgerEntry` le refusent : l'outil passe
 * donc par le pilote natif, et il ne s'exécute QUE sur des données de
 * développement — garde-fous ci-dessous, tous bloquants.
 *
 * USAGE
 *   node scripts/resetDevData.js --target=test             # simulation : n'écrit rien
 *   node scripts/resetDevData.js --target=legacy           # simulation, bases sans suffixe
 *   node scripts/resetDevData.js --target=test --apply --confirm=<baseTx>,<baseUsers>
 *
 * GARDE-FOUS
 *   - refus si NODE_ENV=production ;
 *   - `--target=test` : les deux bases DOIVENT finir par `-test` ;
 *     `--target=legacy` : les mêmes bases SANS le suffixe (anciennes bases de
 *     développement, conservées lors du renommage du 2026-09-03) ;
 *   - par défaut, SIMULATION : on compte, on n'efface rien ;
 *   - `--apply` exige `--confirm=` avec les deux noms de base exacts.
 *
 * Les URI viennent du `.env` de Tx-Core ; seul le NOM de la base change selon
 * la cible. Aucune variable d'environnement n'est modifiée sur disque, et
 * aucune URI n'est affichée (elles portent le mot de passe).
 */

const path = require("path");
const fs = require("fs");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const args = process.argv.slice(2);
const argValue = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const TARGET = argValue("target");
const APPLY = args.includes("--apply");
const CONFIRM = String(argValue("confirm") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* Cible : seul le nom de la base change                                      */
/* -------------------------------------------------------------------------- */

const URI_RE = /^(mongodb(?:\+srv)?:\/\/[^/]+)\/([^?]*)(\?.*)?$/;

function retarget(uri, target) {
  const m = URI_RE.exec(String(uri || "").trim());
  if (!m) return null;

  const current = decodeURIComponent(m[2] || "");
  const base = current.replace(/-test$/, "");
  if (!base) return null;

  const dbName = target === "test" ? `${base}-test` : base;
  return { uri: `${m[1]}/${encodeURIComponent(dbName)}${m[3] || ""}`, dbName };
}

if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
  fail("NODE_ENV=production — cet outil ne s'exécute jamais en production.");
}
if (!["test", "legacy"].includes(TARGET)) {
  fail("Préciser --target=test (bases -test) ou --target=legacy (bases sans suffixe).");
}

const txTarget = retarget(process.env.MONGO_URI_TRANSACTIONS, TARGET);
const usersTarget = retarget(process.env.MONGO_URI_USERS, TARGET);

if (!txTarget || !usersTarget) {
  fail("MONGO_URI_TRANSACTIONS / MONGO_URI_USERS absentes ou illisibles dans le .env de Tx-Core.");
}
if (TARGET === "test" && !(txTarget.dbName.endsWith("-test") && usersTarget.dbName.endsWith("-test"))) {
  fail("Cible test : les deux bases doivent finir par -test.");
}
if (txTarget.dbName === usersTarget.dbName) {
  fail("Les bases transactions et utilisateurs portent le même nom : configuration inattendue, arrêt.");
}
if (APPLY) {
  const expected = [txTarget.dbName, usersTarget.dbName];
  const ok = expected.every((n) => CONFIRM.includes(n)) && CONFIRM.length === expected.length;
  if (!ok) {
    fail(`--apply exige --confirm=${expected.join(",")} (les deux noms de base, exactement).`);
  }
}

/**
 * Les URI de CE processus pointent sur la cible avant le chargement de la
 * configuration : `connectTransactionsDB`, `ledgerService` et la
 * réconciliation travaillent alors sur les bases choisies, avec leur code réel.
 * Rien n'est écrit sur disque.
 */
process.env.MONGO_URI_TRANSACTIONS = txTarget.uri;
process.env.MONGO_URI_USERS = usersTarget.uri;

const mongoose = require("mongoose");
const crypto = require("crypto");
const { connectTransactionsDB, getTxConn, getUsersConn } = require("../src/config/db");
const {
  userWalletAccountId,
  systemReserveAccountId,
  openingBalanceClearingAccountId,
  treasuryAccountId,
} = require("../src/services/ledger/doubleEntry");
const { reconcileTreasury } = require("../src/services/ledger/treasuryLedgerReconciliation");
const D = require("../src/services/ledger/decimalMoney");

/* -------------------------------------------------------------------------- */
/* Classement des collections                                                 */
/* -------------------------------------------------------------------------- */

/** Comptes, appareils et configuration : jamais touchés. */
const KEEP = new Set([
  "users",
  "devices",
  "cron_locks",
  "aml_blacklist_entries",
  "trusted_deposit_numbers",
  "txsystembalances",
]);

/** Effacées en entier : elles ne décrivent que l'activité effacée. */
const WIPE_ALL = new Set(["reconciliation_runs"]);

/** Activité : effacée, sauf ce qui se rattache à un compte Apple. */
const WIPE = new Set([
  // base transactions
  "outboxes",
  "notifications",
  "idempotency_records",
  "provider_webhook_events",
  "processed_events",
  "domain_events",
  "referralpayouts",
  "referralclawbacks",
  "transactionreviewcases",
  "tx_refund_requests",
  "amllogs",
  "tx_collection_intents",
  // base principale
  "balances",
  "balancehistories",
  "txmirroroutboxes",
  "cagnottes",
  "vaults",
  "vaultwithdrawallogs",
  "notificationlogs",
  "idempotencykeys",
  "adminadjustments",
  "referralrewards",
  "paynovalcodes",
]);
const WIPE_PREFIXES = ["tx_cagnotte_", "cagnotte_"];

/** Traitées à part : leur conservation dépend de liens précis. */
const SPECIAL = new Set(["transactions", "ledgerentries", "tx_wallet_balances"]);

const OWNER_FIELDS = [
  "userId",
  "user",
  "owner",
  "ownerId",
  "createdBy",
  "sender",
  "receiver",
  "initiatedBy",
  "payer",
  "recipient",
  "referee",
  "requestedBy",
];

function classify(name) {
  if (name.startsWith("system.")) return "KEEP";
  if (KEEP.has(name)) return "KEEP";
  if (WIPE_ALL.has(name)) return "WIPE_ALL";
  if (SPECIAL.has(name)) return "SPECIAL";
  if (WIPE.has(name) || WIPE_PREFIXES.some((p) => name.startsWith(p))) return "WIPE";
  return "UNCLASSIFIED";
}

/** Un identifiant sous ses deux formes stockées : texte et ObjectId. */
function idForms(ids) {
  const out = [];
  for (const raw of ids) {
    const s = String(raw);
    out.push(s);
    if (mongoose.Types.ObjectId.isValid(s) && String(new mongoose.Types.ObjectId(s)) === s) {
      out.push(new mongoose.Types.ObjectId(s));
    }
  }
  return out;
}

const ownedBy = (forms) => OWNER_FIELDS.map((f) => ({ [f]: { $in: forms } }));

/* -------------------------------------------------------------------------- */
/* Comptes protégés                                                           */
/* -------------------------------------------------------------------------- */

const TREASURY_ENV = [
  "FEES_TREASURY_USER_ID",
  "FX_MARGIN_TREASURY_USER_ID",
  "REFERRAL_TREASURY_USER_ID",
  "OPERATIONS_TREASURY_USER_ID",
  "CAGNOTTE_FEES_TREASURY_USER_ID",
];

async function protectedAccounts(usersDb, txDb) {
  const appleEmail = String(process.env.APPLE_REVIEW_EMAIL || "reviewer@paynoval.com")
    .trim()
    .toLowerCase();

  const users = await usersDb
    .collection("users")
    .find(
      {
        $or: [
          { isSystem: true },
          { isSandbox: true },
          { isReviewerAccount: true },
          { email: appleEmail },
        ],
      },
      { projection: { _id: 1, isSystem: 1, isSandbox: 1, isReviewerAccount: 1, email: 1 } }
    )
    .toArray();

  const apple = new Set();
  const system = new Set();

  for (const u of users) {
    const id = String(u._id);
    const isApple =
      u.isSandbox === true ||
      u.isReviewerAccount === true ||
      String(u.email || "").toLowerCase() === appleEmail;
    if (isApple) apple.add(id);
    if (u.isSystem === true) system.add(id);
  }

  for (const key of TREASURY_ENV) {
    const v = String(process.env[key] || "").trim();
    if (v) system.add(v);
  }

  const treasuries = await txDb
    .collection("txsystembalances")
    .find({}, { projection: { userId: 1 } })
    .toArray();
  for (const t of treasuries) if (t.userId) system.add(String(t.userId));

  return { apple: [...apple], system: [...system] };
}

/* -------------------------------------------------------------------------- */
/* Plan                                                                       */
/* -------------------------------------------------------------------------- */

async function buildPlan({ txDb, usersDb, apple, system }) {
  const appleForms = idForms(apple);
  const walletKeepForms = idForms([...apple, ...system]);

  // 1. Transactions conservées : bac à sable, ou un compte Apple partie prenante.
  const txKeep = {
    $or: [{ isSandbox: true }, ...ownedBy(appleForms)],
  };
  const keptTx = await txDb
    .collection("transactions")
    .find(txKeep, { projection: { _id: 1 } })
    .toArray();

  // 2. Écritures conservées : celles d'une transaction conservée, et TOUTES les
  //    jambes de toute opération qui touche un compte Apple (sinon on garderait
  //    une jambe sans sa contrepartie, et la balance de vérification tomberait).
  const appleLedgerTx = appleForms.length
    ? await txDb.collection("ledgerentries").distinct("transactionId", {
        userId: { $in: appleForms },
      })
    : [];

  const keptTxIds = [...keptTx.map((t) => t._id), ...appleLedgerTx];
  const keptTxForms = idForms(keptTxIds.map(String));

  // 3. Cagnottes conservées (celles d'un compte Apple) et leurs dépendances.
  const keptCagnottes = (await usersDb.listCollections({ name: "cagnottes" }).toArray()).length
    ? await usersDb
        .collection("cagnottes")
        .find({ $or: ownedBy(appleForms) }, { projection: { _id: 1 } })
        .toArray()
    : [];
  const keptCagForms = idForms(keptCagnottes.map((c) => String(c._id)));

  const genericKeep = [
    ...ownedBy(appleForms),
    { transactionId: { $in: keptTxForms } },
    { cagnotteId: { $in: keptCagForms } },
    { cagnotte: { $in: keptCagForms } },
  ];

  const deleteFilterFor = (name) => {
    switch (name) {
      case "transactions":
        return { $nor: txKeep.$or };
      case "ledgerentries":
        return { $nor: [{ transactionId: { $in: keptTxForms } }, { userId: { $in: appleForms } }] };
      case "tx_wallet_balances":
        return { $nor: [{ isSandbox: true }, { user: { $in: walletKeepForms } }] };
      default:
        return { $nor: genericKeep };
    }
  };

  const plan = [];

  for (const [label, db] of [
    ["transactions", txDb],
    ["principale", usersDb],
  ]) {
    const collections = (await db.listCollections().toArray()).map((c) => c.name).sort();

    for (const name of collections) {
      const kind = classify(name);
      const total = await db.collection(name).estimatedDocumentCount();

      if (kind === "KEEP" || kind === "UNCLASSIFIED") {
        plan.push({ label, db, name, kind, total, toDelete: 0, filter: null });
        continue;
      }

      const filter = kind === "WIPE_ALL" ? {} : deleteFilterFor(name);
      const toDelete = await db.collection(name).countDocuments(filter);
      plan.push({ label, db, name, kind, total, toDelete, filter });
    }
  }

  // Soldes portés par le profil utilisateur (champ hérité), hors comptes protégés.
  const protectedForms = idForms([...apple, ...system]);
  const userBalanceFilter = {
    _id: { $nin: protectedForms },
    $or: [
      { balances: { $exists: true, $ne: {} } },
      { balanceHistory: { $exists: true, $ne: [] } },
    ],
  };
  const userBalanceCount = await usersDb.collection("users").countDocuments(userBalanceFilter);

  return { plan, userBalanceFilter, userBalanceCount, keptTxCount: keptTx.length };
}

/* -------------------------------------------------------------------------- */
/* Écritures d'ouverture — le grand livre adosse chaque solde conservé         */
/* -------------------------------------------------------------------------- */

function openingTxId(reference) {
  const hash = crypto.createHash("md5").update(reference).digest("hex").slice(0, 24);
  return new mongoose.Types.ObjectId(hash);
}

function netOf(entries, accountId) {
  let net = D.zero();
  for (const e of entries) {
    if (String(e.accountId) !== accountId) continue;
    const status = String(e.status || "").toUpperCase() || "POSTED";
    if (status !== "POSTED") continue;
    const amount = D.parseDecimal(e.amount);
    if (amount === null) throw new Error(`montant illisible sur l'écriture ${e._id}`);
    net = String(e.direction).toUpperCase() === "DEBIT" ? D.sub(net, amount) : D.add(net, amount);
  }
  return net;
}

async function postOpening(ledger, { reference, leg, currency, ecart, metadata }) {
  const sens = D.compare(ecart, D.zero()) > 0 ? "CREDIT" : "DEBIT";
  const montant = D.format(D.abs(ecart));

  await ledger.postDoubleEntry({
    transactionId: openingTxId(reference),
    reference,
    entryType: "OPENING_BALANCE",
    context: "resetDevData",
    dedupScope: reference,
    metadata,
    legs: [
      { ...leg, direction: sens, amount: montant, currency },
      {
        accountType: "SYSTEM_CLEARING",
        accountId: openingBalanceClearingAccountId(currency),
        direction: sens === "CREDIT" ? "DEBIT" : "CREDIT",
        amount: montant,
        currency,
      },
    ],
  });

  return `${sens} ${montant} ${currency}`;
}

async function openKeptBalances(txDb) {
  const ledger = require("../src/services/ledgerService");
  const stamp = new Date().toISOString();
  const motif = `Remise à zéro des données de développement (${stamp})`;
  const lines = [];

  // Trésoreries.
  const treasuries = await txDb.collection("txsystembalances").find({ isActive: { $ne: false } }).toArray();
  for (const wallet of treasuries) {
    const prefix = `treasury:${String(wallet.systemType).toUpperCase()}:${String(wallet.userId)}:`;
    const entries = await txDb
      .collection("ledgerentries")
      .find({ accountId: { $regex: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` } })
      .project({ accountId: 1, currency: 1, direction: 1, amount: 1, status: 1 })
      .toArray();

    const rapport = reconcileTreasury({ wallet, entries });
    for (const ligne of rapport.currencies) {
      const ecart = D.parseDecimal(ligne.ecart);
      if (ecart === null) throw new Error(`écart illisible : ${rapport.systemType} ${ligne.currency}`);
      if (D.isZero(ecart)) continue;

      const reference = `RESET_OPENING:${rapport.systemType}:${rapport.userId}:${ligne.currency}:${stamp}`;
      const fait = await postOpening(ledger, {
        reference,
        currency: ligne.currency,
        ecart,
        metadata: { motif, soldeConserve: ligne.stored },
        leg: {
          accountType: "TREASURY",
          accountId: treasuryAccountId({
            treasuryUserId: rapport.userId,
            treasurySystemType: rapport.systemType,
            currency: ligne.currency,
          }),
          userId: rapport.userId,
        },
      });
      lines.push(`  trésorerie ${rapport.systemType} ${ligne.currency} : ${fait}`);
    }
  }

  // Portefeuilles conservés hors bac à sable (comptes système).
  const wallets = await txDb.collection("tx_wallet_balances").find({ isSandbox: { $ne: true } }).toArray();
  for (const w of wallets) {
    const userId = String(w.user);
    const currency = String(w.currency).toUpperCase();
    const walletAcc = userWalletAccountId(userId, currency);
    const reserveAcc = systemReserveAccountId(userId, currency);

    const entries = await txDb
      .collection("ledgerentries")
      .find({ accountId: { $in: [walletAcc, reserveAcc] } })
      .project({ accountId: 1, direction: 1, amount: 1, status: 1 })
      .toArray();

    const available = D.parseDecimal(w.availableAmount);
    if (available === null) throw new Error(`solde disponible illisible : portefeuille ${w._id}`);

    // Les réservations appartenaient à des transactions effacées : la réserve
    // restante est ce que le grand livre en dit encore.
    const reserved = netOf(entries, reserveAcc);
    await txDb.collection("tx_wallet_balances").updateOne(
      { _id: w._id },
      {
        $set: {
          reservedAmount: mongoose.Types.Decimal128.fromString(D.format(reserved)),
          amount: mongoose.Types.Decimal128.fromString(D.format(D.add(available, reserved))),
        },
      }
    );

    const ecart = D.sub(available, netOf(entries, walletAcc));
    if (D.isZero(ecart)) continue;

    const reference = `RESET_OPENING:USER_WALLET:${userId}:${currency}:${stamp}`;
    const fait = await postOpening(ledger, {
      reference,
      currency,
      ecart,
      metadata: { motif, soldeConserve: D.format(available) },
      leg: { accountType: "USER_WALLET", accountId: walletAcc, userId },
    });
    lines.push(`  portefeuille ${userId} ${currency} : ${fait}`);
  }

  return lines;
}

/* -------------------------------------------------------------------------- */
/* Principal                                                                  */
/* -------------------------------------------------------------------------- */

function backendDbNames() {
  try {
    const file = path.join(__dirname, "..", "..", "paynoval-backend", ".env");
    const parsed = require("dotenv").parse(fs.readFileSync(file));
    const name = (uri) => {
      const m = URI_RE.exec(String(uri || "").trim());
      return m ? decodeURIComponent(m[2] || "") : null;
    };
    return { main: name(parsed.MONGO_URI), tx: name(parsed.MONGO_TX_URI) };
  } catch {
    return null;
  }
}

(async () => {
  await connectTransactionsDB();
  const txDb = getTxConn().db;
  const usersDb = getUsersConn().db;

  if (txDb.databaseName !== txTarget.dbName || usersDb.databaseName !== usersTarget.dbName) {
    throw new Error(
      `connexion inattendue : ${txDb.databaseName} / ${usersDb.databaseName} ` +
        `au lieu de ${txTarget.dbName} / ${usersTarget.dbName}`
    );
  }

  console.log(`\n— Remise à zéro des données de développement (${APPLY ? "APPLIQUÉE" : "SIMULATION"}) —`);
  console.log(`Cible : ${TARGET}`);
  console.log(`  base transactions : ${txTarget.dbName}`);
  console.log(`  base principale   : ${usersTarget.dbName}`);

  const backend = backendDbNames();
  if (backend) {
    const strip = (n) => String(n || "").replace(/-test$/, "");
    const aligned =
      strip(backend.main) === strip(usersTarget.dbName) && strip(backend.tx) === strip(txTarget.dbName);
    console.log(
      `  .env du backend   : ${backend.main} / ${backend.tx}` +
        (aligned ? "" : "  ⚠️ familles de bases DIFFÉRENTES de Tx-Core — vérifier avant d'appliquer")
    );
  }

  const { apple, system } = await protectedAccounts(usersDb, txDb);
  console.log(`\nComptes protégés : ${system.length} système, ${apple.length} Apple`);
  for (const id of system) console.log(`  système ${id}`);
  for (const id of apple) console.log(`  apple   ${id}`);

  const { plan, userBalanceFilter, userBalanceCount, keptTxCount } = await buildPlan({
    txDb,
    usersDb,
    apple,
    system,
  });

  console.log(`\nTransactions conservées (Apple / bac à sable) : ${keptTxCount}`);
  console.log("\nCollection                                   base          total   à effacer   décision");
  for (const p of plan) {
    const decision = {
      KEEP: "gardée",
      UNCLASSIFIED: "gardée (non classée)",
      WIPE_ALL: "effacée",
      WIPE: "effacée sauf Apple",
      SPECIAL: "effacée sauf protégés",
    }[p.kind];
    console.log(
      `${p.name.padEnd(44)} ${p.label.padEnd(12)} ${String(p.total).padStart(7)} ${String(p.toDelete).padStart(11)}   ${decision}`
    );
  }
  console.log(`\nProfils utilisateurs dont le solde hérité sera remis à zéro : ${userBalanceCount}`);

  const unclassified = plan.filter((p) => p.kind === "UNCLASSIFIED" && p.total > 0);
  if (unclassified.length) {
    console.log(
      `\n⚠️ ${unclassified.length} collection(s) non classée(s), GARDÉES par prudence : ` +
        unclassified.map((p) => `${p.label}.${p.name}`).join(", ")
    );
  }

  if (!APPLY) {
    console.log(
      `\nSimulation : rien n'a été effacé. Pour appliquer :\n` +
        `  node scripts/resetDevData.js --target=${TARGET} --apply --confirm=${txTarget.dbName},${usersTarget.dbName}`
    );
    await mongoose.disconnect();
    process.exit(0);
  }

  let deleted = 0;
  for (const p of plan) {
    if (!p.filter || p.toDelete === 0) continue;
    const r = await p.db.collection(p.name).deleteMany(p.filter);
    deleted += r.deletedCount;
    console.log(`  🗑  ${p.label}.${p.name} : ${r.deletedCount}`);
  }

  if (userBalanceCount > 0) {
    const r = await usersDb
      .collection("users")
      .updateMany(userBalanceFilter, { $set: { balances: {}, balanceHistory: [] } });
    console.log(`  ↺  principale.users : ${r.modifiedCount} solde(s) hérité(s) remis à zéro`);
  }

  console.log(`\n${deleted} document(s) effacé(s). Écritures d'ouverture des soldes conservés :`);
  const openings = await openKeptBalances(txDb);
  console.log(openings.length ? openings.join("\n") : "  aucune (soldes déjà adossés au grand livre)");

  /**
   * Contrôle final : un vrai passage de réconciliation, sous verrou, écrit
   * dans `reconciliation_runs` — l'alerte du backend lit ce document.
   */
  const { runReconciliationOnce } = require("../src/services/reconciliation/reconciliationScheduler");
  const outcome = await runReconciliationOnce();
  if (outcome?.ran) {
    const report = outcome.result;
    console.log(
      `\nRéconciliation : ${report.anomalies.length} écart(s)` +
        (report.anomalies.length
          ? ` — ${JSON.stringify(
              report.anomalies.reduce((acc, a) => ({ ...acc, [a.type]: (acc[a.type] || 0) + 1 }), {})
            )}`
          : " ✅")
    );
  } else {
    console.log("\nRéconciliation non lancée (verrou détenu ailleurs) — elle passera au prochain contrôle.");
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error("❌ Remise à zéro interrompue :", err?.message || err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
