"use strict";

/**
 * Rattachement des trésoreries de simulation (2026-11-10).
 *
 * Mesuré en production : des comptes système de simulation supprimés à la
 * main, recréés par le backend sous un autre identifiant ; Tx-Core tentait de
 * créer une seconde trésorerie active → `E11000` → « erreur interne » 500 à
 * chaque création d'accès de démonstration. Chaque test échoue si l'on
 * réintroduit la faute (règle B.5).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  ACTIONS,
  findOwnerConflict,
  planSandboxTreasuryRepair,
} = require("../src/services/sandbox/sandboxTreasuryOwnership");

const TYPES = ["SANDBOX_FEES_TREASURY", "SANDBOX_OPERATIONS_TREASURY"];
const OLD = "6ac688181f1584a74a572621"; // supprimé de la base Users
const NEW = "6aed05038ee1780ae680273f"; // recréé par le backend
const FEES = "6ac688181f1584a74a57261b";

const wallet = (systemType, owner, extra = {}) => ({ _id: `w-${systemType}-${owner}`, systemType, userId: owner, isActive: true, ...extra });
const sysUser = (systemType, id, mode = "sandbox") => ({ _id: id, systemType, mode });

test("le cas de production : ancien propriétaire supprimé ⇒ RELIER vers le compte système actuel", () => {
  const plan = planSandboxTreasuryRepair({
    wallets: [wallet("SANDBOX_FEES_TREASURY", FEES), wallet("SANDBOX_OPERATIONS_TREASURY", OLD)],
    systemUsers: [sysUser("SANDBOX_FEES_TREASURY", FEES), sysUser("SANDBOX_OPERATIONS_TREASURY", NEW)],
    existingUserIds: [FEES],
    sandboxTypes: TYPES,
  });
  const byType = Object.fromEntries(plan.map((s) => [s.systemType, s]));
  assert.equal(byType.SANDBOX_FEES_TREASURY.action, ACTIONS.NOTHING);
  assert.equal(byType.SANDBOX_OPERATIONS_TREASURY.action, ACTIONS.RELINK);
  assert.equal(byType.SANDBOX_OPERATIONS_TREASURY.fromUserId, OLD);
  assert.equal(byType.SANDBOX_OPERATIONS_TREASURY.ownerId, NEW);
});

test("l'ancien propriétaire existe encore : on ne devine pas, BLOQUÉ", () => {
  const [step] = planSandboxTreasuryRepair({
    wallets: [wallet("SANDBOX_OPERATIONS_TREASURY", OLD)],
    systemUsers: [sysUser("SANDBOX_OPERATIONS_TREASURY", NEW)],
    existingUserIds: [OLD],
    sandboxTypes: ["SANDBOX_OPERATIONS_TREASURY"],
  });
  assert.equal(step.action, ACTIONS.BLOCKED);
});

test("deux trésoreries actives, aucun compte système, ou compte réel : BLOQUÉ", () => {
  const types = ["SANDBOX_OPERATIONS_TREASURY"];
  const two = planSandboxTreasuryRepair({
    wallets: [wallet(types[0], OLD), wallet(types[0], "6ac688181f1584a74a579999")],
    systemUsers: [sysUser(types[0], NEW)],
    sandboxTypes: types,
  });
  assert.equal(two[0].action, ACTIONS.BLOCKED);

  const noOwner = planSandboxTreasuryRepair({ wallets: [wallet(types[0], OLD)], systemUsers: [], sandboxTypes: types });
  assert.equal(noOwner[0].action, ACTIONS.BLOCKED);

  const live = planSandboxTreasuryRepair({
    wallets: [wallet(types[0], OLD)],
    systemUsers: [sysUser(types[0], NEW, "live")],
    sandboxTypes: types,
  });
  assert.equal(live[0].action, ACTIONS.BLOCKED);
});

test("une trésorerie archivée ne compte pas : ABSENTE, le provisionnement la créera", () => {
  const [step] = planSandboxTreasuryRepair({
    wallets: [wallet("SANDBOX_OPERATIONS_TREASURY", OLD, { isActive: false })],
    systemUsers: [sysUser("SANDBOX_OPERATIONS_TREASURY", NEW)],
    sandboxTypes: ["SANDBOX_OPERATIONS_TREASURY"],
  });
  assert.equal(step.action, ACTIONS.MISSING);
});

test("une vraie trésorerie est refusée par le plan", () => {
  assert.throws(
    () => planSandboxTreasuryRepair({ sandboxTypes: ["OPERATIONS_TREASURY"] }),
    (err) => err.code === "NOT_A_SANDBOX_TREASURY"
  );
});

test("conflit au provisionnement : une trésorerie active appartient à un autre compte", () => {
  const conflict = findOwnerConflict({
    systemType: "SANDBOX_OPERATIONS_TREASURY",
    requestedOwnerId: NEW,
    wallets: [wallet("SANDBOX_OPERATIONS_TREASURY", OLD)],
  });
  assert.deepEqual(conflict.currentOwnerIds, [OLD]);

  // Pas de conflit : rien d'actif, ou déjà au bon compte, ou autre type, ou archivée.
  assert.equal(findOwnerConflict({ systemType: "SANDBOX_OPERATIONS_TREASURY", requestedOwnerId: NEW, wallets: [] }), null);
  assert.equal(findOwnerConflict({ systemType: "SANDBOX_OPERATIONS_TREASURY", requestedOwnerId: NEW, wallets: [wallet("SANDBOX_OPERATIONS_TREASURY", NEW)] }), null);
  assert.equal(findOwnerConflict({ systemType: "SANDBOX_OPERATIONS_TREASURY", requestedOwnerId: NEW, wallets: [wallet("SANDBOX_FEES_TREASURY", OLD)] }), null);
  assert.equal(findOwnerConflict({ systemType: "SANDBOX_OPERATIONS_TREASURY", requestedOwnerId: NEW, wallets: [wallet("SANDBOX_OPERATIONS_TREASURY", OLD, { isActive: false })] }), null);
  // `ownerId` seul (anciennes trésoreries) est lu aussi.
  assert.equal(findOwnerConflict({ systemType: "SANDBOX_OPERATIONS_TREASURY", requestedOwnerId: NEW, wallets: [{ _id: "x", systemType: "SANDBOX_OPERATIONS_TREASURY", ownerId: NEW }] }), null);
});

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

test("provisionTreasuries vérifie le rattachement AVANT de créer, et répond 409 nommé", () => {
  const src = read("src/services/sandbox/sandboxToolsService.js");
  const start = src.indexOf("async function provisionTreasuries");
  const body = src.slice(start, src.indexOf("\n}\n", start));
  const check = body.indexOf("findOwnerConflict(");
  const create = body.indexOf("ensureSystemWallet(");
  assert.ok(check > 0, "le contrôle de rattachement a disparu");
  assert.ok(create > check, "le contrôle doit précéder la création");
  assert.match(body, /httpError\(\s*409,\s*"SANDBOX_TREASURY_OWNER_MISMATCH"/);
});

test("le script de réparation : confirmation exigée, aucune suppression, trésoreries de simulation seulement", () => {
  const src = read("scripts/repairSandboxTreasuries.js");
  assert.match(src, /--apply exige --confirm=/);
  assert.doesNotMatch(src, /deleteOne|deleteMany|insertOne|insertMany|drop\(|replaceOne/);
  assert.match(src, /systemType: \{ \$in: \[\.\.\.SANDBOX_TREASURY_SYSTEM_TYPES\] \}/);
  // L'écriture répète les conditions du plan (type, actif, ancien propriétaire).
  assert.match(src, /systemType: step\.systemType,\s*\n\s*isActive: \{ \$ne: false \},/);
  assert.match(src, /ownerRelinks/);
});
