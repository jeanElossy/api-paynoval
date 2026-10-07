#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * ============================================================================
 * MIGRATION DU MODE DE COMPTE — `live` / `sandbox` (2026-10-06)
 * ============================================================================
 *
 * Pose le champ `mode` sur tous les documents qui ne le portent pas encore :
 * utilisateurs, journal AML, cagnottes (base Users) ; transactions, portefeuilles, grand
 * livre, trésoreries, dossiers de revue (base Transactions).
 *
 * Il est INDISPENSABLE avant de servir le code du 2026-10-06 : `mode` est
 * requis et immuable sur `Transaction`, `LedgerEntry` et `TxWalletBalance`.
 * Une transaction antérieure sans `mode` ne peut plus être enregistrée
 * (`save`) ni partir chez un prestataire — échec en fermeture, voulu.
 *
 * Règles de classement : `src/services/migration/accountModeMigration.js`
 * (pures, testées). Direction sûre : toute trace de l'ancien raccourci Apple
 * Review, ou tout objet d'un compte de démonstration, devient `sandbox`.
 *
 * ⚠️ PILOTE NATIF : `mode` est `immutable` côté Mongoose, qui refuserait de le
 * poser sur un document existant. Seuls les documents SANS `mode` sont
 * touchés : la migration est rejouable et n'écrase jamais une valeur posée.
 *
 * USAGE
 *   node scripts/migrateAccountMode.js --target=test        # simulation (n'écrit rien)
 *   node scripts/migrateAccountMode.js --target=legacy      # simulation, bases sans suffixe
 *   node scripts/migrateAccountMode.js --target=test --apply --confirm=<baseTx>,<baseUsers>
 *
 * Les URI viennent du `.env` de Tx-Core ; seul le NOM de la base change selon
 * la cible. Aucune URI n'est affichée (elles portent le mot de passe).
 */

const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");

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

if (!["test", "legacy"].includes(TARGET)) {
  fail("Préciser --target=test (bases -test) ou --target=legacy (bases sans suffixe).");
}

const txTarget = retarget(process.env.MONGO_URI_TRANSACTIONS, TARGET);
const usersTarget = retarget(process.env.MONGO_URI_USERS, TARGET);

if (!txTarget || !usersTarget) {
  fail("MONGO_URI_TRANSACTIONS / MONGO_URI_USERS absentes ou illisibles dans le .env de Tx-Core.");
}
if (txTarget.dbName === usersTarget.dbName) {
  fail("Les bases transactions et utilisateurs portent le même nom : configuration inattendue, arrêt.");
}
if (APPLY) {
  const expected = [txTarget.dbName, usersTarget.dbName];
  const ok = expected.every((n) => CONFIRM.includes(n)) && CONFIRM.length === expected.length;
  if (!ok) fail(`--apply exige --confirm=${expected.join(",")} (les deux noms de base, exactement).`);
}

const NO_MODE = { mode: { $exists: false } };

const LEGACY_TX_MARKERS = [
  { isSandbox: true },
  { provider: { $in: ["sandbox", "SANDBOX", "Sandbox"] } },
  { channel: { $in: ["sandbox", "SANDBOX", "Sandbox"] } },
  { "metadata.source": "apple_review_sandbox" },
  { "meta.source": "apple_review_sandbox" },
  { "metadata.sandbox": true },
  { "meta.sandbox": true },
  { reference: /^SBX-/ },
];

async function step(label, collection, filter, update) {
  const count = await collection.countDocuments(filter);
  if (APPLY && count > 0) {
    const res = await collection.updateMany(filter, update);
    console.log(`  ✔ ${label} : ${res.modifiedCount} document(s) mis à jour`);
  } else {
    console.log(`  ${APPLY ? "✔" : "·"} ${label} : ${count} document(s)${APPLY ? "" : " à mettre à jour"}`);
  }
  return count;
}

async function main() {
  console.log(
    `\nMigration du mode — cible ${TARGET} (${txTarget.dbName}, ${usersTarget.dbName}) — ` +
      (APPLY ? "APPLICATION" : "SIMULATION, rien n'est écrit")
  );

  const usersConn = await mongoose.createConnection(usersTarget.uri).asPromise();
  const txConn = await mongoose.createConnection(txTarget.uri).asPromise();

  try {
    const usersDb = usersConn.db;
    const txDb = txConn.db;

    /* 1. Utilisateurs ------------------------------------------------------ */
    console.log("\nBase Users");
    const users = usersDb.collection("users");

    await step(
      "utilisateurs de démonstration → sandbox",
      users,
      { ...NO_MODE, $or: [{ isSandbox: true }, { isReviewerAccount: true }] },
      { $set: { mode: "sandbox" } }
    );
    await step("autres utilisateurs → live", users, NO_MODE, { $set: { mode: "live" } });

    // En simulation, les comptes classés sandbox sont ceux qui le SERAIENT.
    const sandboxUsers = await users
      .find(
        { $or: [{ mode: "sandbox" }, { mode: { $exists: false }, isSandbox: true }, { mode: { $exists: false }, isReviewerAccount: true }] },
        { projection: { _id: 1 } }
      )
      .toArray();
    const sandboxUserIds = sandboxUsers.map((u) => u._id);
    console.log(`  → ${sandboxUserIds.length} compte(s) sandbox`);

    const amllogs = usersDb.collection("amllogs");
    await step(
      "journal AML des comptes sandbox → sandbox",
      amllogs,
      { ...NO_MODE, userId: { $in: sandboxUserIds } },
      { $set: { mode: "sandbox" } }
    );
    await step("reste du journal AML → live", amllogs, NO_MODE, { $set: { mode: "live" } });

    const cagnottes = usersDb.collection("cagnottes");
    await step(
      "cagnottes des comptes sandbox → sandbox",
      cagnottes,
      { ...NO_MODE, createdBy: { $in: sandboxUserIds } },
      { $set: { mode: "sandbox" } }
    );
    await step("autres cagnottes → live", cagnottes, NO_MODE, { $set: { mode: "live" } });

    /* 2. Transactions ------------------------------------------------------ */
    console.log("\nBase Transactions");
    const transactions = txDb.collection("transactions");
    const sandboxTxFilter = {
      ...NO_MODE,
      $or: [
        ...LEGACY_TX_MARKERS,
        { userId: { $in: sandboxUserIds } },
        { sender: { $in: sandboxUserIds } },
        { receiver: { $in: sandboxUserIds } },
      ],
    };

    const sandboxTxIds = (
      await transactions.find(sandboxTxFilter, { projection: { _id: 1 } }).toArray()
    ).map((t) => t._id);

    await step("transactions sandbox → sandbox", transactions, sandboxTxFilter, {
      $set: { mode: "sandbox" },
    });
    await step("autres transactions → live", transactions, NO_MODE, { $set: { mode: "live" } });

    /* 3. Portefeuilles ----------------------------------------------------- */
    const wallets = txDb.collection("tx_wallet_balances");
    await step(
      "portefeuilles sandbox → sandbox",
      wallets,
      { ...NO_MODE, $or: [{ isSandbox: true }, { user: { $in: sandboxUserIds } }] },
      { $set: { mode: "sandbox" } }
    );
    await step("autres portefeuilles → live", wallets, NO_MODE, { $set: { mode: "live" } });

    const indexes = await wallets.indexes().catch(() => []);
    const obsolete = indexes.find((i) => i.name === "user_1_currency_1_isSandbox_1");
    if (obsolete) {
      if (APPLY) {
        await wallets.dropIndex("user_1_currency_1_isSandbox_1");
        console.log("  ✔ index obsolète user_1_currency_1_isSandbox_1 retiré");
      } else {
        console.log("  · index obsolète user_1_currency_1_isSandbox_1 à retirer");
      }
    }

    /* 4. Grand livre ------------------------------------------------------- */
    const ledger = txDb.collection("ledgerentries");
    await step(
      "écritures des transactions sandbox → sandbox",
      ledger,
      { ...NO_MODE, transactionId: { $in: sandboxTxIds } },
      { $set: { mode: "sandbox" } }
    );
    await step("autres écritures → live", ledger, NO_MODE, { $set: { mode: "live" } });

    /* 5. Trésoreries ------------------------------------------------------- */
    const systemBalances = txDb.collection("txsystembalances");
    await step(
      "trésoreries SANDBOX_* → sandbox",
      systemBalances,
      { ...NO_MODE, systemType: /^SANDBOX_/ },
      { $set: { mode: "sandbox" } }
    );
    await step("autres trésoreries → live", systemBalances, NO_MODE, { $set: { mode: "live" } });

    /* 6. Dossiers de revue ------------------------------------------------- */
    const reviewCases = txDb.collection("transactionreviewcases");
    await step(
      "dossiers de revue des transactions sandbox → sandbox",
      reviewCases,
      { ...NO_MODE, transactionId: { $in: sandboxTxIds.map(String) } },
      { $set: { mode: "sandbox" } }
    );
    await step("autres dossiers de revue → live", reviewCases, NO_MODE, { $set: { mode: "live" } });

    /* 7. Vérification ------------------------------------------------------ */
    if (APPLY) {
      console.log("\nVérification");
      let restants = 0;
      for (const [label, coll] of [
        ["users", users],
        ["amllogs", amllogs],
        ["cagnottes", cagnottes],
        ["transactions", transactions],
        ["tx_wallet_balances", wallets],
        ["ledgerentries", ledger],
        ["txsystembalances", systemBalances],
        ["transactionreviewcases", reviewCases],
      ]) {
        const n = await coll.countDocuments(NO_MODE);
        restants += n;
        console.log(`  ${n === 0 ? "✔" : "❌"} ${label} : ${n} document(s) sans mode`);
      }
      if (restants > 0) {
        process.exitCode = 1;
        console.error("\n❌ Des documents restent sans mode : relancer la migration.");
      } else {
        console.log("\n✅ Migration terminée : tous les documents portent leur mode.");
      }
    } else {
      console.log(
        `\nSimulation terminée. Pour appliquer :\n` +
          `  node scripts/migrateAccountMode.js --target=${TARGET} --apply --confirm=${txTarget.dbName},${usersTarget.dbName}`
      );
    }
  } finally {
    await usersConn.close().catch(() => {});
    await txConn.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`❌ Migration interrompue : ${err?.message || err}`);
  process.exit(1);
});
