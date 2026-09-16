"use strict";

/**
 * ============================================================================
 * LA GRILLE PAR CORRIDOR — DÉPOSÉE POUR APPROBATION, JAMAIS PUBLIÉE
 * ============================================================================
 *
 * ── Ce que ce script complète ───────────────────────────────────────────────
 *
 * `seedRailPricingRules.js` a ouvert les rails avec UNE règle par (type × rail),
 * tous pays et toutes devises. Cela suffit à ne plus refuser en 404 ; cela ne
 * suffit pas à exploiter plusieurs marchés. Un dépôt Wave en Côte d'Ivoire et un
 * dépôt MTN au Cameroun n'ont pas la même commission, et un corridor EUR→XOF
 * n'a pas la même marge qu'un XOF→XOF — qui n'en a aucune.
 *
 * ── Rien n'est supprimé, tout est ajouté ────────────────────────────────────
 *
 * Les règles « tous pays » restent en place comme FILET. Le moteur retient
 * toujours la plus spécifique (`computeSpecificity`), donc une règle de cette
 * grille l'emporte automatiquement sur la règle générale correspondante. Il n'y
 * a ni suppression, ni trou pendant la transition, ni ordre de déploiement à
 * respecter.
 *
 * ── Ce que ce script ne décide pas ──────────────────────────────────────────
 *
 * Il ne fixe aucun prix. Il DÉPOSE des demandes (`pending_approval`) qu'un
 * second membre du staff approuve, modifie ou rejette une par une. Les valeurs
 * sont des CALAGES identiques partout — c'est le seul choix défendable pour une
 * proposition automatique : elles rendent la grille lisible, pas juste.
 *
 * ⚠️ La correspondance opérateur ↔ pays de `corridorGrid.js` est une HYPOTHÈSE.
 * Le code ne la déclare nulle part : les adaptateurs mobile money relaient
 * `input.country` sans rien en savoir. À confirmer avant d'approuver.
 *
 * Usage :
 *   node scripts/seedCorridorPricingRules.js                          # simulation
 *   node scripts/seedCorridorPricingRules.js --apply --requested-by=<staffId>
 *   options : --fee-percent=1 --markup-percent=1.5
 *
 * ⚠️ PAR NPM, LE SÉPARATEUR `--` EST OBLIGATOIRE. Sans lui, npm garde les
 * options pour lui et le script simule sans rien déposer :
 *   npm run seed:corridor-pricing -- --apply --requested-by=<staffId>
 *
 * `<staffId>` est un ObjectId complet (24 caractères hexadécimaux).
 */

const mongoose = require("mongoose");

const config = require("../src/config");
const { connectTransactionsDB, getPricingModel } = require("../src/config/db");
const { validateProposedRule } = require("../src/services/pricing/ruleValidation");
const {
  construireGrille,
  paysSansOperateur,
  devisesServies,
  MARCHES,
} = require("../src/services/pricing/corridorGrid");

const APPLY = process.argv.includes("--apply");

function arg(name) {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3).trim() : null;
}

/**
 * npm CONFISQUE les options qui ne lui sont pas adressées : `npm run x --apply`
 * ne transmet rien à `process.argv`, il pose `npm_config_apply` dans
 * l'environnement. Un dépôt tarifaire qui n'a pas lieu doit le DIRE plutôt que
 * de ressembler à une simulation demandée (règle B.1).
 */
function optionsConfisqueesParNpm() {
  const confisquees = [];

  if (!APPLY && process.env.npm_config_apply) confisquees.push("--apply");
  if (!arg("requested-by") && process.env.npm_config_requested_by) {
    confisquees.push("--requested-by");
  }

  return confisquees;
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

const MOTIF =
  "Grille par corridor (décision du 2026-09-16) : les rails étaient tarifés " +
  "par UNE règle « tous pays, toutes devises », ce qui ne permet pas " +
  "d'exploiter plusieurs marchés. ⚠️ VALEURS DE CALAGE À AJUSTER AVANT " +
  "APPROBATION — elles sont identiques partout, alors que les commissions " +
  "opérateur diffèrent par pays et par sens. ⚠️ La correspondance " +
  "opérateur ↔ pays est une hypothèse, non une donnée du code.";

async function main() {
  config.load({ strict: false });

  const confisquees = optionsConfisqueesParNpm();
  if (confisquees.length > 0) {
    throw new Error(
      `npm a intercepté ${confisquees.join(" et ")} au lieu de le transmettre ` +
        "au script : il manque le séparateur `--`. Rien n'a été écrit.\n" +
        "  npm run seed:corridor-pricing -- --apply --requested-by=<staffId>"
    );
  }

  const requestedBy = arg("requested-by");

  if (APPLY && !mongoose.Types.ObjectId.isValid(String(requestedBy || ""))) {
    throw new Error(
      "--requested-by=<identifiant staff> est obligatoire avec --apply : une " +
        "demande de changement tarifaire a toujours un auteur identifié."
    );
  }

  const feePercent = pourcentage("fee-percent", 1);
  const markupPercent = pourcentage("markup-percent", 1.5);

  const regles = construireGrille({ feePercent, markupPercent });

  for (const r of regles) {
    const verdict = validateProposedRule(r);
    if (!verdict.ok) {
      throw new Error(`Règle ${r.code} refusée par la validation tarifaire : ${verdict.message}`);
    }
  }

  await connectTransactionsDB();

  const PricingRule = getPricingModel("PricingRule");
  const PricingChangeRequest = getPricingModel("PricingChangeRequest");

  const orphelins = paysSansOperateur();

  console.log(
    `\n  Grille par corridor — ${APPLY ? "DÉPÔT RÉEL" : "SIMULATION (--apply pour déposer)"}`
  );
  console.log(
    `  ${MARCHES.length} marchés · ${devisesServies().length} devises · ` +
      `calage ${feePercent} % de frais, ${markupPercent} % de marge\n`
  );

  /**
   * Le VOLUME en premier. Chaque règle est une décision de prix à relire : le
   * nombre est ce qui permet de juger si la grille est exploitable AVANT d'en
   * déposer quatre-vingts.
   */
  const parType = new Map();
  for (const r of regles) {
    const cle = `${r.scope.txType} · ${r.scope.method}`;
    parType.set(cle, (parType.get(cle) || 0) + 1);
  }

  console.log(`  ${regles.length} règles construites :`);
  for (const [cle, n] of [...parType.entries()].sort()) {
    console.log(`    · ${cle} — ${n}`);
  }

  if (orphelins.length) {
    console.log(
      `\n  ⚠️ Aucun opérateur mobile money intégré pour : ${orphelins.join(", ")}.` +
        "\n     Ces pays ne reçoivent AUCUNE règle mobile money — la grille ne leur" +
        "\n     fabrique pas une couverture qu'ils n'ont pas."
    );
  }

  console.log("");

  let deposees = 0;
  let presentes = 0;
  let enCours = 0;

  for (const r of regles) {
    const existante = await PricingRule.findOne({ code: r.code }).lean();

    if (existante) {
      presentes += 1;
      continue;
    }

    const enAttente = await PricingChangeRequest.findOne({
      status: { $in: ["pending_approval", "approved"] },
      "proposed.code": r.code,
    }).lean();

    if (enAttente) {
      enCours += 1;
      continue;
    }

    if (!APPLY) {
      console.log(`  + ${r.code}`);
      deposees += 1;
      continue;
    }

    const doc = await PricingChangeRequest.create({
      action: "create",
      ruleId: null,
      proposed: r,
      baseVersion: null,
      status: "pending_approval",
      reason: MOTIF,
      requestedBy: {
        staffId: requestedBy,
        email: "",
        name: "seedCorridorPricingRules",
        at: new Date(),
      },
    });

    deposees += 1;
    console.log(`  + ${r.code} → demande ${doc._id}`);
  }

  console.log(
    `\n  ${presentes} déjà en base · ${enCours} déjà en attente · ` +
      `${deposees} ${APPLY ? "déposée(s)" : "à déposer"}.`
  );

  if (!APPLY) {
    console.log(
      "\n  Simulation : rien n'a été écrit. Relancer avec" +
        "\n  `npm run seed:corridor-pricing -- --apply --requested-by=<staffId>`."
    );
  } else {
    console.log(
      "\n  Ces demandes n'appliquent RIEN tant qu'un second membre du staff ne les" +
        "\n  a pas approuvées. Ajuster les valeurs dans /admin/pricing avant d'approuver," +
        "\n  puis vérifier avec `npm run pricing:coverage`."
    );
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
