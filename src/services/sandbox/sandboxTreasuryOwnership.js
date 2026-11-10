"use strict";

/**
 * RATTACHEMENT DES TRÉSORERIES DE SIMULATION À LEUR COMPTE SYSTÈME (2026-11-10)
 * =============================================================================
 *
 * Module PUR (aucune base, aucun réseau) : la décision est testée seule
 * (`test/sandbox/sandboxTreasuryOwnership.test.js`), puis appliquée par
 * `sandboxToolsService.provisionTreasuries` et par
 * `scripts/repairSandboxTreasuries.js`.
 *
 * ── LE DÉFAUT CONSTATÉ ──────────────────────────────────────────────────────
 *
 * Mesuré en production le 2026-11-10 : des comptes système de simulation
 * (`SANDBOX_OPERATIONS_TREASURY`, `SANDBOX_CAGNOTTE_FEES_TREASURY`) avaient été
 * supprimés à la main de la base Users. Le backend, ne les trouvant plus, en a
 * recréé (nouvel identifiant). Tx-Core gardait la trésorerie rattachée à
 * l'ANCIEN identifiant : il ne la trouvait pas sous le nouveau, tentait d'en
 * créer une seconde, et l'index `one_active_system_wallet_per_type` la
 * refusait — `E11000` brut, donc une « erreur interne » 500 à la création de
 * TOUT accès de démonstration.
 *
 * ── CE QUE CE MODULE DÉCIDE ─────────────────────────────────────────────────
 *
 *   RIEN     la trésorerie active est déjà rattachée au compte système ;
 *   ABSENTE  aucune trésorerie active : le provisionnement la créera ;
 *   RELIER   la trésorerie active est rattachée à un compte qui N'EXISTE PLUS,
 *            et le compte système actuel existe : on rétablit le lien — les
 *            montants ne bougent pas, aucune écriture du grand livre n'est
 *            réécrite (invariant 4) ;
 *   BLOQUÉ   tout le reste (deux trésoreries actives, deux comptes vivants qui
 *            se disputent le rôle, compte système absent ou hors simulation) :
 *            un humain tranche. On ne devine jamais à qui appartient une
 *            trésorerie.
 *
 * Seuls les types `SANDBOX_*` sont acceptés : les vraies trésoreries ont leur
 * propre procédure (`scripts/repairSystemTreasuries.js`).
 */

const ACTIONS = Object.freeze({
  NOTHING: "RIEN",
  MISSING: "ABSENTE",
  RELINK: "RELIER",
  BLOCKED: "BLOQUÉ",
});

const idOf = (value) => (value == null ? "" : String(value).trim());

/** Propriétaire d'une trésorerie : `userId`, à défaut `ownerId`. */
function walletOwnerId(wallet) {
  return idOf(wallet?.userId) || idOf(wallet?.ownerId);
}

/** Une trésorerie archivée (`isActive: false`) ne compte plus. */
function isActiveWallet(wallet) {
  return wallet?.isActive !== false;
}

function assertSandboxType(systemType, sandboxTypes) {
  const type = idOf(systemType).toUpperCase();
  if (!type.startsWith("SANDBOX_") || !sandboxTypes.includes(type)) {
    const err = new Error(`Type refusé : ${type || "(vide)"} n'est pas une trésorerie de simulation.`);
    err.code = "NOT_A_SANDBOX_TREASURY";
    throw err;
  }
  return type;
}

/**
 * Conflit de rattachement au provisionnement : une trésorerie ACTIVE de ce type
 * existe, mais aucune n'appartient au compte demandé. Rend `null` s'il n'y a
 * pas de conflit (aucune trésorerie active, ou l'une est déjà au bon compte).
 */
function findOwnerConflict({ systemType, requestedOwnerId, wallets = [] }) {
  const type = idOf(systemType).toUpperCase();
  const requested = idOf(requestedOwnerId);
  const active = wallets.filter((w) => idOf(w?.systemType).toUpperCase() === type && isActiveWallet(w));

  if (!active.length) return null;
  if (active.some((w) => walletOwnerId(w) === requested)) return null;

  return {
    systemType: type,
    requestedOwnerId: requested,
    currentOwnerIds: active.map(walletOwnerId),
    walletIds: active.map((w) => idOf(w?._id)),
  };
}

/**
 * Plan de réparation, type par type.
 *
 * @param {object} input
 * @param {Array} input.wallets      trésoreries (`txsystembalances`)
 * @param {Array} input.systemUsers  comptes `isSystem` de la base Users ({_id, systemType, mode})
 * @param {Iterable<string>} input.existingUserIds  identifiants présents dans la base Users
 * @param {string[]} input.sandboxTypes  types `SANDBOX_*` à examiner
 */
function planSandboxTreasuryRepair({ wallets = [], systemUsers = [], existingUserIds = [], sandboxTypes = [] }) {
  const existing = new Set([...existingUserIds].map(idOf));
  const plan = [];

  for (const rawType of sandboxTypes) {
    const systemType = assertSandboxType(rawType, sandboxTypes);
    const active = wallets.filter(
      (w) => idOf(w?.systemType).toUpperCase() === systemType && isActiveWallet(w)
    );
    const owners = systemUsers.filter((u) => idOf(u?.systemType).toUpperCase() === systemType);
    const base = { systemType };

    if (!active.length) {
      plan.push({ ...base, action: ACTIONS.MISSING, reason: "aucune trésorerie active : le provisionnement la créera" });
      continue;
    }
    if (active.length > 1) {
      plan.push({ ...base, action: ACTIONS.BLOCKED, reason: `${active.length} trésoreries actives : doublon à trancher` });
      continue;
    }

    const wallet = active[0];
    const currentOwner = walletOwnerId(wallet);
    const walletId = idOf(wallet?._id);

    if (owners.length !== 1) {
      plan.push({
        ...base,
        action: ACTIONS.BLOCKED,
        walletId,
        fromUserId: currentOwner,
        reason: owners.length ? `${owners.length} comptes système de ce type` : "aucun compte système de ce type dans la base Users",
      });
      continue;
    }

    const owner = owners[0];
    const ownerId = idOf(owner._id);

    if (owner.mode !== "sandbox") {
      plan.push({ ...base, action: ACTIONS.BLOCKED, walletId, fromUserId: currentOwner, ownerId, reason: `compte système en mode ${owner.mode || "inconnu"}, pas en simulation` });
      continue;
    }
    if (currentOwner === ownerId) {
      plan.push({ ...base, action: ACTIONS.NOTHING, walletId, ownerId });
      continue;
    }
    if (currentOwner && existing.has(currentOwner)) {
      plan.push({ ...base, action: ACTIONS.BLOCKED, walletId, fromUserId: currentOwner, ownerId, reason: "l'ancien propriétaire existe encore : deux comptes vivants, un humain tranche" });
      continue;
    }

    plan.push({
      ...base,
      action: ACTIONS.RELINK,
      walletId,
      fromUserId: currentOwner,
      ownerId,
      reason: currentOwner ? "ancien propriétaire supprimé de la base Users" : "trésorerie sans propriétaire",
    });
  }

  return plan;
}

module.exports = {
  ACTIONS,
  walletOwnerId,
  isActiveWallet,
  findOwnerConflict,
  planSandboxTreasuryRepair,
};
