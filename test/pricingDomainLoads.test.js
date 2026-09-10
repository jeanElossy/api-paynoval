"use strict";

/**
 * ============================================================================
 * LE DOMAINE DE LA TARIFICATION SE CHARGE RÉELLEMENT
 * ============================================================================
 *
 * ── Pourquoi ce test existe ─────────────────────────────────────────────────
 *
 * Le domaine des prix a été déplacé de l'API Gateway vers Tx-Core le
 * 2026-09-10 : 8 modèles, 10 services, 5 contrôleurs, 6 routes.
 *
 * Pendant ce déplacement, `node --check` a validé la SYNTAXE de chaque fichier
 * — et laissé passer DEUX dépendances manquantes :
 *
 *   · `services/cache/cacheService`, requis par `fxRulesService`, resté dans la
 *     passerelle ;
 *   · `services/rateLimitStore`, qui n'a pas d'équivalent dans ce dépôt (le
 *     client Redis y est construit dans `server.js`, sans accesseur partagé).
 *
 * `node --check` ne suit pas les `require` : il ne peut pas voir cela. Un
 * contrôle de syntaxe ne dit pas qu'un module fonctionne, il dit qu'il est
 * grammatical. Les deux défauts n'auraient été découverts qu'au premier devis
 * en production — c'est-à-dire au pire moment.
 *
 * ── Ce que ce test garantit, et ce qu'il ne garantit pas ────────────────────
 *
 * Il garantit que chaque module du domaine se CHARGE : ses `require` se
 * résolvent, son code de niveau module s'exécute. Il ne dit rien de son
 * comportement — c'est le travail des autres fichiers de `test/pricing/`.
 *
 * ⚠️ Il exige aussi qu'aucun module ne touche la base AU CHARGEMENT. Aucune
 * connexion n'est ouverte ici : si un modèle était résolu en tête de fichier
 * plutôt qu'à l'appel, ce test échouerait — ce qui est exactement la propriété
 * qu'on veut tenir, puisque Tx-Core ouvre des connexions NOMMÉES qui n'existent
 * pas au `require`.
 *
 * Test **pur** : aucune connexion, aucun serveur.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const MODULES = [
  // Modèles — forme fabrique, aucun effet au chargement.
  "../src/models/pricing/PricingRule",
  "../src/models/pricing/PricingRuleVersion",
  "../src/models/pricing/PricingQuote",
  "../src/models/pricing/PricingCoverageGap",
  "../src/models/pricing/PricingChangeRequest",
  "../src/models/pricing/Fee",
  "../src/models/pricing/FxRule",
  "../src/models/pricing/ExchangeRate",

  // Services.
  "../src/services/pricing/pricingEngine",
  "../src/services/pricing/ruleCache",
  "../src/services/pricing/coverage",
  "../src/services/pricing/exchangeRateService",
  "../src/services/pricing/fxRulesService",
  "../src/services/pricing/quoteService",
  "../src/services/pricing/diff",
  "../src/services/pricing/governanceRules",
  "../src/services/pricing/governanceService",
  "../src/services/pricing/ruleValidation",
  "../src/services/cache/cacheService",
  "../src/services/cache/cacheKeys",
  "../src/services/redisClientAccessor",

  // Contrôleurs.
  "../src/controllers/pricingController",
  "../src/controllers/pricing/feesController",
  "../src/controllers/pricing/fxRulesController",
  "../src/controllers/pricing/pricingRulesController",
  "../src/controllers/pricing/pricingChangeRequestsController",
  "../src/controllers/pricing/exchangeRatesController",

  // Routes.
  "../src/routes/pricingRoutes",
  "../src/routes/feesRoutes",
  "../src/routes/fxRulesRoutes",
  "../src/routes/pricingRulesRoutes",
  "../src/routes/pricingChangeRequestsRoutes",
  "../src/routes/exchangeRatesRoutes",

  // Le pont qui ne passe plus par le réseau.
  "../src/services/transactions/shared/pricing",
];

for (const chemin of MODULES) {
  test(`se charge : ${chemin.replace("../src/", "")}`, () => {
    assert.doesNotThrow(
      () => require(chemin),
      `${chemin} ne se charge pas — une dépendance manque ou n'a pas suivi le ` +
        "déplacement. `node --check` ne voit pas ce défaut : il valide la " +
        "grammaire, pas la résolution des `require`."
    );
  });
}

test("les 8 modèles s'instancient sur une connexion et gardent leur nom", () => {
  const mongoose = require("mongoose");
  const conn = mongoose.createConnection();

  const attendus = [
    "PricingRule",
    "PricingRuleVersion",
    "PricingQuote",
    "PricingCoverageGap",
    "PricingChangeRequest",
    "Fee",
    "FxRule",
    "ExchangeRate",
  ];

  for (const nom of attendus) {
    const fabrique = require(`../src/models/pricing/${nom}`);

    assert.equal(
      typeof fabrique,
      "function",
      `${nom} doit être une FABRIQUE (conn) => Model. Un modèle lié à la ` +
        "connexion globale s'attacherait à la mauvaise base EN SILENCE, et " +
        "lirait une collection vide au lieu d'échouer."
    );

    const Model = fabrique(conn);
    assert.equal(Model.modelName, nom);
  }
});

test("aucune fabrique n'accepte une connexion absente", () => {
  /**
   * Rendre un modèle sur `undefined` produirait un objet inutilisable dont la
   * première requête échouerait loin de la cause. On lève au point d'appel.
   */
  for (const nom of ["PricingRule", "Fee", "FxRule", "ExchangeRate"]) {
    assert.throws(
      () => require(`../src/models/pricing/${nom}`)(null),
      /connexion Mongoose requise/,
      `${nom} doit refuser une connexion absente`
    );
  }
});

test("le pont de tarification ne connaît plus la passerelle", () => {
  const fs = require("node:fs");
  const path = require("node:path");

  const src = fs
    .readFileSync(
      path.join(__dirname, "../src/services/transactions/shared/pricing.js"),
      "utf8"
    )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  /**
   * ⚠️ L'ASSERTION QUI COMPTE. Tant que ce module postait sur
   * `${GATEWAY_URL}/pricing/quote`, le moteur d'argent dépendait du bord : une
   * panne de la passerelle arrêtait les virements de l'intérieur.
   */
  assert.ok(!src.includes("GATEWAY_URL"));
  assert.ok(!src.includes("axios"));
  assert.match(src, /require\("\.\.\/\.\.\/pricing\/quoteService"\)/);
});
