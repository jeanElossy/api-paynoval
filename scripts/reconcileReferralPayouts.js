"use strict";

/**
 * Réconciliation des versements de parrainage — exécution manuelle ou planifiée.
 *
 *   node scripts/reconcileReferralPayouts.js
 *   node scripts/reconcileReferralPayouts.js --hours=168 --limit=5000
 *
 * Code de sortie 1 si des incohérences sont détectées, afin qu'un ordonnanceur
 * (cron, CI, supervision) puisse alerter sans analyser la sortie.
 */

require("dotenv").config();

const mongoose = require("mongoose");
const { connectTransactionsDB } = require("../src/config/db");
const {
  reconcileReferralPayouts,
} = require("../src/services/referral/referralReconciliationService");

function readArg(name, fallback) {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!found) return fallback;

  const value = Number(found.split("=")[1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

(async () => {
  const sinceHours = readArg("hours", 48);
  const limit = readArg("limit", 1000);

  try {
    await connectTransactionsDB();

    const result = await reconcileReferralPayouts({ sinceHours, limit });

    console.log(
      JSON.stringify(
        {
          checked: result.checked,
          healthy: result.healthy,
          anomalies: result.anomalies,
          window: result.window,
        },
        null,
        2
      )
    );

    await mongoose.disconnect().catch(() => {});
    process.exit(result.healthy ? 0 : 1);
  } catch (err) {
    console.error("[reconcileReferralPayouts] echec", err?.message || err);

    await mongoose.disconnect().catch(() => {});
    process.exit(2);
  }
})();
