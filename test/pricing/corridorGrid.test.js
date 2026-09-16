"use strict";

/**
 * ============================================================================
 * LA GRILLE PAR CORRIDOR NE FABRIQUE NI MARGE NI COUVERTURE
 * ============================================================================
 *
 * Deux défauts de la journée du 2026-09-16 pèsent sur ce fichier, et ce sont
 * eux qu'il empêche de revivre :
 *
 *   · une marge de change appliquée SANS conversion — un frais caché, absent de
 *     toute ligne de frais donc du reçu ;
 *   · des barèmes produits par produit cartésien pour des opérations qui
 *     n'existent pas (`DEPOSIT · INTERNAL`), approuvés puis inertes.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MARCHES,
  OPERATEURS_PAR_PAYS,
  devisesServies,
  paysSansOperateur,
  construireGrille,
} = require("../../src/services/pricing/corridorGrid");

const { validateProposedRule } = require("../../src/services/pricing/ruleValidation");

test("⚠️ aucune marge de change sur un corridor en devise identique", () => {
  /**
   * Le moteur impose un taux de 1 quand les deux devises sont identiques : une
   * marge y serait prélevée sans conversion, et n'apparaîtrait sur aucune ligne
   * de frais. Le validateur refuse d'ailleurs une marge en mode PASS_THROUGH.
   */
  for (const r of construireGrille()) {
    const { fromCurrency, toCurrency } = r.scope;

    if (fromCurrency !== toCurrency) continue;

    assert.equal(
      r.fx.mode,
      "PASS_THROUGH",
      `${r.code} applique une marge sans conversion`
    );
    assert.equal(r.fx.markupPercent, 0, r.code);
  }
});

test("la marge s'applique bien là où il y a conversion", () => {
  const converties = construireGrille({ markupPercent: 2 }).filter(
    (r) => r.scope.fromCurrency !== r.scope.toCurrency
  );

  assert.ok(converties.length > 0, "aucun corridor converti dans la grille");

  for (const r of converties) {
    assert.equal(r.fx.mode, "MARKUP_PERCENT", r.code);
    assert.equal(r.fx.markupPercent, 2, r.code);
  }
});

test("TOUTE règle produite passe la validation de gouvernance", () => {
  /**
   * Le défaut mesuré sur le premier script de seed : `provider: "all"` avec
   * `method: "INTERNAL"` était refusé au dépôt, après avoir parcouru toute la
   * grille. Mieux vaut l'apprendre ici qu'en base.
   */
  for (const r of construireGrille()) {
    const verdict = validateProposedRule(r);

    assert.equal(
      verdict.ok,
      true,
      `${r.code} refusée : ${verdict.message || ""}`
    );
  }
});

test("le virement interne reste sur `paynoval`", () => {
  for (const r of construireGrille()) {
    if (r.scope.method !== "INTERNAL") continue;
    assert.equal(r.scope.provider, "paynoval", r.code);
  }
});

test("dépôt et retrait portent TOUJOURS pays ET fournisseur ensemble", () => {
  /**
   * ⚠️ Mesuré dans `computeSpecificity` : `provider` vaut 45 points, `country`
   * seulement 20. Une règle épinglée sur un opérateur SANS pays battrait donc
   * toute règle pays ajoutée ensuite — et ces futurs tarifs seraient
   * silencieusement ignorés. Les deux dimensions voyagent ensemble.
   */
  for (const r of construireGrille()) {
    if (!["DEPOSIT", "WITHDRAW"].includes(r.scope.txType)) continue;

    assert.notEqual(r.scope.provider, "all", r.code);
    assert.notEqual(r.scope.country, "ALL", r.code);
  }
});

test("un dépôt ou un retrait ne change JAMAIS de devise", () => {
  for (const r of construireGrille()) {
    if (!["DEPOSIT", "WITHDRAW"].includes(r.scope.txType)) continue;
    assert.equal(r.scope.fromCurrency, r.scope.toCurrency, r.code);
  }
});

test("aucune règle mobile money pour un pays SANS opérateur", () => {
  /**
   * Le défaut `DEPOSIT · INTERNAL` en une phrase : une case produite par
   * produit cartésien, approuvée, et qui ne se déclenche jamais. Un pays sans
   * opérateur intégré ne doit produire aucune règle mobile money.
   */
  const orphelins = new Set(paysSansOperateur());
  assert.ok(orphelins.size > 0, "le cas n'est plus couvert par les données");

  for (const r of construireGrille()) {
    if (r.scope.method !== "MOBILEMONEY") continue;

    assert.equal(
      orphelins.has(r.scope.country),
      false,
      `${r.code} tarifie un pays sans opérateur intégré`
    );
  }
});

test("seuls les quatre opérateurs intégrés apparaissent", () => {
  const integres = new Set(["orange", "mtn", "moov", "wave"]);

  for (const operateurs of Object.values(OPERATEURS_PAR_PAYS)) {
    for (const o of operateurs) {
      assert.equal(integres.has(o), true, `opérateur non intégré : ${o}`);
    }
  }
});

test("aucun code de règle en double", () => {
  const codes = construireGrille().map((r) => r.code);
  const uniques = new Set(codes);

  assert.equal(
    codes.length,
    uniques.size,
    "deux règles partagent un code : le contrôle d'existence du seed en raterait une"
  );
});

test("les devises se DÉRIVENT des marchés, elles ne sont pas codées en dur", () => {
  const partiel = [
    { pays: "CI", devise: "XOF", zone: "UEMOA", nom: "Côte d'Ivoire" },
    { pays: "FR", devise: "EUR", zone: "EUROPE", nom: "France" },
  ];

  assert.deepEqual(devisesServies(partiel), ["EUR", "XOF"]);

  const grille = construireGrille({
    marches: partiel,
    operateursParPays: { CI: ["wave"], FR: [] },
  });

  const internes = grille.filter((r) => r.scope.method === "INTERNAL");
  assert.equal(internes.length, 4, "2 devises ⇒ 4 corridors internes");
});

test("chaque marché déclare une devise ISO", () => {
  for (const m of MARCHES) {
    assert.match(m.devise, /^[A-Z]{3}$/, m.pays);
    assert.match(m.pays, /^[A-Z]{2}$/, m.nom);
  }
});
