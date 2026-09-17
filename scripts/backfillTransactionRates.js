"use strict";

/**
 * Rattrapage du taux inscrit sur les transactions (`exchangeRate`,
 * `fxRateSourceToTarget`), tronqué à deux décimales jusqu'au 2026-09-16.
 *
 *   npm run backfill:transaction-rates               # simulation, n'écrit rien
 *   npm run backfill:transaction-rates -- --apply    # écrit
 *
 * ⚠️ Le séparateur `--` est indispensable : sans lui, npm confisque `--apply`
 * et le script simulerait en silence. Il le détecte et refuse.
 *
 * La décision est dans `src/services/pricing/rateRepair.js` (pur, testé). Ce
 * script RECOPIE le taux exact que la transaction porte déjà ; il ne calcule
 * rien et n'interroge aucun fournisseur de change. Chaque écriture est
 * conditionnelle à l'ancienne valeur (une transaction modifiée entre la lecture
 * et l'écriture n'est pas touchée) et laisse une trace dans `meta.rateRepair`.
 */

const mongoose = require("mongoose");

const config = require("../src/config");
const { connectTransactionsDB, getTxConn } = require("../src/config/db");
const buildTransaction = require("../src/models/Transaction");
const { decideRateRepair } = require("../src/services/pricing/rateRepair");

const APPLY = process.argv.includes("--apply");

async function main() {
  if (!APPLY && process.env.npm_config_apply) {
    throw new Error(
      "npm a confisqué --apply : rien n'aurait été écrit. " +
        "Relancez avec : npm run backfill:transaction-rates -- --apply"
    );
  }

  config.load({ strict: false });
  await connectTransactionsDB();

  const Transaction = buildTransaction(getTxConn());

  const cursor = Transaction.find(
    {
      $or: [
        { "money.fxRateSourceToTarget": { $exists: true, $ne: null } },
        { "pricingSnapshot.result.appliedRate": { $exists: true, $ne: null } },
      ],
    },
    {
      reference: 1,
      meta: 1,
      exchangeRate: 1,
      fxRateSourceToTarget: 1,
      netAmount: 1,
      amountTarget: 1,
      localAmount: 1,
      currencyTarget: 1,
      localCurrencySymbol: 1,
      "money.fxRateSourceToTarget": 1,
      "pricingSnapshot.result.appliedRate": 1,
    }
  )
    .lean()
    .cursor();

  console.log(
    `\n  Taux des transactions — ${APPLY ? "ÉCRITURE" : "SIMULATION (-- --apply pour écrire)"}\n`
  );

  const report = { examined: 0, ok: 0, repaired: 0, wouldRepair: 0, raced: 0, skipped: [] };

  for await (const tx of cursor) {
    report.examined += 1;

    const decision = decideRateRepair(tx);

    if (decision.action === "ok") {
      report.ok += 1;
      continue;
    }

    if (decision.action === "skip") {
      report.skipped.push({ reference: tx.reference, reason: decision.reason });
      continue;
    }

    if (!APPLY) {
      report.wouldRepair += 1;
      console.log(
        `    ${tx.reference} : ${decision.previous.exchangeRate} → ${decision.rate}`
      );
      continue;
    }

    const rate = mongoose.Types.Decimal128.fromString(decision.rate);

    const trace = {
      at: new Date(),
      reason: decision.reason,
      previousExchangeRate: decision.previous.exchangeRate,
      previousFxRateSourceToTarget: decision.previous.fxRateSourceToTarget,
      source: "money.fxRateSourceToTarget|pricingSnapshot.result.appliedRate",
    };

    /**
     * `meta` vaut `null` par défaut sur une transaction, et Mongo refuse de
     * créer `meta.rateRepair` dans un champ nul : on pose alors l'objet entier.
     */
    const metaEstObjet = tx.meta && typeof tx.meta === "object" && !Array.isArray(tx.meta);

    const res = await Transaction.updateOne(
      {
        _id: tx._id,
        exchangeRate: tx.exchangeRate ?? null,
        fxRateSourceToTarget: tx.fxRateSourceToTarget ?? null,
      },
      {
        $set: {
          exchangeRate: rate,
          fxRateSourceToTarget: rate,
          ...(metaEstObjet ? { "meta.rateRepair": trace } : { meta: { rateRepair: trace } }),
        },
      }
    );

    if (res.modifiedCount === 1) {
      report.repaired += 1;
    } else {
      report.raced += 1;
    }
  }

  console.log(
    `\n  ${report.examined} examinée(s) · ${report.ok} déjà exacte(s) · ` +
      (APPLY
        ? `${report.repaired} réparée(s) · ${report.raced} modifiée(s) entre-temps, non touchée(s)`
        : `${report.wouldRepair} à réparer`)
  );

  if (report.skipped.length) {
    console.log(
      `\n  ⛔ Non traitées (${report.skipped.length}) — le taux exact manque ou ne concorde pas avec les montants :`
    );
    for (const s of report.skipped) console.log(`    ${s.reference} : ${s.reason}`);
    process.exitCode = 2;
  }

  console.log("");
}

main()
  .catch((err) => {
    console.error(`\n  ❌ ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
