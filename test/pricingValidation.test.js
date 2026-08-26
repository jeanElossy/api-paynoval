"use strict";

/**
 * ============================================================================
 * VALIDATION DU DEVIS DE TARIFICATION — LA FRONTIÈRE AVEC LA PASSERELLE
 * ============================================================================
 *
 * TX Core ne calcule pas les prix, il les demande. Ces tests portent sur ce que
 * la frontière REFUSE : un devis incomplet ne doit plus produire un virement
 * sans frais, ni un virement libellé dans une devise que personne n'a demandée.
 *
 * Les deux cas légitimes — frais nuls, taux de marché absent — sont testés
 * explicitement : un contrôle qui les rejetterait casserait des corridors
 * réels.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const {
  readNumber,
  readCurrency,
  decimalsFor,
  toleranceFor,
  validatePricingQuote,
} = require("../src/services/transactions/shared/pricingValidation");

/** Devis cohérent : 100 CAD, 2 de frais, taux 450 → 44 100 XOF. */
const devisValide = {
  request: { fromCurrency: "CAD", toCurrency: "XOF" },
  result: { grossFrom: 100, fee: 2, netFrom: 98, netTo: 44100, appliedRate: 450 },
};

const entree = { fromCurrency: "CAD", toCurrency: "XOF", amount: 100 };

/* -------------------------------------------------------------------------- */
/* Lecture sans invention                                                     */
/* -------------------------------------------------------------------------- */

test("readNumber distingue « absent » de « zéro » — toute la différence", () => {
  /**
   * `toFloat(x, 0)` était par construction incapable de les distinguer. Sur un
   * chemin financier, les confondre revient à facturer zéro parce qu'on n'a pas
   * su lire le prix.
   */
  assert.equal(readNumber(0), 0);
  assert.equal(readNumber(null), null);
  assert.equal(readNumber(undefined), null);
  assert.equal(readNumber(""), null);
  assert.equal(readNumber("abc"), null);
  assert.equal(readNumber(NaN), null);
});

test("readNumber accepte la virgule décimale et les chaînes", () => {
  assert.equal(readNumber("12,5"), 12.5);
  assert.equal(readNumber("12.5"), 12.5);
});

test("readCurrency n'accepte qu'un code ISO à trois lettres", () => {
  assert.equal(readCurrency("xof"), "XOF");
  assert.equal(readCurrency("  eur "), "EUR");
  assert.equal(readCurrency("F CFA"), null, "un symbole n'est pas un code");
  assert.equal(readCurrency("€"), null);
  assert.equal(readCurrency(""), null);
  assert.equal(readCurrency(null), null);
});

test("readCurrency prend la première valeur exploitable", () => {
  assert.equal(readCurrency(null, "", "€", "cad"), "CAD");
});

test("les devises sans décimale sont connues", () => {
  assert.equal(decimalsFor("XOF"), 0);
  assert.equal(decimalsFor("xaf"), 0);
  assert.equal(decimalsFor("CAD"), 2);
  assert.equal(toleranceFor("XOF"), 1, "l'arrondi XOF est à l'unité");
  assert.equal(toleranceFor("EUR"), 0.01);
});

/* -------------------------------------------------------------------------- */
/* Ce qui passe                                                               */
/* -------------------------------------------------------------------------- */

test("un devis complet et cohérent est accepté", () => {
  const out = validatePricingQuote(devisValide, entree);

  assert.equal(out.ok, true);
  assert.deepEqual(out.errors, []);
  assert.equal(out.values.fee, 2);
  assert.equal(out.values.fromCurrency, "CAD");
  assert.equal(out.values.toCurrency, "XOF");
});

test("CAS LÉGITIME — des frais nuls sont un vrai prix", () => {
  /**
   * Un corridor sans frais existe. Un contrôle qui le rejetterait empêcherait
   * une opération parfaitement valide.
   */
  const out = validatePricingQuote(
    {
      request: { fromCurrency: "CAD", toCurrency: "XOF" },
      result: { grossFrom: 100, fee: 0, netFrom: 100, netTo: 45000, appliedRate: 450 },
    },
    entree
  );

  assert.equal(out.ok, true, out.errors.join(" ; "));
  assert.equal(out.values.fee, 0);
});

test("CAS LÉGITIME — un taux de marché absent n'est pas exigé", () => {
  /**
   * Quand une règle impose un taux (`fx.overrideRate`), il n'existe aucun taux
   * de marché à citer et la passerelle renvoie `null`. L'exiger casserait tous
   * les corridors à taux imposé.
   */
  const out = validatePricingQuote(
    {
      request: { fromCurrency: "CAD", toCurrency: "XOF" },
      result: { ...devisValide.result, marketRate: null },
    },
    entree
  );

  assert.equal(out.ok, true, out.errors.join(" ; "));
});

test("les devises peuvent venir de l'entrée : c'est nous qui les avons demandées", () => {
  const out = validatePricingQuote({ request: {}, result: devisValide.result }, entree);

  assert.equal(out.ok, true, out.errors.join(" ; "));
  assert.equal(out.values.fromCurrency, "CAD");
});

test("la tolérance absorbe l'arrondi séparé de chaque champ", () => {
  // La passerelle arrondit grossFrom, fee et netFrom indépendamment.
  const out = validatePricingQuote(
    {
      request: { fromCurrency: "EUR", toCurrency: "EUR" },
      result: { grossFrom: 100, fee: 2.005, netFrom: 98, netTo: 98, appliedRate: 1 },
    },
    { fromCurrency: "EUR", toCurrency: "EUR" }
  );

  assert.equal(out.ok, true, out.errors.join(" ; "));
});

/* -------------------------------------------------------------------------- */
/* Ce qui est refusé                                                          */
/* -------------------------------------------------------------------------- */

test("DÉFAUT CORRIGÉ — des frais absents ne valent plus zéro", () => {
  const { fee, ...sansFrais } = devisValide.result;
  const out = validatePricingQuote({ ...devisValide, result: sansFrais }, entree);

  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => e.includes("result.fee absent")));
});

test("DÉFAUT CORRIGÉ — un montant reçu absent ne vaut plus zéro", () => {
  const { netTo, ...sansNetTo } = devisValide.result;
  const out = validatePricingQuote({ ...devisValide, result: sansNetTo }, entree);

  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => e.includes("result.netTo absent")));
});

test("DÉFAUT CORRIGÉ — plus aucun repli en dur sur une devise", () => {
  /**
   * Le code repliait sur « CAD » : un devis sans devise produisait un virement
   * libellé dans une monnaie que personne n'avait demandée.
   */
  const out = validatePricingQuote({ request: {}, result: devisValide.result }, {});

  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => e.includes("fromCurrency")));
  assert.equal(out.values, null);
});

test("un taux nul est refusé — il n'était plus enregistré que comme 0", () => {
  const out = validatePricingQuote(
    { ...devisValide, result: { ...devisValide.result, appliedRate: 0, netTo: 0 } },
    entree
  );

  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => e.includes("appliedRate")));
});

test("des frais négatifs sont refusés", () => {
  const out = validatePricingQuote(
    { ...devisValide, result: { ...devisValide.result, fee: -1, netFrom: 101 } },
    entree
  );

  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => e.includes("result.fee négatif")));
});

test("un montant envoyé nul est refusé", () => {
  const out = validatePricingQuote(
    { ...devisValide, result: { ...devisValide.result, grossFrom: 0, netFrom: -2 } },
    entree
  );

  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => e.includes("grossFrom")));
});

/* -------------------------------------------------------------------------- */
/* Cohérence arithmétique                                                     */
/* -------------------------------------------------------------------------- */

test("un devis dont les montants ne s'additionnent pas est refusé", () => {
  /**
   * Même esprit que la balance de vérification du grand livre : on ne contrôle
   * pas que les champs existent, on contrôle qu'ils racontent la même histoire.
   */
  const out = validatePricingQuote(
    { ...devisValide, result: { ...devisValide.result, netFrom: 50 } },
    entree
  );

  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => e.includes("netFrom")));
});

test("un montant reçu incompatible avec le taux est refusé", () => {
  const out = validatePricingQuote(
    { ...devisValide, result: { ...devisValide.result, netTo: 1 } },
    entree
  );

  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => e.includes("netTo")));
});

test("toutes les erreurs sont rendues, pas seulement la première", () => {
  // Un message qui ne cite qu'un champ sur quatre fait corriger la
  // configuration en quatre allers-retours.
  const out = validatePricingQuote({ request: {}, result: {} }, {});

  assert.equal(out.ok, false);
  assert.ok(out.errors.length >= 5, `attendu ≥5 erreurs, reçu ${out.errors.length}`);
});

test("une charge vide ne fait pas lever", () => {
  assert.equal(validatePricingQuote().ok, false);
  assert.equal(validatePricingQuote(null, null).ok, false);
});

/* -------------------------------------------------------------------------- */
/* Le câblage                                                                 */
/* -------------------------------------------------------------------------- */

test("plus aucun repli silencieux ne subsiste dans extractPricingBundle", () => {
  const source = fs
    .readFileSync(require.resolve("../src/services/transactions/shared/pricing"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  const bloc = source.slice(source.indexOf("function extractPricingBundle"));

  assert.ok(bloc.includes("validatePricingQuote("), "la validation doit être appelée");
  assert.ok(!/pickCurrency\([^)]*"CAD"/s.test(bloc), 'le repli en dur "CAD" doit avoir disparu');
  assert.ok(!/toFloat\(\s*pricingSnapshot\?\.result\?\.fee/.test(bloc), "les frais ne se replient plus sur 0");
  assert.ok(
    !/toFloat\(\s*pricingSnapshot\?\.result\?\.appliedRate/.test(bloc),
    "le taux ne se replie plus sur 0"
  );
});

test("un devis invalide fait échouer l'initiation, il ne la laisse pas passer", () => {
  const source = fs
    .readFileSync(require.resolve("../src/services/transactions/shared/pricing"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  assert.match(source, /if \(!controle\.ok\)/);
  assert.match(source, /throw createError\(\s*502/);
});
