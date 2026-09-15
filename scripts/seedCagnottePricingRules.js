"use strict";

/**
 * ============================================================================
 * RÈGLES TARIFAIRES DE CAGNOTTE — DÉPOSÉES POUR APPROBATION, JAMAIS PUBLIÉES
 * ============================================================================
 *
 * Depuis le 2026-09-10, les frais de cagnotte ne sont plus codés en dur dans le
 * backend (0,25 % par participation, 0,5 % à la clôture) : Tx-Core les lit dans
 * les règles `CAGNOTTE_PARTICIPATION` et `CAGNOTTE_CLOSURE`. Sans règle active,
 * toute participation et toute clôture sont REFUSÉES (`PRICING_UNAVAILABLE`) —
 * c'est voulu : un prix que personne n'a décidé ne s'applique pas.
 *
 * Ce script reproduit les taux historiques, mais il ne les PUBLIE pas : il
 * dépose des demandes de changement (`pending_approval`) dans le circuit de
 * gouvernance existant. Un second membre du staff les approuve dans le
 * back-office (Tarification → Demandes de changement). Le principe des quatre
 * yeux s'applique aux cagnottes comme au reste des prix.
 *
 * Usage :
 *   node scripts/seedCagnottePricingRules.js                          # simulation
 *   node scripts/seedCagnottePricingRules.js --apply --requested-by=<staffId>
 *   options : --participation-percent=0.25 --closure-percent=0.5
 *
 * Idempotent : une règle ou une demande en attente portant le même code n'est
 * pas redéposée.
 */

const mongoose = require("mongoose");
const config = require("../src/config");
const { connectTransactionsDB, getPricingModel } = require("../src/config/db");
const { validateProposedRule } = require("../src/services/pricing/ruleValidation");

const APPLY = process.argv.includes("--apply");

function arg(name) {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3).trim() : null;
}

function percentArg(name, fallback) {
  const raw = arg(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw new Error(`--${name} invalide (« ${raw} ») : attendu un pourcentage entre 0 et 100.`);
  }
  return n;
}

function buildRule({ code, name, txType, percent, description }) {
  return {
    name,
    code,
    description,
    active: true,
    priority: 0,
    category: "fee",
    scope: {
      txType,
      method: "ALL",
      provider: "all",
      country: "ALL",
      fromCountry: "ALL",
      toCountry: "ALL",
      fromCurrency: "ALL",
      toCurrency: "ALL",
    },
    fee: { mode: "PERCENT", percent },
    fx: { mode: "PASS_THROUGH" },
    amountRange: { min: 0, max: null },
  };
}

async function main() {
  config.load({ strict: false });

  const requestedBy = arg("requested-by");

  if (APPLY && !mongoose.Types.ObjectId.isValid(String(requestedBy || ""))) {
    throw new Error(
      "--requested-by=<identifiant staff> est obligatoire avec --apply : une demande " +
        "de changement tarifaire a toujours un auteur identifié."
    );
  }

  const rules = [
    buildRule({
      code: "CAGNOTTE_PARTICIPATION_DEFAULT",
      name: "Cagnotte — frais de participation (défaut)",
      txType: "CAGNOTTE_PARTICIPATION",
      percent: percentArg("participation-percent", 0.25),
      description:
        "Frais par participation, avec ou sans conversion (décision 2026-09-10). " +
        "Reprend le taux historiquement codé en dur dans le backend.",
    }),
    buildRule({
      code: "CAGNOTTE_CLOSURE_DEFAULT",
      name: "Cagnotte — frais de clôture (défaut)",
      txType: "CAGNOTTE_CLOSURE",
      percent: percentArg("closure-percent", 0.5),
      description:
        "Frais prélevés sur le coffre à la clôture, sur le net collecté. Reprend " +
        "le taux historiquement codé en dur dans le backend.",
    }),
  ];

  for (const r of rules) {
    const verdict = validateProposedRule(r);
    if (!verdict.ok) {
      throw new Error(`Règle ${r.code} refusée par la validation tarifaire : ${verdict.error || verdict.reason}`);
    }
  }

  await connectTransactionsDB();

  const PricingRule = getPricingModel("PricingRule");
  const PricingChangeRequest = getPricingModel("PricingChangeRequest");

  console.log(`\n  Règles tarifaires de cagnotte — ${APPLY ? "DÉPÔT RÉEL" : "SIMULATION (--apply pour déposer)"}\n`);

  for (const r of rules) {
    const existingRule = await PricingRule.findOne({ code: r.code }).lean();
    if (existingRule) {
      console.log(`  = ${r.code} : règle déjà présente (active=${existingRule.active}). Rien à faire.`);
      continue;
    }

    const pending = await PricingChangeRequest.findOne({
      status: { $in: ["pending_approval", "approved"] },
      "proposed.code": r.code,
    }).lean();

    if (pending) {
      console.log(`  = ${r.code} : demande déjà en attente (${pending._id}). Rien à faire.`);
      continue;
    }

    console.log(`  + ${r.code} : ${r.scope.txType}, ${r.fee.percent} %, toutes devises.`);

    if (APPLY) {
      const doc = await PricingChangeRequest.create({
        action: "create",
        ruleId: null,
        proposed: r,
        baseVersion: null,
        status: "pending_approval",
        reason:
          "Module Cagnotte (2026-09-10) : les frais passent du code du backend au " +
          "moteur de tarification. Sans règle approuvée, participations et clôtures " +
          "sont refusées (PRICING_UNAVAILABLE).",
        requestedBy: { staffId: requestedBy, email: "", name: "seedCagnottePricingRules", at: new Date() },
      });
      console.log(`    → demande ${doc._id} déposée, EN ATTENTE D'APPROBATION par un second membre du staff.`);
    }
  }

  console.log(
    "\n  Tant que ces demandes ne sont pas approuvées, les participations et les " +
      "clôtures de cagnotte répondent 503 PRICING_UNAVAILABLE.\n"
  );
}

main()
  .catch((err) => {
    console.error(`\n  ❌ ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
