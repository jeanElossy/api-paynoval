#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * SOLDES DES COMPTES INTERNES : FLOTTANTS → DECIMAL128 — simulation par défaut.
 * -----------------------------------------------------------------------------
 * Mesuré en base le 2026-09-22 : `CAD: 16.150000000000002`,
 * `97.91000000000001`, `97.77999999999999`. Les portefeuilles clients étaient
 * déjà en `Decimal128` ; les comptes internes non, et chaque `$inc` en flottant
 * ajoutait sa queue.
 *
 * Ce script CONVERTIT la représentation, il ne change aucun montant : chaque
 * valeur est arrondie à l'échelle de SA devise (2 décimales, 0 pour XOF/XAF) et
 * l'écart de conversion est affiché. Un écart supérieur à un demi-centime
 * ARRÊTE le script : ce ne serait plus une conversion, mais une correction —
 * et une correction se fait par contre-écriture (invariant 4).
 *
 * Usage :
 *   node scripts/migrateSystemBalancesToDecimal.js           # simulation
 *   node scripts/migrateSystemBalancesToDecimal.js --apply   # écrit
 */

require("dotenv").config();

const mongoose = require("mongoose");

const { connectTransactionsDB, getTxConn } = require("../src/config/db");
const { roundToCurrency, toDecimal128 } = require("../src/services/ledger/systemBalanceAmounts");
const D = require("../src/services/ledger/decimalMoney");

const APPLY = process.argv.includes("--apply");
const ECART_MAX = "0.005";

(async () => {
  await connectTransactionsDB();

  const col = getTxConn().db.collection("txsystembalances");
  const docs = await col.find({}).toArray();

  let convertis = 0;
  let dejaExacts = 0;
  const refus = [];

  for (const doc of docs) {
    const balances = doc.balances || {};
    const next = {};
    const lignes = [];

    for (const [cur, raw] of Object.entries(balances)) {
      const dejaDecimal = raw?._bsontype === "Decimal128";
      const arrondi = roundToCurrency(raw, cur);

      if (arrondi === null) {
        refus.push(`${doc.systemType} ${cur} : solde illisible (${String(raw)})`);
        continue;
      }

      const avant = D.parseDecimal(raw);
      const apres = D.parseDecimal(arrondi);
      const ecart = D.abs(D.sub(avant, apres));

      if (D.exceeds(ecart, D.parseDecimal(ECART_MAX))) {
        refus.push(
          `${doc.systemType} ${cur} : écart de conversion ${D.format(ecart)} — ` +
            "ce serait une correction, pas une conversion"
        );
        continue;
      }

      next[cur] = toDecimal128(arrondi, cur);

      if (!dejaDecimal || D.format(avant) !== arrondi) {
        lignes.push(`${cur} ${String(raw)} → ${arrondi}`);
      }
    }

    if (Object.keys(next).length !== Object.keys(balances).length) continue;

    if (!lignes.length) {
      dejaExacts += 1;
      continue;
    }

    console.log(`${doc.systemType.padEnd(24)} ${lignes.join(", ")}`);

    if (APPLY) {
      await col.updateOne({ _id: doc._id }, { $set: { balances: next } });
    }

    convertis += 1;
  }

  console.log(
    `\n${APPLY ? "Converti" : "À convertir"} : ${convertis} compte(s) ; ` +
      `${dejaExacts} déjà exact(s) ; ${refus.length} refus.`
  );

  for (const r of refus) console.log(`⚠️  ${r}`);

  if (!APPLY && convertis) console.log("\nRelancer avec --apply pour écrire.");

  await mongoose.disconnect();
  process.exit(refus.length ? 2 : 0);
})().catch((err) => {
  console.error("❌ Migration interrompue :", err?.message || err);
  process.exit(1);
});
