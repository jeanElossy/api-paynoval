"use strict";

/**
 * REGISTRE DES COMPTES INTERNES (TRÉSORERIES) — LA BASE FAIT FOI
 * =============================================================================
 *
 * ── Le défaut fermé le 2026-09-22 ──────────────────────────────────────────
 *
 * Une trésorerie était désignée par une VARIABLE D'ENVIRONNEMENT
 * (`FEES_TREASURY_USER_ID`…), et `TxSystemBalance.credit()` créait le compte
 * correspondant s'il n'existait pas. Mesuré sur les bases -test :
 *
 *   - `FEES_TREASURY` et `FX_MARGIN_TREASURY` créditées sur des comptes dont le
 *     propriétaire n'existe plus dans la base Users (97,91 CAD et 97,78 CAD) ;
 *   - deux `OPERATIONS_TREASURY` actives, dont une avec 30 000 XOF ;
 *   - les comptes système « officiels » restaient vides.
 *
 * Une variable qui dérive suffisait donc à envoyer l'argent ailleurs, sans
 * aucune erreur. C'est le défaut que ce module ferme.
 *
 * ── Ce que font Stripe, PayPal, Wise ───────────────────────────────────────
 *
 * Les comptes internes (frais, change, opérations) sont un REGISTRE : un compte
 * par rôle, provisionné une fois, gouverné, jamais créé au vol. Le code désigne
 * un RÔLE (`FEES_TREASURY`), pas un identifiant — l'identifiant est une donnée
 * du registre, pas une constante de déploiement.
 *
 * ── Ce que fait ce module ──────────────────────────────────────────────────
 *
 * Au démarrage, on lit les comptes internes ACTIFS et on construit le registre
 * `systemType → userId`. Les variables d'environnement deviennent un CONTRÔLE :
 * si elles désignent autre chose que le registre, le démarrage le dit
 * (règle B.6). Un type absent ou en double n'est jamais deviné : toute
 * opération sur ce type échoue en fermeture (règle B.2).
 *
 * Les fonctions de décision sont pures : testables sans base ni réseau.
 */

const TREASURY_SYSTEM_TYPES = Object.freeze([
  "REFERRAL_TREASURY",
  "FEES_TREASURY",
  "OPERATIONS_TREASURY",
  "CAGNOTTE_FEES_TREASURY",
  "FX_MARGIN_TREASURY",
]);

const STATUS = Object.freeze({
  OK: "OK",
  MISSING: "MISSING",
  DUPLICATE: "DUPLICATE",
  ENV_MISMATCH: "ENV_MISMATCH",
  ORPHAN_OWNER: "ORPHAN_OWNER",
});

const idOf = (value) => String(value ?? "").trim();

/** Un compte interne est vide s'il ne détient rien et n'a jamais rien vu passer. */
function isEmptyTreasury(wallet) {
  const balances = wallet?.balances || {};
  const moved = Object.values(balances).some((v) => Number(v) !== 0);
  const history = Array.isArray(wallet?.balanceHistory) ? wallet.balanceHistory.length : 0;

  return !moved && history === 0;
}

const activeOnly = (wallets = []) => wallets.filter((w) => w?.isActive !== false);

/**
 * Registre `systemType → userId`, construit sur les comptes ACTIFS.
 * Un type en double n'entre PAS dans le registre : on ne choisit pas au hasard
 * le compte qui reçoit l'argent.
 */
function buildRegistry(wallets = []) {
  const byType = new Map();
  const duplicates = new Set();

  for (const wallet of activeOnly(wallets)) {
    const type = idOf(wallet?.systemType);
    if (!TREASURY_SYSTEM_TYPES.includes(type)) continue;

    if (byType.has(type)) {
      duplicates.add(type);
      continue;
    }

    byType.set(type, idOf(wallet?.userId));
  }

  for (const type of duplicates) byType.delete(type);

  return { registry: byType, duplicates: [...duplicates] };
}

/**
 * État de chaque type, pour le journal de démarrage. `systemUsers` : comptes
 * système de la base Users (`{ _id, systemType }`), qui disent si le
 * propriétaire du compte interne existe encore.
 */
function auditTreasuryRegistry({ wallets = [], envIds = {}, systemUsers = [] } = {}) {
  const { registry, duplicates } = buildRegistry(wallets);
  const ownerIds = new Set(systemUsers.map((u) => idOf(u?._id)));

  return TREASURY_SYSTEM_TYPES.map((systemType) => {
    const envId = idOf(envIds[systemType]);
    const registryId = registry.get(systemType) || "";

    if (duplicates.includes(systemType)) {
      return { systemType, status: STATUS.DUPLICATE, registryId: "", envId };
    }

    if (!registryId) {
      return { systemType, status: STATUS.MISSING, registryId: "", envId };
    }

    if (!ownerIds.has(registryId)) {
      return { systemType, status: STATUS.ORPHAN_OWNER, registryId, envId };
    }

    if (envId && envId !== registryId) {
      return { systemType, status: STATUS.ENV_MISMATCH, registryId, envId };
    }

    return { systemType, status: STATUS.OK, registryId, envId };
  });
}

/**
 * Plan de réparation — aucune décision qui déplacerait de l'argent entre deux
 * comptes n'est prise ici : un tel transfert est une écriture comptable, pas
 * une migration (invariant 4). Les cas ambigus sont BLOQUÉS pour un humain.
 *
 * Actions possibles, par type :
 *   RIEN      le compte du bon propriétaire est seul et actif ;
 *   RELIER    un seul compte actif, propriétaire périmé ⇒ on le rattache au
 *             compte système réel (l'argent ne bouge pas, seul le lien change) ;
 *   ARCHIVER  un doublon VIDE et sans historique ⇒ sorti du registre ;
 *   CRÉER     aucun compte pour ce type ⇒ provisionnement explicite ;
 *   BLOQUÉ    deux comptes qui détiennent ou ont détenu de l'argent, ou aucun
 *             compte système en base : un humain tranche.
 */
function planTreasuryRepair({ wallets = [], systemUsers = [] } = {}) {
  const usersByType = new Map();
  const duplicateUsers = new Set();

  for (const user of systemUsers) {
    const type = idOf(user?.systemType);
    if (!TREASURY_SYSTEM_TYPES.includes(type)) continue;
    if (usersByType.has(type)) duplicateUsers.add(type);
    else usersByType.set(type, user);
  }

  return TREASURY_SYSTEM_TYPES.map((systemType) => {
    const owner = usersByType.get(systemType);
    const mine = activeOnly(wallets).filter((w) => idOf(w?.systemType) === systemType);

    if (!owner || duplicateUsers.has(systemType)) {
      return { systemType, action: "BLOQUÉ", reason: owner ? "PLUSIEURS_COMPTES_SYSTEME" : "AUCUN_COMPTE_SYSTEME" };
    }

    const ownerId = idOf(owner._id);
    const held = mine.filter((w) => idOf(w.userId) === ownerId);
    const orphans = mine.filter((w) => idOf(w.userId) !== ownerId);

    if (!mine.length) {
      return {
        systemType,
        action: "CRÉER",
        ownerId,
        currency: idOf(owner.currency) || "CAD",
      };
    }

    const usefulOrphans = orphans.filter((w) => !isEmptyTreasury(w));
    const emptyOrphans = orphans.filter(isEmptyTreasury);
    const usefulHeld = held.filter((w) => !isEmptyTreasury(w));
    const emptyHeld = held.filter(isEmptyTreasury);

    if (usefulOrphans.length > 1 || (usefulOrphans.length && usefulHeld.length)) {
      return { systemType, action: "BLOQUÉ", reason: "DEUX_COMPTES_AVEC_DE_L_ARGENT" };
    }

    const archive = [...emptyOrphans.map((w) => idOf(w._id))];

    if (usefulOrphans.length === 1) {
      // Le compte du bon propriétaire, s'il existe, est vide : il sort du
      // registre pour libérer l'unicité `{userId, systemType}`.
      archive.push(...emptyHeld.map((w) => idOf(w._id)));

      return {
        systemType,
        action: "RELIER",
        ownerId,
        walletId: idOf(usefulOrphans[0]._id),
        fromUserId: idOf(usefulOrphans[0].userId),
        archive,
      };
    }

    if (usefulHeld.length === 1) {
      return archive.length
        ? { systemType, action: "ARCHIVER", ownerId, archive }
        : { systemType, action: "RIEN", ownerId };
    }

    // Aucun compte ne porte d'argent : on garde celui du bon propriétaire.
    if (emptyHeld.length) {
      return archive.length
        ? { systemType, action: "ARCHIVER", ownerId, archive }
        : { systemType, action: "RIEN", ownerId };
    }

    return {
      systemType,
      action: "RELIER",
      ownerId,
      walletId: idOf(orphans[0]._id),
      fromUserId: idOf(orphans[0].userId),
      archive: orphans.slice(1).map((w) => idOf(w._id)),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Registre en mémoire — chargé au démarrage, relu à la demande               */
/* -------------------------------------------------------------------------- */

let _registry = null;

/** Lit les comptes internes actifs et mémorise le registre. */
async function loadTreasuryRegistry(conn) {
  const wallets = await conn
    .collection("txsystembalances")
    .find({ isActive: { $ne: false } }, { projection: { userId: 1, systemType: 1, isActive: 1 } })
    .toArray();

  const { registry } = buildRegistry(wallets);
  _registry = registry;

  return registry;
}

/**
 * Identifiant du compte interne pour un rôle. Registre chargé et type connu ⇒
 * la base fait foi. Sinon, `null` : l'appelant échoue en fermeture plutôt que
 * de créditer un compte choisi par défaut.
 */
function treasuryUserIdFromRegistry(systemType) {
  if (!_registry) return null;
  return _registry.get(idOf(systemType)) || null;
}

/** Pour les tests : registre réinitialisé. */
function resetTreasuryRegistry() {
  _registry = null;
}

module.exports = {
  TREASURY_SYSTEM_TYPES,
  STATUS,
  isEmptyTreasury,
  buildRegistry,
  auditTreasuryRegistry,
  planTreasuryRepair,
  loadTreasuryRegistry,
  treasuryUserIdFromRegistry,
  resetTreasuryRegistry,
};
