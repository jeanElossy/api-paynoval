"use strict";

/**
 * ============================================================================
 * UNE MISE À JOUR TARIFAIRE N'EFFACE PLUS PAR OMISSION
 * ============================================================================
 *
 * Ce fichier fige le défaut MESURÉ en base le 2026-09-16 : une modification de
 * marge a effacé le code, la description et rétréci le périmètre fournisseur
 * d'un barème. Trois champs perdus pour un seul voulu.
 *
 * Le premier test rejoue cette demande exacte, telle qu'elle a été enregistrée.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { fusionnerProposed } = require("../../src/services/pricing/proposedMerge");

const RACINE = path.join(__dirname, "..", "..");
const CONTROLEUR = "src/controllers/pricing/pricingChangeRequestsController.js";

/** L'état réel de la règle avant la modification (snapshot v1). */
const BASE = Object.freeze({
  name: "Transfert — Mobile Money",
  code: "TRANSFER_MOBILEMONEY_DEFAULT",
  description: "Barème par défaut pour Transfert — Mobile Money.",
  notes: "",
  active: true,
  priority: 0,
  category: "pricing",
  service: "all",
  scope: {
    txType: "TRANSFER",
    method: "MOBILEMONEY",
    provider: "all",
    country: "ALL",
    fromCountry: "ALL",
    toCountry: "ALL",
    fromCurrency: "ALL",
    toCurrency: "ALL",
  },
  countries: [],
  operators: [],
  amountRange: { min: 0, max: null },
  fee: { mode: "PERCENT", fixed: 0, percent: 1, minFee: null, maxFee: null },
  fx: { mode: "MARKUP_PERCENT", overrideRate: null, markupPercent: 1.5, percent: 0, deltaAbs: 0, notes: "" },
  startsAt: null,
  endsAt: null,
  archivedAt: null,
});

/** Ce que `normalizeProposed` fabrique quand le corps n'a QUE la marge. */
const NORMALISE_SANS_CODE = Object.freeze({
  name: "",
  code: null,
  description: "",
  notes: "",
  active: true,
  priority: 0,
  category: "pricing",
  service: "all",
  scope: {
    txType: "ALL",
    method: "ALL",
    provider: "all",
    country: "ALL",
    fromCountry: "ALL",
    toCountry: "ALL",
    fromCurrency: undefined,
    toCurrency: undefined,
  },
  countries: [],
  operators: [],
  amountRange: { min: 0, max: null },
  fee: { mode: "NONE", fixed: 0, percent: 0, minFee: null, maxFee: null },
  fx: { mode: "MARKUP_PERCENT", overrideRate: null, markupPercent: 3, percent: 0, deltaAbs: 0, notes: "" },
  startsAt: null,
  endsAt: null,
});

test("⚠️ LE DÉFAUT : modifier une marge n'efface plus le code ni la description", () => {
  const brut = { fx: { mode: "MARKUP_PERCENT", markupPercent: 3 } };

  const apres = fusionnerProposed({ base: BASE, brut, normalise: NORMALISE_SANS_CODE });

  assert.equal(apres.code, "TRANSFER_MOBILEMONEY_DEFAULT", "le code a été effacé");
  assert.equal(
    apres.description,
    "Barème par défaut pour Transfert — Mobile Money.",
    "la description a été effacée"
  );
  assert.equal(apres.name, "Transfert — Mobile Money", "le nom a été effacé");
  assert.equal(apres.fx.markupPercent, 3, "le seul changement voulu n'a pas été appliqué");
});

test("le périmètre ne se rétrécit pas tout seul", () => {
  /**
   * `scope.provider` valait `all` : quatre opérateurs mobile money tarifés.
   * Le passage à un seul opérateur a fait refuser les trois autres en 404.
   * Il doit rester possible — mais seulement si on le DEMANDE.
   */
  const brut = { fx: { markupPercent: 3 } };
  const apres = fusionnerProposed({ base: BASE, brut, normalise: NORMALISE_SANS_CODE });

  assert.equal(apres.scope.provider, "all");
  assert.equal(apres.scope.txType, "TRANSFER");
  assert.equal(apres.scope.method, "MOBILEMONEY");
  assert.equal(apres.scope.fromCurrency, "ALL", "une devise absente ne devient pas `undefined`");
});

test("un rétrécissement EXPLICITE reste possible", () => {
  const brut = { scope: { provider: "wave" } };
  const normalise = { ...NORMALISE_SANS_CODE, scope: { ...NORMALISE_SANS_CODE.scope, provider: "wave" } };

  const apres = fusionnerProposed({ base: BASE, brut, normalise });

  assert.equal(apres.scope.provider, "wave", "ce qui est demandé doit s'appliquer");
  assert.equal(apres.scope.method, "MOBILEMONEY", "le reste du périmètre est préservé");
  assert.equal(apres.code, "TRANSFER_MOBILEMONEY_DEFAULT");
});

test("vider un champ reste possible, mais devient un ACTE explicite", () => {
  const brut = { code: null };
  const apres = fusionnerProposed({ base: BASE, brut, normalise: NORMALISE_SANS_CODE });

  assert.equal(apres.code, null, "un `null` transmis doit vider le champ");
  assert.equal(apres.description, BASE.description, "le reste ne bouge pas");
});

test("un sous-objet partiel ne rabote pas ses voisins", () => {
  /**
   * Le même défaut, un cran plus bas : envoyer le seul pourcentage ne doit pas
   * effacer les bornes `minFee`/`maxFee`, qui plafonnent ce que paie le client.
   */
  const base = { ...BASE, fee: { mode: "PERCENT", fixed: 0, percent: 1, minFee: 100, maxFee: 5000 } };
  const brut = { fee: { percent: 2 } };
  const normalise = { ...NORMALISE_SANS_CODE, fee: { mode: "NONE", fixed: 0, percent: 2, minFee: null, maxFee: null } };

  const apres = fusionnerProposed({ base, brut, normalise });

  assert.equal(apres.fee.percent, 2);
  assert.equal(apres.fee.minFee, 100, "le plancher de frais a été effacé");
  assert.equal(apres.fee.maxFee, 5000, "le plafond de frais a été effacé");
  assert.equal(apres.fee.mode, "PERCENT", "le mode non transmis a été écrasé par un défaut");
});

test("une CRÉATION n'est pas fusionnée — il n'y a rien à préserver", () => {
  const apres = fusionnerProposed({ base: null, brut: {}, normalise: NORMALISE_SANS_CODE });
  assert.deepEqual(apres, NORMALISE_SANS_CODE);
});

test("le contrôleur IMPORTE et APPELLE la fusion sur une mise à jour", () => {
  /**
   * ⚠️ Garde de TEXTE, et j'en assume la faiblesse — elle vaut mieux que le
   * silence actuel.
   *
   * `fusionnerProposed` est appelée DANS `exports.create`. Un import manquant
   * ne lève donc qu'au moment de l'appel, pas au chargement du module. Or aucun
   * test n'exécute ce contrôleur : la suite resterait verte avec le câblage
   * rompu, et le dépôt d'une demande échouerait en production.
   *
   * Ce n'est pas une hypothèse : j'ai écrit l'appel sans l'import en corrigeant
   * ce défaut, et rien ne l'a signalé.
   */
  const source = fs.readFileSync(path.join(RACINE, CONTROLEUR), "utf8");

  assert.match(
    source,
    /require\(\s*["'][^"']*pricing\/proposedMerge["']\s*\)/,
    "Le contrôleur n'importe plus `proposedMerge` : l'appel lèvera un ReferenceError au premier dépôt de demande."
  );

  assert.match(
    source,
    /fusionnerProposed\s*\(/,
    "La fusion n'est plus appelée : une mise à jour redeviendra un remplacement, et effacera les champs non transmis."
  );

  assert.match(
    source,
    /action\s*===\s*["']update["']/,
    "La fusion n'est plus conditionnée à l'action `update`."
  );
});

test("les champs hors formulaire survivent à une mise à jour", () => {
  /**
   * `archivedAt` n'est produit par aucun formulaire. Il ne doit pas disparaître
   * parce qu'une marge a changé.
   */
  const base = { ...BASE, archivedAt: null, countries: ["CI", "FR"], operators: ["wave"] };
  const apres = fusionnerProposed({ base, brut: { fx: { markupPercent: 3 } }, normalise: NORMALISE_SANS_CODE });

  assert.deepEqual(apres.countries, ["CI", "FR"]);
  assert.deepEqual(apres.operators, ["wave"]);
  assert.ok("archivedAt" in apres);
});
