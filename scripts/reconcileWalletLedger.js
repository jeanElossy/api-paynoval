"use strict";

/**
 * ============================================================================
 * LE SOLDE CONFRONTÉ AU GRAND LIVRE — EXÉCUTION MANUELLE
 * ============================================================================
 *
 *   node scripts/reconcileWalletLedger.js
 *   node scripts/reconcileWalletLedger.js --user=<id> --currency=XOF
 *   node scripts/reconcileWalletLedger.js --limit=100000 --batch=500
 *   node scripts/reconcileWalletLedger.js --limit=5000 --after=<dernier _id vu>
 *   node scripts/reconcileWalletLedger.js --tolerance=0.01 --include-sandbox
 *   node scripts/reconcileWalletLedger.js --json
 *
 * Il recalcule chaque solde DEPUIS les écritures du grand livre et le compare à
 * ce que porte `tx_wallet_balances`. Le raisonnement comptable — quel champ
 * reproduit quel compte, quels statuts sont comptés — est en tête de
 * `src/services/ledger/walletLedgerReconciliation.js`.
 *
 * ⚠️ LECTURE SEULE. Il ne corrige rien et ne le pourra jamais : corriger un
 * solde d'office, c'est écrire de l'argent sans écriture comptable. Une
 * divergence se corrige par une contre-écriture (`REVERSAL` / `ADJUSTMENT`)
 * décidée par un humain qui en a compris la cause.
 *
 * ⚠️ CE BALAYAGE EST LOURD. Depuis le 2026-09-03 il EST branché : troisième axe
 * du planificateur (`services/reconciliation/reconciliationScheduler.js`), actif
 * par défaut, coupé par `RECONCILE_WALLET_LEDGER=false`. Cette commande reste le
 * chemin manuel — pour un balayage hors tour, ou pour reprendre à un point donné
 * via `--after`.
 *
 * ⚠️ Le planificateur balaie par TRANCHES avec un curseur de rotation persistant.
 * Un « aucun écart » d'un tour ne vaut que pour la tranche balayée. Ce script,
 * lancé sans `--after`, repart du début et couvre `--limit` portefeuilles — pas
 * la population.
 *
 * Codes de sortie — pour qu'un ordonnanceur puisse alerter sans lire la sortie :
 *   0  aucun écart
 *   1  au moins un écart ou un portefeuille indéterminé
 *   2  le contrôle n'a pas pu s'exécuter (≠ « tout va bien »)
 */

require("dotenv").config();

const mongoose = require("mongoose");

const { connectTransactionsDB } = require("../src/config/db");
const {
  reconcileWalletsAgainstLedger,
  DEFAULT_TOLERANCE,
  DEFAULT_BATCH_SIZE,
} = require("../src/services/reconciliation/walletLedgerReconciliationService");

function readFlag(name) {
  return process.argv.includes(`--${name}`);
}

function readString(name, fallback = null) {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!found) return fallback;

  const value = found.slice(name.length + 3).trim();
  return value || fallback;
}

function readNumber(name, fallback) {
  const raw = readString(name, null);
  if (raw === null) return fallback;

  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function pad(n, width) {
  return String(n).padStart(width);
}

(async () => {
  let exitCode = 0;

  try {
    await connectTransactionsDB();

    const options = {
      userId: readString("user", null),
      currency: readString("currency", null),
      limit: readNumber("limit", 5000),
      batchSize: readNumber("batch", DEFAULT_BATCH_SIZE),
      tolerance: readString("tolerance", DEFAULT_TOLERANCE),
      minLedgerVersion: readNumber("min-version", 0),
      includeSandbox: readFlag("include-sandbox"),
      /**
       * Reprise manuelle. Sans `--after`, le balayage part du début : c'est ce
       * qu'on veut pour un audit ponctuel avec une `--limit` haute. Avec, on
       * poursuit une rotation interrompue sans repasser sur ce qui a déjà été
       * vérifié. Le rapport rend `cursor.lastSeen` à repasser au tour suivant.
       */
      after: readString("after", null),
      /* Sur un balayage large, garder 100 000 verdicts « OK » en mémoire pour
         ne rien en faire n'a pas de sens : seuls les écarts sont conservés. */
      keepResults: false,
    };

    const report = await reconcileWalletsAgainstLedger(options);

    if (readFlag("json")) {
      console.log(JSON.stringify(report, null, 2));
      /* On sort par `exitCode`, pas par `process.exit()` : ce dernier saute le
         `finally` et laisse la connexion Mongo ouverte. */
      exitCode = report.healthy ? 0 : 1;
      return;
    }

    console.log("");
    console.log("  Portefeuille ↔ grand livre");
    console.log("  ──────────────────────────");
    console.log(
      `  portefeuilles vérifiés  : ${report.checked.wallets}` +
        ` sur ${report.population.matching}` +
        (report.cursor.rotationCompleted
          ? "  (rotation COMPLÈTE)"
          : `  ⚠️  tranche seulement — ${report.population.sweepsToCover} tour(s) pour tout voir`)
    );
    console.log(`  écritures cumulées      : ${report.checked.ledgerEntries}`);
    console.log(`  tolérance               : ${report.scope.tolerance}`);
    console.log(`  statuts comptés         : ${report.scope.statuses.join(", ")}`);
    console.log(`  durée                   : ${report.durationMs} ms`);

    /**
     * ⚠️ Sans cette ligne, un balayage tournant se lit comme un balayage
     * complet. « 5 000 vérifiés, aucun écart » sur 20 000 portefeuilles n'est
     * pas « tout va bien » : c'est « rien vu sur le quart regardé ».
     */
    if (!report.cursor.rotationCompleted && report.cursor.lastSeen) {
      console.log("");
      console.log(`  reprise                 : --after=${report.cursor.lastSeen}`);
    }

    if (report.scope.userId || report.scope.currency) {
      console.log(
        `  périmètre               : ` +
          `${report.scope.userId ? `user=${report.scope.userId} ` : ""}` +
          `${report.scope.currency ? `devise=${report.scope.currency}` : ""}`
      );
    }

    /**
     * ⚠️ UN CONTRÔLE SAUTÉ SE DIT. Sans cette ligne, « aucun écart » se lirait
     * comme « tout va bien » alors que les portefeuilles sandbox n'ont pas été
     * regardés du tout.
     */
    if (report.excluded.sandboxWallets > 0) {
      console.log("");
      console.log(
        `  ⚠️  ${report.excluded.sandboxWallets} portefeuille(s) sandbox ÉCARTÉ(S) — non vérifiés`
      );
      console.log(
        "      (le parcours de revue Apple mute le solde sans écriture comptable ;"
      );
      console.log(
        "       les inclure ferait crier au loup. --include-sandbox pour les voir.)"
      );
    }

    console.log("");

    if (report.healthy) {
      console.log("  ✅ AUCUN ÉCART — chaque solde vaut le cumul de ses écritures");
      console.log("");
      return;
    }

    console.log(
      `  ❌ ${report.divergent.length} PORTEFEUILLE(S) EN ÉCART ` +
        `(${report.byVerdict.DRIFT} dérive(s), ${report.byVerdict.INDETERMINATE} indéterminé(s))`
    );
    console.log("");

    for (const [type, count] of Object.entries(report.byType)) {
      console.log(`     ${pad(count, 4)} × ${type}`);
    }

    console.log("");
    console.log("  Détail des 20 premiers :");
    console.log("");

    for (const r of report.divergent.slice(0, 20)) {
      console.log(`     ${r.verdict} — user=${r.userId} ${r.currency}`);
      console.log(
        `        stocké    : amount=${r.stored.amount} ` +
          `dispo=${r.stored.availableAmount} réservé=${r.stored.reservedAmount}`
      );
      console.log(
        `        recalculé : amount=${r.projected.amount} ` +
          `dispo=${r.projected.availableAmount} réservé=${r.projected.reservedAmount}`
      );
      console.log(
        `        écart     : amount=${r.gaps.amount} ` +
          `dispo=${r.gaps.availableAmount} réservé=${r.gaps.reservedAmount}`
      );
      console.log(
        `        écritures : ${r.entries.counted} comptées ` +
          `(${r.entries.onWalletAccount} sur user_wallet, ` +
          `${r.entries.onReserveAccount} sur system_reserve) ` +
          `· versions ${JSON.stringify(r.entries.byLedgerVersion)}`
      );

      if (r.entries.skippedByStatus) {
        console.log(
          `        ⚠️  ${r.entries.skippedByStatus} écriture(s) écartée(s) par statut`
        );
      }

      if (r.entries.unreadable) {
        console.log(
          `        ⚠️  ${r.entries.unreadable} montant(s) ILLISIBLE(S) — verdict indéterminé`
        );
      }

      console.log("");
    }

    console.log(
      "  Ces écarts ne se corrigent PAS en réécrivant le solde : ce serait de"
    );
    console.log(
      "  l'argent sans écriture comptable. Comprendre la cause, puis poser une"
    );
    console.log("  contre-écriture (REVERSAL / ADJUSTMENT).");
    console.log("");

    exitCode = 1;
  } catch (err) {
    /* Un échec du contrôle n'est pas « aucun écart » — d'où un code distinct. */
    console.error(
      "[reconcileWalletLedger] le contrôle n'a PAS pu s'exécuter :",
      err?.message || err
    );
    exitCode = 2;
  } finally {
    await mongoose.disconnect().catch(() => {});
    process.exit(exitCode);
  }
})();
