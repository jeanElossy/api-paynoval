#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * TRÉSORERIE ↔ GRAND LIVRE — 100 % LECTURE SEULE.
 * -----------------------------------------------------------------------------
 * Pendant de `npm run reconcile:transactions`, pour les comptes INTERNES.
 * Il lit, compare et SIGNALE : il ne corrige rien, jamais. Une réconciliation
 * qui répare devient une seconde source de mouvements d'argent, déclenchée par
 * un travail de fond que personne ne regarde.
 *
 * Pour chaque compte interne actif et chaque devise :
 *     solde stocké   contre   Σ CREDIT − Σ DEBIT sur `treasury:<TYPE>:<id>:<CUR>`
 *
 * Usage :
 *   node scripts/reconcileTreasuries.js
 *   node scripts/reconcileTreasuries.js --json     # sortie machine
 */

require("dotenv").config();

const mongoose = require("mongoose");

const { connectTransactionsDB, getTxConn } = require("../src/config/db");
const {
  VERDICTS,
  reconcileTreasury,
  summarize,
} = require("../src/services/ledger/treasuryLedgerReconciliation");

const JSON_OUT = process.argv.includes("--json");

(async () => {
  await connectTransactionsDB();

  const db = getTxConn().db;

  const wallets = await db
    .collection("txsystembalances")
    .find({ isActive: { $ne: false } })
    .toArray();

  const results = [];

  for (const wallet of wallets) {
    const prefix = `treasury:${String(wallet.systemType || "").toUpperCase()}:${String(wallet.userId)}:`;

    // Le compte est préfixé par le type ET le propriétaire : une écriture d'une
    // autre trésorerie ne peut pas entrer dans ce cumul.
    const entries = await db
      .collection("ledgerentries")
      .find({ accountId: { $regex: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` } })
      .project({ accountId: 1, currency: 1, direction: 1, amount: 1, status: 1 })
      .toArray();

    results.push(reconcileTreasury({ wallet, entries }));
  }

  const summary = summarize(results);

  if (JSON_OUT) {
    console.log(JSON.stringify({ summary, results }, null, 2));
  } else {
    console.log("\n— Trésoreries vs grand livre —");

    for (const r of results) {
      console.log(`\n${r.systemType} (${r.userId}) : ${r.verdict}`);

      for (const c of r.currencies) {
        console.log(
          `  ${c.currency.padEnd(5)} solde=${String(c.stored).padStart(12)} ` +
            `grand-livre=${String(c.ledger).padStart(12)} écart=${String(c.ecart ?? "—").padStart(10)} ` +
            `(${c.counted} écriture${c.counted > 1 ? "s" : ""})`
        );
      }

      for (const a of r.anomalies) {
        console.log(`  ⚠️  ${a.code}${a.currency ? ` [${a.currency}]` : ""}`);
      }
    }

    console.log(
      `\nRésumé : ${summary.ok} conforme(s), ${summary.drift} en écart, ` +
        `${summary.indeterminate} indéterminé(s), ${summary.anomalies} anomalie(s).`
    );

    if (summary.drift || summary.indeterminate) {
      console.log(
        "\n⚠️  Un écart NE SE CORRIGE PAS ici. Une trésorerie fausse se reprend par une " +
          "CONTRE-ÉCRITURE datée et motivée (invariant 4)."
      );
    }
  }

  await mongoose.disconnect();
  process.exit(summary.drift || summary.indeterminate ? 2 : 0);
})().catch((err) => {
  console.error("❌ Réconciliation interrompue :", err?.message || err);
  process.exit(1);
});
