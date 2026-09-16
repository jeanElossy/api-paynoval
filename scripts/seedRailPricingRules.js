"use strict";

/**
 * ============================================================================
 * LES RAILS SANS BARÈME — DÉPOSÉS POUR APPROBATION, JAMAIS PUBLIÉS
 * ============================================================================
 *
 * ── Le constat qui motive ce script (mesuré le 2026-09-16) ──────────────────
 *
 * `npm run pricing:coverage` contre les bases `-test` : 8 règles actives, et la
 * seule chose tarifée est `TRANSFER/INTERNAL/paynoval` sur six corridors de pays
 * explicites. **Aucune règle** ne couvre `TRANSFER·MOBILEMONEY`,
 * `TRANSFER·CARD`, `DEPOSIT·*` ni `WITHDRAW·*` : ces rails refusent TOUTE
 * transaction en 404, quel que soit l'état du code.
 *
 * ── Ce que ce script propose, et ce qu'il ne décide pas ─────────────────────
 *
 * Il ne fixe aucun prix : il DÉPOSE des demandes de changement
 * (`pending_approval`) que vous approuvez, modifiez ou rejetez une par une dans
 * le back-office. Rien ne s'applique sans l'accord d'un second membre du staff.
 *
 * Les valeurs proposées ne sortent pas de nulle part : elles **recopient la
 * grille du transfert interne déjà en vigueur** — 1 % de frais, marge de change
 * de 1,5 % — mesurée dans la base le 2026-09-16. C'est le seul choix défendable
 * pour une proposition automatique : aligner sur ce que vous facturez déjà,
 * plutôt qu'inventer un tarif.
 *
 * ⚠️ Un rail n'a PAS le même coût de collecte ou de versement qu'un virement
 * interne. Mobile money et carte portent des commissions prestataire que le
 * transfert interne n'a pas. **Ces propositions sont un point de départ à
 * ajuster, pas une grille tarifaire réfléchie.** Chaque demande porte cet
 * avertissement dans son motif, pour que l'approbateur le lise.
 *
 * ── Portée volontairement LARGE ─────────────────────────────────────────────
 *
 * Une règle par (type × rail), toutes devises et tous pays. C'est huit
 * décisions à prendre plutôt que cinquante, et le moteur retient toujours la
 * règle la PLUS SPÉCIFIQUE : un barème précis déposé plus tard primera
 * automatiquement sur celui-ci, sans qu'il faille le retirer.
 *
 * Usage :
 *   node scripts/seedRailPricingRules.js                              # simulation
 *   node scripts/seedRailPricingRules.js --apply --requested-by=<staffId>
 *   options : --fee-percent=1 --markup-percent=1.5
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

function pourcentage(nom, defaut) {
  const brut = arg(nom);
  if (brut === null) return defaut;

  const n = Number(brut);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw new Error(`--${nom} invalide (« ${brut} ») : attendu un pourcentage entre 0 et 100.`);
  }
  return n;
}

/** Les rails qui refusent aujourd'hui toute transaction, faute de barème. */
const A_COUVRIR = [
  { txType: "TRANSFER", method: "MOBILEMONEY", libelle: "Transfert — Mobile Money" },
  { txType: "TRANSFER", method: "CARD", libelle: "Transfert — Carte" },
  { txType: "DEPOSIT", method: "INTERNAL", libelle: "Dépôt — PayNoval" },
  { txType: "DEPOSIT", method: "MOBILEMONEY", libelle: "Dépôt — Mobile Money" },
  { txType: "DEPOSIT", method: "CARD", libelle: "Dépôt — Carte" },
  { txType: "WITHDRAW", method: "INTERNAL", libelle: "Retrait — PayNoval" },
  { txType: "WITHDRAW", method: "MOBILEMONEY", libelle: "Retrait — Mobile Money" },
  { txType: "WITHDRAW", method: "CARD", libelle: "Retrait — Carte" },
];

function construireRegle({ txType, method, libelle, feePercent, markupPercent }) {
  return {
    name: libelle,
    code: `${txType}_${method}_DEFAULT`,
    description:
      `Barème par défaut pour ${libelle}. Recopie la grille du transfert interne ` +
      `en vigueur (${feePercent} % de frais, ${markupPercent} % de marge de change). ` +
      "À AJUSTER : ce rail porte des commissions prestataire que le transfert interne n'a pas.",
    active: true,
    priority: 0,
    category: "pricing",
    scope: {
      txType,
      method,

      /**
       * ⚠️ `INTERNAL` EXIGE `paynoval`, ET LA VALIDATION LE REFUSE SINON.
       *
       * Première version de ce script : `provider: "all"` partout. La
       * validation de gouvernance l'a arrêtée net — « pour la méthode PayNoval
       * interne, le fournisseur doit être paynoval ». C'est le contrôle qui
       * fait son travail, et c'est la bonne place pour qu'il le fasse : avant
       * le dépôt, pas au premier devis.
       *
       * Pour les rails externes, `all` est délibéré : le barème vaut pour tous
       * les opérateurs tant qu'aucune règle plus spécifique n'existe — et le
       * moteur retient toujours la plus spécifique.
       */
      provider: method === "INTERNAL" ? "paynoval" : "all",
      country: "ALL",
      fromCountry: "ALL",
      toCountry: "ALL",
      fromCurrency: "ALL",
      toCurrency: "ALL",
    },
    fee: { mode: "PERCENT", percent: feePercent },

    /**
     * La marge ne s'applique QU'EN CAS DE CONVERSION : depuis le 2026-09-16, le
     * moteur impose un taux de 1 quand les deux devises sont identiques, quelle
     * que soit la règle. Une règle « toutes devises » avec marge est donc sûre —
     * elle ne rabote pas les virements en devise identique.
     */
    fx: { mode: "MARKUP_PERCENT", markupPercent },
    amountRange: { min: 0, max: null },
  };
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

  const feePercent = pourcentage("fee-percent", 1);
  const markupPercent = pourcentage("markup-percent", 1.5);

  const regles = A_COUVRIR.map((r) =>
    construireRegle({ ...r, feePercent, markupPercent })
  );

  for (const r of regles) {
    const verdict = validateProposedRule(r);
    if (!verdict.ok) {
      throw new Error(`Règle ${r.code} refusée par la validation tarifaire : ${verdict.message}`);
    }
  }

  await connectTransactionsDB();

  const PricingRule = getPricingModel("PricingRule");
  const PricingChangeRequest = getPricingModel("PricingChangeRequest");

  console.log(
    `\n  Barèmes des rails non couverts — ${APPLY ? "DÉPÔT RÉEL" : "SIMULATION (--apply pour déposer)"}`
  );
  console.log(`  Grille proposée : ${feePercent} % de frais · ${markupPercent} % de marge de change\n`);

  let deposees = 0;

  for (const r of regles) {
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

    console.log(`  + ${r.code} : ${r.scope.txType}/${r.scope.method}, toutes devises, tous pays.`);

    if (APPLY) {
      const doc = await PricingChangeRequest.create({
        action: "create",
        ruleId: null,
        proposed: r,
        baseVersion: null,
        status: "pending_approval",
        reason:
          "Couverture tarifaire (mesure du 2026-09-16) : ce rail n'avait AUCUN " +
          "barème et refusait toute transaction en 404. Proposition alignée sur la " +
          "grille du transfert interne en vigueur. ⚠️ À AJUSTER AVANT APPROBATION : " +
          "mobile money et carte portent des commissions prestataire que le " +
          "transfert interne n'a pas.",
        requestedBy: {
          staffId: requestedBy,
          email: "",
          name: "seedRailPricingRules",
          at: new Date(),
        },
      });

      deposees += 1;
      console.log(`    → demande ${doc._id} déposée, EN ATTENTE D'APPROBATION.`);
    }
  }

  console.log(
    `\n  ${APPLY ? `${deposees} demande(s) déposée(s).` : "Simulation : rien n'a été écrit."}` +
      "\n  Tant qu'elles ne sont pas approuvées par un second membre du staff, ces rails" +
      "\n  continuent de refuser toute transaction (404). Vérifier ensuite avec" +
      "\n  `npm run pricing:coverage`.\n"
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
