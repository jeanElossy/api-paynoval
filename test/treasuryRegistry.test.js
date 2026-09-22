"use strict";

/**
 * Registre des comptes internes (2026-09-22) — voir `services/treasuryRegistry.js`.
 *
 * Défaut mesuré sur les bases -test : `TxSystemBalance.credit()` créait la
 * trésorerie désignée par une variable d'environnement périmée. Résultat :
 * frais et marge de change crédités sur des comptes sans propriétaire, deux
 * `OPERATIONS_TREASURY` actives, comptes officiels vides.
 *
 * Aucune base, aucun réseau : uniquement les décisions.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  STATUS,
  buildRegistry,
  auditTreasuryRegistry,
  planTreasuryRepair,
  isEmptyTreasury,
} = require("../src/services/treasuryRegistry");

const OWNER = {
  FEES: "69dadd3370fd7d74cf627182",
  OPS: "69dadd3470fd7d74cf627187",
  FX: "69dadd3570fd7d74cf627191",
};
const ORPHAN = "69c278d1b25becdb388ef186";

const wallet = (over = {}) => ({
  _id: over._id || "w1",
  userId: over.userId || OWNER.FEES,
  systemType: over.systemType || "FEES_TREASURY",
  isActive: over.isActive !== false,
  balances: over.balances || {},
  balanceHistory: over.balanceHistory || [],
});

const systemUsers = [
  { _id: OWNER.FEES, systemType: "FEES_TREASURY", currency: "CAD" },
  { _id: OWNER.OPS, systemType: "OPERATIONS_TREASURY", currency: "CAD" },
  { _id: OWNER.FX, systemType: "FX_MARGIN_TREASURY", currency: "CAD" },
  { _id: "u-ref", systemType: "REFERRAL_TREASURY", currency: "CAD" },
  { _id: "u-cag", systemType: "CAGNOTTE_FEES_TREASURY", currency: "CAD" },
];

test("un compte est vide s'il ne détient rien ET n'a rien vu passer", () => {
  assert.equal(isEmptyTreasury(wallet({ balances: { CAD: 0, XOF: 0 } })), true);
  assert.equal(isEmptyTreasury(wallet({ balances: { CAD: 0.01 } })), false);
  assert.equal(
    isEmptyTreasury(wallet({ balances: { CAD: 0 }, balanceHistory: [{ type: "credit" }] })),
    false,
    "un compte vidé après mouvements n'est pas un doublon inerte"
  );
});

test("un type en DOUBLE n'entre pas au registre — on ne tire pas au sort le compte crédité", () => {
  const { registry, duplicates } = buildRegistry([
    wallet({ _id: "a", systemType: "OPERATIONS_TREASURY", userId: OWNER.OPS }),
    wallet({ _id: "b", systemType: "OPERATIONS_TREASURY", userId: ORPHAN }),
    wallet({ _id: "c", systemType: "FEES_TREASURY", userId: OWNER.FEES }),
  ]);

  assert.deepEqual(duplicates, ["OPERATIONS_TREASURY"]);
  assert.equal(registry.has("OPERATIONS_TREASURY"), false);
  assert.equal(registry.get("FEES_TREASURY"), OWNER.FEES);
});

test("un compte archivé ne compte pas comme trésorerie active", () => {
  const { registry } = buildRegistry([
    wallet({ _id: "a", userId: ORPHAN, isActive: false }),
    wallet({ _id: "b", userId: OWNER.FEES }),
  ]);

  assert.equal(registry.get("FEES_TREASURY"), OWNER.FEES);
});

test("l'audit nomme chaque écart : propriétaire périmé, variable divergente, absent, double", () => {
  const rows = auditTreasuryRegistry({
    wallets: [
      wallet({ _id: "a", systemType: "FEES_TREASURY", userId: ORPHAN }),
      wallet({ _id: "b", systemType: "OPERATIONS_TREASURY", userId: OWNER.OPS }),
      wallet({ _id: "c", systemType: "FX_MARGIN_TREASURY", userId: OWNER.FX }),
      wallet({ _id: "d", systemType: "FX_MARGIN_TREASURY", userId: ORPHAN }),
    ],
    envIds: { OPERATIONS_TREASURY: ORPHAN },
    systemUsers,
  });

  const byType = Object.fromEntries(rows.map((r) => [r.systemType, r]));

  assert.equal(byType.FEES_TREASURY.status, STATUS.ORPHAN_OWNER);
  assert.equal(byType.OPERATIONS_TREASURY.status, STATUS.ENV_MISMATCH);
  assert.equal(byType.FX_MARGIN_TREASURY.status, STATUS.DUPLICATE);
  assert.equal(byType.REFERRAL_TREASURY.status, STATUS.MISSING);
});

test("réparation : le compte qui porte l'argent est RELIÉ, le doublon vide ARCHIVÉ", () => {
  const plan = planTreasuryRepair({
    wallets: [
      wallet({ _id: "orphan", systemType: "OPERATIONS_TREASURY", userId: ORPHAN, balances: { XOF: 30000 }, balanceHistory: [{}] }),
      wallet({ _id: "vide", systemType: "OPERATIONS_TREASURY", userId: OWNER.OPS, balances: { CAD: 0 } }),
    ],
    systemUsers,
  });

  const step = plan.find((s) => s.systemType === "OPERATIONS_TREASURY");

  assert.equal(step.action, "RELIER");
  assert.equal(step.walletId, "orphan");
  assert.equal(step.ownerId, OWNER.OPS);
  assert.deepEqual(step.archive, ["vide"], "le compte vide du bon propriétaire libère l'unicité");
});

test("réparation : deux comptes portant de l'argent ⇒ BLOQUÉ, jamais de fusion automatique", () => {
  const plan = planTreasuryRepair({
    wallets: [
      wallet({ _id: "a", userId: ORPHAN, balances: { CAD: 97.91 }, balanceHistory: [{}] }),
      wallet({ _id: "b", userId: OWNER.FEES, balances: { CAD: 12 }, balanceHistory: [{}] }),
    ],
    systemUsers,
  });

  const step = plan.find((s) => s.systemType === "FEES_TREASURY");

  assert.equal(step.action, "BLOQUÉ");
  assert.equal(step.reason, "DEUX_COMPTES_AVEC_DE_L_ARGENT");
});

test("réparation : aucun compte ⇒ CRÉER ; compte déjà correct ⇒ RIEN", () => {
  const plan = planTreasuryRepair({
    wallets: [wallet({ _id: "ok", userId: OWNER.FEES, balances: { CAD: 5 }, balanceHistory: [{}] })],
    systemUsers,
  });

  const byType = Object.fromEntries(plan.map((s) => [s.systemType, s]));

  assert.equal(byType.FEES_TREASURY.action, "RIEN");
  assert.equal(byType.REFERRAL_TREASURY.action, "CRÉER");
  assert.equal(byType.REFERRAL_TREASURY.currency, "CAD");
});

test("aucun compte système en base ⇒ BLOQUÉ : on n'invente pas de propriétaire", () => {
  const plan = planTreasuryRepair({
    wallets: [wallet({ _id: "a", userId: ORPHAN, balances: { CAD: 10 }, balanceHistory: [{}] })],
    systemUsers: [],
  });

  assert.equal(plan.find((s) => s.systemType === "FEES_TREASURY").action, "BLOQUÉ");
});

/* -------------------------------------------------------------------------- */
/* Fusion de deux comptes d'un même rôle                                      */
/* -------------------------------------------------------------------------- */

const { planTreasuryMerge } = require("../src/services/treasuryRegistry");

test("fusion : l'argent va de l'ancien compte vers le compte OFFICIEL", () => {
  // Cas mesuré en production le 2026-09-22 sur CAGNOTTE_FEES_TREASURY.
  const plans = planTreasuryMerge({
    wallets: [
      wallet({ _id: "officiel", userId: OWNER.FEES, balances: { CAD: 16.15 }, balanceHistory: [{}] }),
      wallet({ _id: "ancien", userId: ORPHAN, balances: { XOF: 176, CAD: 0 }, balanceHistory: [{}] }),
    ],
    systemUsers,
  });

  assert.equal(plans.length, 1);
  assert.equal(plans[0].action, "FUSIONNER");
  assert.equal(plans[0].sourceWalletId, "ancien");
  assert.equal(plans[0].targetWalletId, "officiel");
  assert.deepEqual(
    plans[0].devises,
    [{ currency: "XOF", amount: "176" }],
    "une devise à zéro ne produit aucune écriture"
  );
});

test("fusion : aucun compte officiel ⇒ BLOQUÉ, on ne choisit pas la cible à la place d'un humain", () => {
  const plans = planTreasuryMerge({
    wallets: [
      wallet({ _id: "a", userId: ORPHAN, balances: { CAD: 5 } }),
      wallet({ _id: "b", userId: "69c278d1b25becdb388ef999", balances: { CAD: 7 } }),
    ],
    systemUsers,
  });

  assert.equal(plans[0].action, "BLOQUÉ");
  assert.equal(plans[0].reason, "AUCUNE_CIBLE_OFFICIELLE");
});

test("fusion : un seul compte actif ⇒ rien à faire ; un archivé ne compte pas", () => {
  const plans = planTreasuryMerge({
    wallets: [
      wallet({ _id: "a", userId: OWNER.FEES, balances: { CAD: 5 } }),
      wallet({ _id: "vieux", userId: ORPHAN, balances: { CAD: 7 }, isActive: false }),
    ],
    systemUsers,
  });

  assert.deepEqual(plans, []);
});
