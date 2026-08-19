"use strict";

/**
 * Réconciliation des flux financiers — exécution manuelle ou planifiée.
 *
 *   node scripts/reconcileTransactions.js
 *   node scripts/reconcileTransactions.js --hours=168 --limit=20000
 *
 * LECTURE SEULE : ce script ne corrige rien, il signale. Code de sortie 1 si des
 * écarts sont détectés, afin qu'un ordonnanceur puisse alerter sans analyser la
 * sortie.
 */

require("dotenv").config();

const mongoose = require("mongoose");

const { connectTransactionsDB } = require("../src/config/db");
const {
  reconcileTransactions,
} = require("../src/services/reconciliation/transactionReconciliationService");

function readArg(name, fallback) {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!found) return fallback;

  const value = Number(found.split("=")[1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

(async () => {
  let exitCode = 0;

  try {
    await connectTransactionsDB();

    const report = await reconcileTransactions({
      sinceHours: readArg("hours", 48),
      limit: readArg("limit", 5000),
    });

    console.log("");
    console.log("  Réconciliation des flux financiers");
    console.log("  ──────────────────────────────────");
    console.log(`  portefeuilles vérifiés  : ${report.checked.wallets}`);
    console.log(`  transactions vérifiées  : ${report.checked.transactions}`);
    console.log(`  écritures vérifiées     : ${report.checked.ledgerEntries}`);
    console.log(`  réservations vérifiées  : ${report.checked.reservations}`);
    console.log("");

    if (report.healthy) {
      console.log("  ✅ AUCUN ÉCART");
    } else {
      console.log(`  ❌ ${report.anomalies.length} ÉCART(S)`);
      console.log("");

      const byType = report.anomalies.reduce((acc, a) => {
        acc[a.type] = (acc[a.type] || 0) + 1;
        return acc;
      }, {});

      for (const [type, count] of Object.entries(byType)) {
        console.log(`     ${String(count).padStart(4)} × ${type}`);
      }

      console.log("");
      console.log("  Détail des 20 premiers :");
      for (const a of report.anomalies.slice(0, 20)) {
        console.log(`     ${a.type} — ${a.detail}`);
        console.log(`        ${JSON.stringify(a)}`);
      }

      exitCode = 1;
    }

    console.log("");
  } catch (err) {
    console.error("[reconcileTransactions] échec", err?.message || err);
    exitCode = 2;
  } finally {
    await mongoose.disconnect().catch(() => {});
    process.exit(exitCode);
  }
})();
