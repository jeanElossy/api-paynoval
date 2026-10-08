"use strict";

/**
 * V1 — UN SEUL TYPE DE COMPTE : LE KYC VAUT POUR TOUS (2026-10-07)
 * ============================================================================
 *
 * Les comptes entreprise et le KYB sont retirés (retour en V2, tag Git
 * `pre-v1-business-removal`). Avant ce retrait, un profil « entreprise »
 * échappait au KYC dès que son KYB était (ou SEMBLAIT) validé — et côté AML,
 * `getBusinessKYBStatus()` rendait toujours « validé » : échec en OUVERTURE.
 *
 * Ces tests figent l'invariant inverse : un profil hérité portant encore des
 * marques « entreprise » est un particulier, et il lui faut le KYC.
 * Ils ÉCHOUENT si l'on réintroduit l'exemption.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildEligibilityFailures,
  buildEligibilitySnapshot,
  TX_ELIGIBILITY_USER_SELECT,
} = require("../src/services/transactions/shared/transactionEligibility");
const { extractUserCountry } = require("../src/services/transactions/handlers/corridorValidation");
const { buildScreeningQueries } = require("../src/services/risk/sanctionsScreening");

const VERIFIED_CONTACT = {
  _id: "64b000000000000000000001",
  email: "a@b.co",
  emailVerified: true,
  phone: "+2250700000000",
  phoneVerified: true,
  accountStatus: "active",
};

/** Profil hérité : toutes les marques « entreprise », KYB validé, KYC jamais fait. */
const LEGACY_BUSINESS = {
  ...VERIFIED_CONTACT,
  userType: "entreprise",
  role: "business",
  isBusiness: true,
  kybStatus: "verified",
  businessStatus: "verified",
  businessKYBLevel: 3,
  kybVerified: true,
  kycStatus: "none",
  kycLevel: 0,
};

const codes = (user) => buildEligibilityFailures(user).map((f) => f.code);

test("un profil hérité « entreprise » au KYB validé est BLOQUÉ par le KYC", () => {
  const c = codes(LEGACY_BUSINESS);
  assert.ok(c.includes("KYC_REQUIRED"), `attendu KYC_REQUIRED, reçu ${c.join(",")}`);
  assert.ok(!c.includes("KYB_REQUIRED"));
});

test("aucun chemin ne produit plus KYB_REQUIRED", () => {
  for (const user of [LEGACY_BUSINESS, { ...LEGACY_BUSINESS, kybStatus: "none", kybVerified: false }]) {
    assert.ok(!codes(user).includes("KYB_REQUIRED"));
  }
});

test("un particulier au KYC validé passe — comportement inchangé", () => {
  assert.deepEqual(codes({ ...VERIFIED_CONTACT, userType: "individu", kycStatus: "verified" }), []);
});

test("un ancien compte entreprise qui a fait son KYC passe comme un particulier", () => {
  assert.deepEqual(codes({ ...LEGACY_BUSINESS, kycStatus: "verified" }), []);
});

test("l'instantané d'éligibilité ne porte plus aucun champ entreprise", () => {
  const snap = buildEligibilitySnapshot({ ...LEGACY_BUSINESS, kycStatus: "verified" });
  assert.equal(snap.kycVerified, true);
  for (const field of ["isBusiness", "kybVerified"]) {
    assert.equal(Object.hasOwn(snap, field), false, `${field} ne doit plus figurer`);
  }
});

test("la projection relue en base ne charge plus de champ entreprise", () => {
  for (const field of ["isBusiness", "kybStatus", "businessStatus", "businessKYBLevel", "kybVerified"]) {
    assert.ok(!TX_ELIGIBILITY_USER_SELECT.includes(field), field);
  }
});

test("le pays d'un expéditeur est celui de son COMPTE, jamais un pays d'immatriculation", () => {
  assert.equal(
    extractUserCountry({ ...LEGACY_BUSINESS, country: "Côte d'Ivoire", registrationCountry: "France" }),
    "Côte d'Ivoire"
  );
});

test("l'expéditeur est criblé comme PERSONNE, même sur un profil hérité « entreprise »", () => {
  const q = buildScreeningQueries({
    user: { ...LEGACY_BUSINESS, fullName: "Awa Koné", companyName: "ACME SARL", country: "CI" },
    body: {},
  });
  assert.equal(q.sender?.schema, "Person");
});

test("l'AML ne contient plus le stub KYB toujours « validé »", () => {
  const root = path.join(__dirname, "..", "src");
  const middleware = fs.readFileSync(path.join(root, "middleware", "aml.js"), "utf8");
  const service = fs.readFileSync(path.join(root, "services", "aml.js"), "utf8");

  assert.doesNotMatch(service, /getBusinessKYBStatus/);
  assert.doesNotMatch(middleware, /getBusinessKYBStatus|isKybValid|KYB_REQUIRED/);
  assert.equal(require("../src/services/aml").getBusinessKYBStatus, undefined);
});
