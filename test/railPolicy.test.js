"use strict";

/**
 * Politique des rails.
 *
 * Régression visée : `AFRICA_DISABLED_DEBIT_METHODS` et le badge « bientôt
 * disponible » n'existaient que dans des écrans React Native. Une requête
 * forgée passait outre — §11 interdit une validation locale non dupliquée.
 *
 * Deux propriétés comptent également ici, et la seconde autant que la première :
 *   — la règle refuse bien ce qu'elle doit refuser ;
 *   — elle ne refuse RIEN tant que `RAIL_POLICY_STRICT` n'est pas activée.
 *
 * La seconde est ce qui rend la mise en service sûre : on installe la règle,
 * on lit les journaux `[RAIL-POLICY][WOULD-BLOCK]` pendant un cycle d'usage,
 * puis on bascule. Un test qui ne vérifierait que le refus laisserait passer
 * une activation accidentelle.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  evaluateRailPolicy,
  loadPolicy,
  isRestrictedProfile,
} = require("../src/services/transactions/shared/railPolicy");

/**
 * Ces tests portent sur le MÉCANISME de la politique — normalisation des pays,
 * rôle de la devise, régime report-only, pilotage par variable — et non sur la
 * liste de rails effectivement restreinte, qui est une décision produit.
 *
 * Ils fournissaient auparavant un environnement vierge et s'appuyaient sur le
 * défaut `["stripe"]`. Ce couplage les a fait tomber en bloc le 2026-09-08,
 * quand `stripe` est sorti du périmètre et que la liste est devenue vide : la
 * mécanique n'avait pourtant pas changé d'un iota. Le rail restreint est donc
 * désormais POSÉ ici, ce qui rend ces tests indépendants du catalogue produit.
 *
 * `RAIL_POLICY_RESTRICTED_RAILS` non vide + `RAIL_POLICY_STRICT` absente =
 * exactement le régime qu'on veut éprouver.
 */
const RAIL_TEMOIN = "un_rail_restreint";
const ENV = { RAIL_POLICY_RESTRICTED_RAILS: RAIL_TEMOIN };

test("un compte ivoirien ne peut pas débiter par un rail restreint", () => {
  const verdict = evaluateRailPolicy({
    country: "Côte d'Ivoire",
    funds: RAIL_TEMOIN,
    destination: "paynoval",
    env: ENV,
  });

  assert.equal(verdict.allowed, false);
  assert.equal(verdict.violations[0].rail, RAIL_TEMOIN);
  assert.equal(verdict.violations[0].side, "funds");
  assert.equal(verdict.violations[0].reason, "RAIL_RESTRICTED_FOR_REGION");
});

test("la devise suffit, même sans pays renseigné", () => {
  // Un compte dont la devise est XOF opère dans la zone même si le pays est
  // absent ou mal saisi — c'est la règle du mobile, et elle est la bonne.
  // Le rail employé ici est un TÉMOIN, pas un rail du produit : la propriété
  // testée est que la DEVISE suffit à situer le compte dans la zone.
  const verdict = evaluateRailPolicy({
    currency: "XOF",
    funds: "paynoval",
    destination: RAIL_TEMOIN,
    env: ENV,
  });

  assert.equal(verdict.allowed, false);
  assert.equal(verdict.violations[0].side, "destination");
});

test("les accents et la casse ne contournent pas la règle", () => {
  // « Côte d'Ivoire », « COTE DIVOIRE », « ci » désignent le même pays. Une
  // comparaison naïve laisserait passer deux des trois.
  for (const country of [
    "Côte d'Ivoire",
    "COTE D'IVOIRE",
    "  cote divoire  ",
    "CI",
    "Ivory Coast",
  ]) {
    const verdict = evaluateRailPolicy({
      country,
      funds: RAIL_TEMOIN,
      destination: "paynoval",
      env: ENV,
    });

    assert.equal(
      verdict.allowed,
      false,
      `${JSON.stringify(country)} aurait dû être reconnu`
    );
  }
});

test("un compte hors zone n'est pas restreint", () => {
  const verdict = evaluateRailPolicy({
    country: "France",
    currency: "EUR",
    funds: RAIL_TEMOIN,
    destination: "paynoval",
    env: ENV,
  });

  assert.equal(verdict.allowed, true);
  assert.deepEqual(verdict.violations, []);
});

test("les rails autorisés restent autorisés dans la zone", () => {
  // Le risque d'une politique trop large : couper les virements légitimes.
  // Mobile money et PayNoval sont précisément ce qui doit continuer de marcher.
  for (const [funds, destination] of [
    ["paynoval", "mobilemoney"],
    ["mobilemoney", "paynoval"],
    ["paynoval", "paynoval"],
  ]) {
    const verdict = evaluateRailPolicy({
      country: "senegal",
      currency: "XOF",
      funds,
      destination,
      env: ENV,
    });

    assert.equal(
      verdict.allowed,
      true,
      `${funds} → ${destination} doit rester autorisé`
    );
  }
});

test("report-only par défaut : la règle constate sans bloquer", () => {
  const verdict = evaluateRailPolicy({
    country: "mali",
    funds: RAIL_TEMOIN,
    destination: "paynoval",
    env: ENV,
  });

  // `allowed: false` dit ce que la règle PENSE ; `strict: false` dit que le
  // middleware ne doit pas agir dessus. C'est la garantie de mise en service.
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.strict, false);
});

test("le régime strict s'active explicitement", () => {
  const verdict = evaluateRailPolicy({
    country: "mali",
    funds: RAIL_TEMOIN,
    destination: "paynoval",
    env: { RAIL_POLICY_STRICT: "true" },
  });

  assert.equal(verdict.strict, true);
});

test("seule la valeur \"true\" active le régime strict", () => {
  // `RAIL_POLICY_STRICT=1` ou `=yes` ne doit pas activer par accident un
  // blocage de paiements.
  for (const value of ["1", "yes", "TRUE ", "on", "", undefined]) {
    const policy = loadPolicy({ RAIL_POLICY_STRICT: value });
    assert.equal(policy.strict, String(value).trim().toLowerCase() === "true");
  }
});

test("la liste de pays se pilote par variable d'environnement", () => {
  // Elle était figée en dur dans un écran mobile, donc jusqu'à la prochaine
  // soumission en magasin. Une restriction opérationnelle doit pouvoir se
  // lever le jour où le partenaire ouvre le corridor.
  const env = {
    RAIL_POLICY_RESTRICTED_COUNTRIES: "ghana,nigeria",
    RAIL_POLICY_RESTRICTED_RAILS: RAIL_TEMOIN,
  };

  assert.equal(
    evaluateRailPolicy({ country: "ghana", funds: RAIL_TEMOIN, env }).allowed,
    false
  );

  // La Côte d'Ivoire n'est plus dans la liste : elle redevient autorisée.
  assert.equal(
    evaluateRailPolicy({ country: "cote divoire", funds: "stripe", env }).allowed,
    true
  );
});

test("les rails indisponibles sont vides par défaut", () => {
  // Activer le blocage « bientôt disponible » couperait un rail pour tout le
  // monde : c'est une décision produit, pas un défaut.
  assert.deepEqual(loadPolicy(ENV).unavailableRails, []);

  const env = { RAIL_POLICY_UNAVAILABLE_RAILS: "mobilemoney" };
  const verdict = evaluateRailPolicy({
    country: "France",
    destination: "mobilemoney",
    env,
  });

  assert.equal(verdict.allowed, false);
  assert.equal(verdict.violations[0].reason, "RAIL_NOT_AVAILABLE");
});

test("une demande sans rail ne déclenche rien", () => {
  const verdict = evaluateRailPolicy({ country: "mali", env: ENV });
  assert.equal(verdict.allowed, true);
});

test("isRestrictedProfile reconnaît pays ET devise", () => {
  const policy = loadPolicy(ENV);

  assert.equal(isRestrictedProfile({ country: "senegal" }, policy), true);
  assert.equal(isRestrictedProfile({ currency: "XAF" }, policy), true);
  assert.equal(isRestrictedProfile({ country: "Canada" }, policy), false);
  assert.equal(isRestrictedProfile({}, policy), false);
});
