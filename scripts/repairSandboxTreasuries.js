"use strict";

/**
 * RÉPARATION DU RATTACHEMENT DES TRÉSORERIES DE SIMULATION — lecture seule par défaut.
 * -----------------------------------------------------------------------------
 * Mesuré en production le 2026-11-10 : `SANDBOX_OPERATIONS_TREASURY` et
 * `SANDBOX_CAGNOTTE_FEES_TREASURY` rattachées à des comptes système supprimés
 * à la main de la base Users ; le backend en avait recréé d'autres. Toute
 * création d'accès de démonstration échouait (`E11000`, puis 409
 * `SANDBOX_TREASURY_OWNER_MISMATCH` depuis le correctif).
 *
 * Ce script RÉTABLIT LE LIEN, il ne déplace JAMAIS d'argent :
 *   RELIER   la trésorerie active est rattachée au compte système actuel
 *            (`userId`/`ownerId`), montants inchangés, trace dans
 *            `metadata.ownerRelinks`. Les écritures passées du grand livre ne
 *            sont PAS réécrites (invariant 4) : elles restent sur l'ancien
 *            compte `treasury:<TYPE>:<ancien>:<DEVISE>`, les suivantes iront
 *            sur celui du nouveau propriétaire. Le diagnostic les compte.
 *   BLOQUÉ   deux trésoreries actives, deux comptes vivants, compte système
 *            absent ou hors simulation : un humain tranche.
 *
 * Décision : `src/services/sandbox/sandboxTreasuryOwnership.js` (pur, testé).
 * Seuls les types `SANDBOX_*` sont lus et écrits.
 *
 * Usage (même garde-fou que `migrateAccountMode.js`) :
 *   node scripts/repairSandboxTreasuries.js --target=test      # bases -test, diagnostic
 *   node scripts/repairSandboxTreasuries.js --target=legacy    # bases sans suffixe (production), diagnostic
 *   node scripts/repairSandboxTreasuries.js --target=legacy --apply --confirm=<baseTx>,<baseUsers>
 */

const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const { SANDBOX_TREASURY_SYSTEM_TYPES } = require("../src/services/treasuryRegistry");
const {
  ACTIONS,
  walletOwnerId,
  planSandboxTreasuryRepair,
} = require("../src/services/sandbox/sandboxTreasuryOwnership");

const args = process.argv.slice(2);
const argValue = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const TARGET = argValue("target");
const APPLY = args.includes("--apply");
const CONFIRM = String(argValue("confirm") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const COLLECTION = "txsystembalances";
const REASON = "Compte système supprimé puis recréé — rattachement des trésoreries de simulation (2026-11-10)";

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

const URI_RE = /^(mongodb(?:\+srv)?:\/\/[^/]+)\/([^?]*)(\?.*)?$/;

function retarget(uri, target) {
  const m = URI_RE.exec(String(uri || "").trim());
  if (!m) return null;

  const current = decodeURIComponent(m[2] || "");
  const base = current.replace(/-test$/, "");
  if (!base) return null;

  const dbName = target === "test" ? `${base}-test` : base;
  return { uri: `${m[1]}/${encodeURIComponent(dbName)}${m[3] || ""}`, dbName };
}

const asIdVariants = (id) => {
  const s = String(id || "");
  return mongoose.Types.ObjectId.isValid(s) ? [s, new mongoose.Types.ObjectId(s)] : [s];
};

async function readState(tx, users) {
  const wallets = await tx
    .collection(COLLECTION)
    .find({ systemType: { $in: [...SANDBOX_TREASURY_SYSTEM_TYPES] } })
    .toArray();

  const systemUsers = await users
    .collection("users")
    .find(
      { isSystem: true, systemType: { $in: [...SANDBOX_TREASURY_SYSTEM_TYPES] } },
      { projection: { _id: 1, systemType: 1, mode: 1 } }
    )
    .toArray();

  const ownerIds = [...new Set(wallets.map(walletOwnerId).filter(Boolean))];
  const present = await users
    .collection("users")
    .find({ _id: { $in: ownerIds.flatMap(asIdVariants) } }, { projection: { _id: 1 } })
    .toArray();

  return { wallets, systemUsers, existingUserIds: present.map((u) => String(u._id)) };
}

async function main() {
  if (!["test", "legacy"].includes(TARGET)) {
    fail("Préciser --target=test (bases -test) ou --target=legacy (bases sans suffixe, production).");
  }

  const txTarget = retarget(process.env.MONGO_URI_TRANSACTIONS, TARGET);
  const usersTarget = retarget(process.env.MONGO_URI_USERS, TARGET);

  if (!txTarget || !usersTarget) {
    fail("MONGO_URI_TRANSACTIONS / MONGO_URI_USERS absentes ou illisibles dans le .env de Tx-Core.");
  }
  if (txTarget.dbName === usersTarget.dbName) {
    fail("Les bases transactions et utilisateurs portent le même nom : configuration inattendue, arrêt.");
  }
  if (APPLY) {
    const expected = [txTarget.dbName, usersTarget.dbName];
    const ok = expected.every((n) => CONFIRM.includes(n)) && CONFIRM.length === expected.length;
    if (!ok) fail(`--apply exige --confirm=${expected.join(",")} (les deux noms de base, exactement).`);
  }

  console.log(`Bases : transactions=${txTarget.dbName}  utilisateurs=${usersTarget.dbName}  (${APPLY ? "ÉCRITURE" : "lecture seule"})`);

  const txConn = await mongoose.createConnection(txTarget.uri).asPromise();
  const usersConn = await mongoose.createConnection(usersTarget.uri).asPromise();

  try {
    const tx = txConn.db;
    const users = usersConn.db;

    const state = await readState(tx, users);
    const plan = planSandboxTreasuryRepair({ ...state, sandboxTypes: [...SANDBOX_TREASURY_SYSTEM_TYPES] });

    console.log("\n— Plan —");
    for (const step of plan) {
      let ledger = "";
      if (step.action === ACTIONS.RELINK && step.fromUserId) {
        const prefix = `treasury:${step.systemType}:${step.fromUserId}:`;
        const n = await tx.collection("ledgerentries").countDocuments({ accountId: { $regex: `^${prefix}` } });
        ledger = `  écritures sur l'ancien compte du grand livre : ${n}`;
      }
      console.log(
        `${step.systemType.padEnd(32)} ${step.action.padEnd(8)} ` +
          `${step.fromUserId ? `${step.fromUserId} → ` : ""}${step.ownerId || "—"}` +
          `${step.reason ? `  (${step.reason})` : ""}${ledger}`
      );
    }

    const relinks = plan.filter((s) => s.action === ACTIONS.RELINK);
    const blocked = plan.filter((s) => s.action === ACTIONS.BLOCKED);

    if (!APPLY) {
      console.log(
        `\n${relinks.length} rattachement(s) à faire, ${blocked.length} cas bloqué(s). ` +
          (relinks.length
            ? `Pour appliquer : node scripts/repairSandboxTreasuries.js --target=${TARGET} --apply --confirm=${txTarget.dbName},${usersTarget.dbName}`
            : "Rien à appliquer.")
      );
      return;
    }

    const now = new Date();

    for (const step of relinks) {
      const doc = await tx.collection(COLLECTION).findOne({ _id: new mongoose.Types.ObjectId(step.walletId) });
      if (!doc) {
        console.log(`  ⚠️ ${step.systemType} ${step.walletId} introuvable — NON relié`);
        continue;
      }

      const metadata = doc.metadata && typeof doc.metadata === "object" && !Array.isArray(doc.metadata) ? doc.metadata : {};
      const ownerRelinks = Array.isArray(metadata.ownerRelinks) ? metadata.ownerRelinks : [];
      const newOwner = new mongoose.Types.ObjectId(step.ownerId);

      // Le filtre REPÈTE les conditions du plan : entre la lecture et
      // l'écriture, la trésorerie a pu être archivée ou déjà reliée.
      const fromVariants = asIdVariants(step.fromUserId);
      const res = await tx.collection(COLLECTION).updateOne(
        {
          _id: doc._id,
          systemType: step.systemType,
          isActive: { $ne: false },
          $or: [{ userId: { $in: fromVariants } }, { ownerId: { $in: fromVariants } }],
        },
        {
          $set: {
            userId: newOwner,
            ownerId: newOwner,
            updatedAt: now,
            metadata: {
              ...metadata,
              ownerRelinks: [
                ...ownerRelinks,
                { at: now, from: String(step.fromUserId || ""), to: String(step.ownerId), reason: REASON, by: "scripts/repairSandboxTreasuries" },
              ],
            },
          },
        }
      );

      console.log(
        res.modifiedCount === 1
          ? `  ✔ relié ${step.systemType} (${step.walletId}) → ${step.ownerId}`
          : `  ⚠️ ${step.systemType} ${step.walletId} a changé depuis le diagnostic — NON relié`
      );
    }

    const after = planSandboxTreasuryRepair({ ...(await readState(tx, users)), sandboxTypes: [...SANDBOX_TREASURY_SYSTEM_TYPES] });
    console.log("\n— État après réparation —");
    for (const step of after) console.log(`${step.systemType.padEnd(32)} ${step.action}${step.reason ? `  (${step.reason})` : ""}`);
  } finally {
    await txConn.close();
    await usersConn.close();
  }
}

main().catch((err) => {
  console.error("❌", err?.code || err?.name, String(err?.message || err).replace(/mongodb(\+srv)?:\/\/[^@]*@/g, "mongodb$1://***@"));
  process.exit(1);
});
