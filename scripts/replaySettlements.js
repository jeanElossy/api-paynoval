"use strict";

/**
 * Rejeu des règlements restés en plan — exécution manuelle ou planifiée.
 *
 *   node scripts/replaySettlements.js --dry-run     # ce qui SERAIT rejoué
 *   node scripts/replaySettlements.js               # rejeu réel
 *   node scripts/replaySettlements.js --hours=168 --limit=200
 *
 * ⚠️ SANS `--dry-run`, CE SCRIPT DÉPLACE DE L'ARGENT. Il termine des règlements
 * que nous avions déjà acceptés — des rappels prestataire authentifiés dont le
 * traitement s'est interrompu. Il n'invente aucun mouvement : il exécute le même
 * moteur que le rappel direct, avec les mêmes gardes d'idempotence.
 *
 * À lancer après avoir regardé ce que signale `npm run reconcile:transactions`.
 */

require("dotenv").config();

const mongoose = require("mongoose");

const { connectTransactionsDB, getTxConn } = require("../src/config/db");
const { LEASE_MS } = require("../src/services/webhooks/webhookIdempotency");
const {
  replaySettlementsOnce,
} = require("../src/services/settlement/settlementReplay");
const {
  isReplayable,
  MAX_ATTEMPTS,
} = require("../src/services/settlement/settlementReplayRules");

const DRY_RUN = process.argv.includes("--dry-run");

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

    const sinceHours = readArg("hours", 72);
    const limit = readArg("limit", 50);
    const now = Date.now();

    console.log("");
    console.log("  Rejeu des règlements");
    console.log("  ────────────────────");
    console.log(`  fenêtre : ${sinceHours} h · plafond : ${limit} événements`);

    if (DRY_RUN) {
      /**
       * La simulation utilise LA MÊME fonction de décision que le rejeu réel.
       * Une simulation qui raisonne autrement ne simule rien.
       */
      const Model = getTxConn().models.ProviderWebhookEvent;

      const candidats = await Model.find({
        status: { $in: ["processing", "failed"] },
        createdAt: { $gte: new Date(now - sinceHours * 3600 * 1000) },
      })
        .sort({ createdAt: 1 })
        .limit(limit)
        .lean();

      const parMotif = {};
      let eligibles = 0;

      for (const record of candidats) {
        const { eligible, reason } = isReplayable(record, {
          now,
          leaseMs: LEASE_MS,
          maxAttempts: MAX_ATTEMPTS,
        });

        if (eligible) {
          eligibles += 1;
          console.log(
            `    ↻ ${record.provider}/${record.eventId} — ${record.status}, ` +
              `tentative ${record.attempts}, ref=${record.transactionReference || "-"}`
          );
        } else {
          parMotif[reason] = (parMotif[reason] || 0) + 1;
        }
      }

      console.log("");
      console.log(`  examinés  : ${candidats.length}`);
      console.log(`  rejouables: ${eligibles}`);

      for (const [motif, n] of Object.entries(parMotif)) {
        console.log(`  écartés   : ${String(n).padStart(3)} × ${motif}`);
      }

      console.log("");
      console.log("  🔍 Simulation — rien n'a été rejoué.");
    } else {
      const bilan = await replaySettlementsOnce({ sinceHours, limit, now });

      console.log("");
      console.log(`  examinés  : ${bilan.scanned}`);
      console.log(`  rejoués   : ${bilan.replayed}`);
      console.log(`  réussis   : ${bilan.succeeded}`);
      console.log(`  échoués   : ${bilan.failed}`);

      for (const [motif, n] of Object.entries(bilan.skipped)) {
        console.log(`  écartés   : ${String(n).padStart(3)} × ${motif}`);
      }

      // Un échec de rejeu n'est pas une panne du script : c'est un résultat.
      // Le code de sortie le distingue pour un ordonnanceur.
      if (bilan.failed) exitCode = 1;
    }

    console.log("");
  } catch (err) {
    console.error("[replaySettlements] échec", err?.message || err);
    exitCode = 2;
  } finally {
    await mongoose.disconnect().catch(() => {});
    process.exit(exitCode);
  }
})();
