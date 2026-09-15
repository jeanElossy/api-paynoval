"use strict";

/**
 * ============================================================================
 * RATTRAPAGE DES POSITIONS DE COFFRE — RECONSTRUITES DEPUIS LES RÈGLEMENTS
 * ============================================================================
 *
 * Depuis le 2026-09-10, tout retrait de coffre est un débit CONDITIONNEL de la
 * position Tx-Core (`CagnotteVaultPosition`). Un coffre créé avant n'en a pas :
 * son retrait est refusé (`VAULT_POSITION_MISSING`) — en fermeture, jamais
 * payé à l'aveugle.
 *
 * Ce script reconstruit la position de chaque coffre à partir des RÈGLEMENTS
 * Tx-Core (la source de vérité, invariant 2), et la compare au solde projeté
 * par le backend (`vaults.balance`). Il ne crée QUE des positions absentes, et
 * ne crée rien pour un coffre incohérent :
 *
 *   · devise de la cagnotte ≠ devise du coffre           → CURRENCY_INCOHERENT
 *   · règlement v1 sans montant crédité connu             → LEGACY_AMOUNT_UNKNOWN
 *   · règlement libellé dans une autre devise que le coffre → FOREIGN_CURRENCY_CREDIT
 *   · écart entre règlements et projection backend        → PROJECTION_DRIFT
 *
 * Chaque cas est listé. `PROJECTION_DRIFT` peut être accepté explicitement par
 * `--trust-ledger` (la position prend les chiffres des règlements) ; les autres
 * se traitent à la main, avec un auteur.
 *
 * Usage :
 *   node scripts/backfillCagnotteVaultPositions.js                 # simulation
 *   node scripts/backfillCagnotteVaultPositions.js --apply
 *   node scripts/backfillCagnotteVaultPositions.js --apply --trust-ledger
 *
 * Lecture seule des collections du backend (`vaults`, `cagnottes`) sur la base
 * Users, qu'ils partagent : le script le vérifie et s'arrête sinon.
 */

const mongoose = require("mongoose");
const config = require("../src/config");
const { connectTransactionsDB, getTxConn, getUsersConn } = require("../src/config/db");
const buildPosition = require("../src/models/CagnotteVaultPosition");
const buildSettlement = require("../src/models/CagnotteSettlement");
const buildExternal = require("../src/models/CagnotteExternalSettlement");
const buildVaultSettlement = require("../src/models/CagnotteVaultWithdrawalSettlement");
const { toDec, positionToJSON } = require("../src/services/cagnotte/vaultPosition");
const { roundMoney, decimalsForCurrency } = require("../src/services/pricing/pricingEngine");

const APPLY = process.argv.includes("--apply");
const TRUST_LEDGER = process.argv.includes("--trust-ledger");

const ISO = /^[A-Z]{3}$/;

function up(v) {
  return String(v ?? "").trim().toUpperCase();
}

function eps(currency) {
  return 0.5 / 10 ** decimalsForCurrency(currency);
}

async function sumsFor({ vaultId, currency, Settlement, External, VaultSettlement }) {
  const flags = [];
  let credited = 0;
  let withdrawn = 0;
  let closureFees = 0;

  const participations = await Settlement.find({
    status: "confirmed",
    $or: [{ vaultId }, { "meta.vaultId": vaultId }],
  }).lean();

  for (const p of participations) {
    if (Number(p.schemaVersion || 1) >= 2 && p.destination) {
      if (up(p.destination.currency) !== currency) flags.push(`FOREIGN_CURRENCY_CREDIT:${p.reference}`);
      credited += Number(p.destination.amount || 0);
      continue;
    }

    const net = Number(p.meta?.netToVault);
    const cur = up(p.meta?.baseCurrencyCode);

    if (!Number.isFinite(net) || net <= 0) {
      flags.push(`LEGACY_AMOUNT_UNKNOWN:${p.reference}`);
      continue;
    }

    if (cur && cur !== currency) flags.push(`FOREIGN_CURRENCY_CREDIT:${p.reference}`);
    credited += net;
  }

  const externals = await External.find({ vaultId, status: "confirmed" }).lean();

  for (const e of externals) {
    if (up(e.netToVault?.currency) !== currency) flags.push(`FOREIGN_CURRENCY_CREDIT:${e.reference}`);
    credited += Number(e.netToVault?.amount || 0);
  }

  const outflows = await VaultSettlement.find({ vaultId, status: "confirmed" }).lean();

  for (const o of outflows) {
    const kind = o.meta?.settlementKind;
    if (kind === "cagnotte_vault_withdrawal") {
      if (up(o.credit?.currency) !== currency) flags.push(`FOREIGN_CURRENCY_DEBIT:${o.reference}`);
      withdrawn += Number(o.credit?.amount || 0);
    } else if (kind === "cagnotte_closure_fee_credit") {
      if (up(o.feeDebit?.currency) !== currency) flags.push(`FOREIGN_CURRENCY_DEBIT:${o.reference}`);
      closureFees += Number(o.feeDebit?.amount || 0);
    }
  }

  credited = roundMoney(credited, currency);
  withdrawn = roundMoney(withdrawn, currency);
  closureFees = roundMoney(closureFees, currency);

  return {
    credited,
    withdrawn,
    closureFees,
    balance: roundMoney(credited - withdrawn - closureFees, currency),
    flags,
  };
}

async function main() {
  config.load({ strict: false });
  await connectTransactionsDB();

  const txConn = getTxConn();
  const usersDb = getUsersConn().db;

  const collections = (await usersDb.listCollections().toArray()).map((c) => c.name);
  if (!collections.includes("vaults") || !collections.includes("cagnottes")) {
    throw new Error(
      `Les collections « vaults » et « cagnottes » sont absentes de la base Users (${usersDb.databaseName}). ` +
        "Le backend ne partage pas cette base : lancer le script avec l'URI de la base du backend."
    );
  }

  const Position = buildPosition(txConn);
  const Settlement = buildSettlement(txConn);
  const External = buildExternal(txConn);
  const VaultSettlement = buildVaultSettlement(txConn);

  const vaults = await usersDb.collection("vaults").find({}).toArray();

  console.log(
    `\n  Positions de coffre — ${APPLY ? "ÉCRITURE" : "SIMULATION (--apply pour écrire)"}` +
      `${TRUST_LEDGER ? ", écarts de projection ACCEPTÉS (--trust-ledger)" : ""}\n` +
      `  ${vaults.length} coffre(s) dans le backend.\n`
  );

  const report = { created: 0, alreadyPresent: 0, skipped: [], drift: [] };

  for (const v of vaults) {
    const vaultId = String(v._id);
    const cagnotte = v.cagnotte ? await usersDb.collection("cagnottes").findOne({ _id: v.cagnotte }) : null;

    if (!cagnotte) {
      report.skipped.push({ vaultId, reason: "CAGNOTTE_NOT_FOUND" });
      continue;
    }

    const cagnotteCurrency = up(cagnotte.currency);
    const vaultCurrency = up(v.currencyCode);

    if (!ISO.test(cagnotteCurrency) || cagnotteCurrency !== vaultCurrency) {
      report.skipped.push({ vaultId, reason: `CURRENCY_INCOHERENT (cagnotte=${cagnotteCurrency} coffre=${vaultCurrency})` });
      continue;
    }

    const existing = await Position.findOne({ vaultId }).lean();
    if (existing) {
      report.alreadyPresent += 1;
      continue;
    }

    const sums = await sumsFor({ vaultId, currency: cagnotteCurrency, Settlement, External, VaultSettlement });

    if (sums.flags.length) {
      report.skipped.push({ vaultId, reason: sums.flags.join(", ") });
      continue;
    }

    const projected = roundMoney(Number(v.balance || 0), cagnotteCurrency);
    const delta = roundMoney(sums.balance - projected, cagnotteCurrency);

    if (Math.abs(delta) > eps(cagnotteCurrency)) {
      report.drift.push({ vaultId, ledger: sums.balance, projected, delta, currency: cagnotteCurrency });
      if (!TRUST_LEDGER) {
        report.skipped.push({ vaultId, reason: `PROJECTION_DRIFT (${delta} ${cagnotteCurrency})` });
        continue;
      }
    }

    if (sums.balance < 0) {
      report.skipped.push({ vaultId, reason: `NEGATIVE_BALANCE (${sums.balance} ${cagnotteCurrency})` });
      continue;
    }

    if (APPLY) {
      const doc = await Position.create({
        vaultId,
        cagnotteId: String(cagnotte._id),
        currency: cagnotteCurrency,
        balance: toDec(sums.balance, cagnotteCurrency),
        collected: toDec(sums.credited, cagnotteCurrency),
        credited: toDec(sums.credited, cagnotteCurrency),
        withdrawn: toDec(sums.withdrawn, cagnotteCurrency),
        closureFees: toDec(sums.closureFees, cagnotteCurrency),
        closedAt: cagnotte.closed ? cagnotte.updatedAt || new Date() : null,
        origin: "backfill",
      });
      console.log(`  + ${vaultId} ${JSON.stringify(positionToJSON(doc))}`);
    } else {
      console.log(`  + ${vaultId} (${cagnotteCurrency}) solde=${sums.balance} collecté=${sums.credited}`);
    }

    report.created += 1;
  }

  console.log(`\n  ${APPLY ? "Créées" : "À créer"} : ${report.created} · déjà présentes : ${report.alreadyPresent}`);

  if (report.drift.length) {
    console.log(`\n  ⚠️ Écarts règlements ↔ projection backend (${report.drift.length}) :`);
    for (const d of report.drift) console.log(`    ${d.vaultId} règlements=${d.ledger} backend=${d.projected} écart=${d.delta} ${d.currency}`);
  }

  if (report.skipped.length) {
    console.log(`\n  ⛔ Coffres NON traités (${report.skipped.length}) — à examiner, retrait refusé d'ici là :`);
    for (const s of report.skipped) console.log(`    ${s.vaultId} : ${s.reason}`);
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
