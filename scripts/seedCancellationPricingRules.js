"use strict";

/**
 * ============================================================================
 * FRAIS D'ANNULATION — DÉPOSÉS POUR APPROBATION, JAMAIS PUBLIÉS
 * ============================================================================
 *
 * Depuis le 2026-09-16, les frais d'annulation se lisent dans les barèmes
 * `PricingRule` de type `CANCELLATION`, comme le reste des prix. Ils vivaient
 * auparavant dans TROIS sources qui pouvaient se contredire :
 *
 *   1. `config/cancellationFees.js` — table codée en dur (Canada 2,99 CAD,
 *      Côte d'Ivoire 300 XOF, puis un repli par devise), qui PRÉLEVAIT ;
 *   2. la collection `Fee`, qui AFFICHAIT ;
 *   3. un repli inventé dans l'endpoint de simulation (2,99 / 300 / 2).
 *
 * Ce script reproduit les montants HISTORIQUES — il ne décide d'aucun tarif —
 * et il ne les publie pas : il dépose des demandes de changement
 * (`pending_approval`). Un second membre du staff les approuve dans le
 * back-office. Le principe des quatre yeux vaut aussi pour ces frais-là.
 *
 * ⚠️ Tant que ces demandes ne sont pas approuvées, l'annulation continue de
 * fonctionner sur la table statique — en le DISANT à chaque fois dans les
 * journaux. C'est délibéré : refuser une annulation faute de barème
 * reviendrait à retenir les fonds d'un utilisateur qui demande à les libérer.
 *
 * Usage :
 *   node scripts/seedCancellationPricingRules.js                            # simulation
 *   node scripts/seedCancellationPricingRules.js --apply --requested-by=<staffId>
 */

const mongoose = require("mongoose");

const config = require("../src/config");
const { connectTransactionsDB, getPricingModel } = require("../src/config/db");
const { validateProposedRule } = require("../src/services/pricing/ruleValidation");
const { CANCELLATION_FEES_BY_COUNTRY } = require("../src/config/cancellationFees");

const APPLY = process.argv.includes("--apply");

function arg(name) {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3).trim() : null;
}

/**
 * Un barème par pays historiquement tarifé, dans SA devise.
 *
 * ⚠️ La devise compte : un montant fixe n'a de sens que rapporté à une monnaie.
 * 2,99 CAD et 300 XOF ne sont pas « le même tarif exprimé deux fois », ce sont
 * deux décisions distinctes — et c'est pourquoi chacune devient une règle.
 */
function reglesDepuisLaTableHistorique() {
  return Object.values(CANCELLATION_FEES_BY_COUNTRY).map((entree) => ({
    name: `Annulation — ${entree.countryName}`,
    code: `CANCELLATION_${entree.countryCode}_DEFAULT`,
    description:
      `Frais d'annulation pour ${entree.countryName} (${entree.label}). ` +
      "Reprend le montant historiquement codé en dur dans config/cancellationFees.js.",
    active: true,
    priority: 0,
    category: "fee",
    scope: {
      txType: "CANCELLATION",
      method: "ALL",
      provider: "all",
      country: entree.countryCode,
      fromCountry: entree.countryCode,
      toCountry: "ALL",
      fromCurrency: entree.currency,
      toCurrency: entree.currency,
    },
    fee: { mode: "FIXED", fixed: entree.amount },
    fx: { mode: "PASS_THROUGH" },
    amountRange: { min: 0, max: null },
  }));
}

async function main() {
  config.load({ strict: false });

  const requestedBy = arg("requested-by");

  if (APPLY && !mongoose.Types.ObjectId.isValid(String(requestedBy || ""))) {
    throw new Error(
      "--requested-by=<identifiant staff> est obligatoire avec --apply : une " +
        "demande de changement tarifaire a toujours un auteur identifié."
    );
  }

  const rules = reglesDepuisLaTableHistorique();

  for (const r of rules) {
    const verdict = validateProposedRule(r);
    if (!verdict.ok) {
      throw new Error(`Règle ${r.code} refusée par la validation tarifaire : ${verdict.message}`);
    }
  }

  await connectTransactionsDB();

  const PricingRule = getPricingModel("PricingRule");
  const PricingChangeRequest = getPricingModel("PricingChangeRequest");

  console.log(
    `\n  Frais d'annulation — ${APPLY ? "DÉPÔT RÉEL" : "SIMULATION (--apply pour déposer)"}\n`
  );

  for (const r of rules) {
    const existante = await PricingRule.findOne({ code: r.code }).lean();

    if (existante) {
      console.log(`  = ${r.code} : règle déjà présente (active=${existante.active}). Rien à faire.`);
      continue;
    }

    const enAttente = await PricingChangeRequest.findOne({
      status: { $in: ["pending_approval", "approved"] },
      "proposed.code": r.code,
    }).lean();

    if (enAttente) {
      console.log(`  = ${r.code} : demande déjà en attente (${enAttente._id}). Rien à faire.`);
      continue;
    }

    console.log(
      `  + ${r.code} : ${r.fee.fixed} ${r.scope.fromCurrency} (${r.scope.country})`
    );

    if (APPLY) {
      const doc = await PricingChangeRequest.create({
        action: "create",
        ruleId: null,
        proposed: r,
        baseVersion: null,
        status: "pending_approval",
        reason:
          "Frais d'annulation (2026-09-16) : passage de la table codée en dur au " +
          "moteur de tarification gouverné. Trois sources se contredisaient — " +
          "celle qui prélevait, celle qui affichait, et un repli inventé.",
        requestedBy: {
          staffId: requestedBy,
          email: "",
          name: "seedCancellationPricingRules",
          at: new Date(),
        },
      });

      console.log(
        `    → demande ${doc._id} déposée, EN ATTENTE D'APPROBATION par un second membre du staff.`
      );
    }
  }

  console.log(
    "\n  Tant que ces demandes ne sont pas approuvées, l'annulation applique la " +
      "table statique\n  et le journal le signale à chaque prélèvement.\n"
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
