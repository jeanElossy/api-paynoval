"use strict";

/**
 * ============================================================================
 * OUTILS DU COMPTE DE SIMULATION — ÉTAT, SCÉNARIO, ROBINET, RÉINITIALISATION
 * ============================================================================
 *
 * Ce que le monteur pilote depuis l'application, sans accès au back-office :
 *
 *   - le SCÉNARIO des prochaines opérations prestataire (succès, échec, en
 *     attente, fonds insuffisants) et le délai de confirmation ;
 *   - le ROBINET : recharger le solde de démonstration ;
 *   - VIDER LE SOLDE : pour filmer le vrai refus « solde insuffisant » ;
 *   - RÉINITIALISER LA DÉMO : solde initial, réglages par défaut, historique
 *     affiché repartant de zéro.
 *
 * ── Aucun mouvement hors du grand livre ─────────────────────────────────────
 * Chaque changement de solde passe par `ledgerService.applySandboxFunding`
 * (portefeuille + écritures en partie double, même session) et se rattache à
 * un `SandboxLedgerOperation` immuable. La réinitialisation n'efface rien :
 * elle termine les opérations ouvertes par les chemins RÉELS (rappel d'échec
 * au moteur de règlement, annulation système du worker d'expiration), puis
 * pose une contre-écriture qui ramène le solde au point de départ — la
 * pratique d'un « reset » de données de test qui respecte l'invariant 4.
 *
 * Toutes les fonctions exigent un compte sandbox : le contrôleur le vérifie,
 * et chaque mouvement le revérifie (portefeuille en mode sandbox, robinet
 * refusé hors sandbox).
 */

const crypto = require("crypto");
const mongoose = require("mongoose");

const runtime = require("../transactions/shared/runtime");
const { roundMoney } = require("../pricingSnapshotNormalizer");
const { ACCOUNT_MODES, resolveUserMode } = require("../../utils/accountMode");
const {
  OUTCOME_VALUES,
  DELAY_BOUNDS,
  DEFAULT_SCENARIO,
} = require("../../providers/sandbox/sandboxScenario");
const scenarios = require("./sandboxScenarioStore");
const events = require("./sandboxProviderEvents");

const SANDBOX = ACCOUNT_MODES.SANDBOX;

/** Un robinet généreux mais borné : au plus dix fois le solde initial détenu. */
const FAUCET_CEILING_MULTIPLIER = 10;

const RESET_FAILURE = Object.freeze({
  failureCode: "SANDBOX_RESET",
  failureMessage: "Opération annulée par la réinitialisation de la démo.",
});

const OPEN_STATUSES = Object.freeze(["created", "pending", "pending_review", "locked", "relaunch"]);

function httpError(status, code, message, details) {
  const err = new Error(message);
  err.status = status;
  err.statusCode = status;
  err.code = code;
  if (details) err.details = details;
  return err;
}

function decToNumber(v) {
  if (v === null || v === undefined) return 0;
  const n = Number(typeof v === "object" && v.toString ? v.toString() : v);
  return Number.isFinite(n) ? n : 0;
}

function models() {
  const conn = runtime.txConn;
  return {
    Wallet: runtime.UserWalletBalance,
    Transaction: runtime.Transaction,
    Operation: require("../../models/SandboxLedgerOperation")(conn),
  };
}

function assertSandboxUser(user) {
  if (!user || resolveUserMode(user) !== SANDBOX) {
    // 404 : un compte live ne doit même pas apprendre que ces outils existent.
    throw httpError(404, "NOT_FOUND", "Ressource introuvable.");
  }
  return String(user._id || user.id);
}

async function requireProfile(userId) {
  const profile = await scenarios.getProfile(userId);
  if (!profile) {
    throw httpError(
      409,
      "SANDBOX_NOT_PROVISIONED",
      "Ce compte de simulation n'est pas encore provisionné."
    );
  }
  return profile;
}

function walletView(wallet, currency) {
  return {
    currency,
    amount: decToNumber(wallet?.amount),
    availableAmount: decToNumber(wallet?.availableAmount),
    reservedAmount: decToNumber(wallet?.reservedAmount),
  };
}

async function readWallet(userId, currency) {
  const { Wallet } = models();
  return Wallet.findWallet(userId, currency, { mode: SANDBOX });
}

function normalizeAmount(raw, currency) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw httpError(400, "INVALID_AMOUNT", "Montant invalide.");
  }
  const rounded = Number(roundMoney(n, currency));
  if (!(rounded > 0)) {
    throw httpError(400, "INVALID_AMOUNT", "Montant invalide.");
  }
  return rounded;
}

function newReference(kind) {
  return `SBX-${kind}-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

/**
 * Pose une opération de robinet et son mouvement, atomiquement. Une clé
 * d'idempotence déjà vue rend le résultat sans rien recréditer.
 */
async function postFunding({ userId, currency, amount, direction, kind, idempotencyKey, requestedBy }) {
  const { Operation } = models();
  const { applySandboxFunding } = require("../ledgerService");

  if (idempotencyKey) {
    const seen = await Operation.findOne({ userId, idempotencyKey }).lean();
    if (seen) return { replayed: true, operationId: String(seen._id) };
  }

  const session = await runtime.startTxSession();

  try {
    const operationId = await runtime.runInTransaction(session, async (active) => {
      const opts = runtime.maybeSessionOpts(active);

      const [operation] = await Operation.create(
        [
          {
            mode: SANDBOX,
            userId: new mongoose.Types.ObjectId(String(userId)),
            kind,
            direction,
            amount: mongoose.Types.Decimal128.fromString(String(amount)),
            currency,
            reference: newReference(kind),
            ...(idempotencyKey ? { idempotencyKey } : {}),
            requestedBy: requestedBy || null,
          },
        ],
        opts
      );

      await applySandboxFunding({
        operation,
        userId,
        currency,
        amount,
        direction,
        session: active,
      });

      return String(operation._id);
    });

    return { replayed: false, operationId };
  } catch (err) {
    // Course entre deux appuis portant la même clé : l'index unique a tranché.
    if ((err?.code === 11000 || err?.code === 11001) && idempotencyKey) {
      return { replayed: true, operationId: null };
    }
    throw err;
  } finally {
    runtime.safeEndSession(session);
  }
}

/* -------------------------------------------------------------------------- */

async function getState(user) {
  const userId = assertSandboxUser(user);
  const profile = await requireProfile(userId);
  const wallet = await readWallet(userId, profile.currency);
  const initialBalance = decToNumber(profile.initialBalance);

  return {
    scenario: {
      outcome: profile.outcome,
      confirmationDelaySeconds: profile.confirmationDelaySeconds,
    },
    defaults: { ...DEFAULT_SCENARIO },
    outcomes: [...OUTCOME_VALUES],
    delayBounds: { ...DELAY_BOUNDS },
    currency: profile.currency,
    initialBalance,
    wallet: walletView(wallet, profile.currency),
    faucet: {
      defaultAmount: initialBalance,
      maxAmount: initialBalance,
      ceiling: initialBalance * FAUCET_CEILING_MULTIPLIER,
    },
    historyStartsAt: profile.historyStartsAt || null,
    lastResetAt: profile.lastResetAt || null,
    openProviderOperations: await events.countOpenEventsForUser(userId),
  };
}

async function updateScenario(user, input) {
  const userId = assertSandboxUser(user);
  await requireProfile(userId);
  return scenarios.saveScenario(userId, input);
}

async function faucet(user, { amount, idempotencyKey } = {}) {
  const userId = assertSandboxUser(user);
  const profile = await requireProfile(userId);
  const currency = profile.currency;
  const initialBalance = decToNumber(profile.initialBalance);

  const credit = normalizeAmount(amount ?? initialBalance, currency);

  if (credit > initialBalance) {
    throw httpError(422, "SANDBOX_FAUCET_LIMIT", "Montant supérieur à la recharge maximale.", {
      maxAmount: initialBalance,
    });
  }

  const before = await readWallet(userId, currency);
  const ceiling = initialBalance * FAUCET_CEILING_MULTIPLIER;

  if (decToNumber(before?.amount) + credit > ceiling) {
    throw httpError(
      422,
      "SANDBOX_FAUCET_CEILING",
      "Solde de démonstration déjà au plafond.",
      { ceiling }
    );
  }

  const out = await postFunding({
    userId,
    currency,
    amount: credit,
    direction: "credit",
    kind: "FAUCET",
    idempotencyKey,
    requestedBy: userId,
  });

  return { ...out, wallet: walletView(await readWallet(userId, currency), currency) };
}

async function drain(user, { idempotencyKey } = {}) {
  const userId = assertSandboxUser(user);
  const profile = await requireProfile(userId);
  const currency = profile.currency;
  const wallet = await readWallet(userId, currency);
  const available = decToNumber(wallet?.availableAmount);

  if (available > 0) {
    await postFunding({
      userId,
      currency,
      amount: available,
      direction: "debit",
      kind: "DRAIN",
      idempotencyKey,
      requestedBy: userId,
    });
  }

  return { wallet: walletView(await readWallet(userId, currency), currency) };
}

/**
 * Termine les opérations ouvertes par les chemins RÉELS :
 *  - un ordre prestataire en cours reçoit un rappel d'échec, livré au moteur
 *    de règlement qui libère ou rembourse ;
 *  - une transaction en attente (virement interne non confirmé, envoi non
 *    soumis) est rendue échue puis annulée par le chemin du worker
 *    d'expiration — libération par le grand livre, machine à états.
 */
async function closeOpenOperations(userId) {
  const failed = await events.failOpenEventsForUser(userId, RESET_FAILURE);

  if (failed > 0) {
    const { runOnce } = require("./sandboxSettlementWorker");
    await runOnce({ limit: Math.max(failed, 1) + 5 });
  }

  const { Transaction } = models();
  const now = new Date();
  const open = await Transaction.find({
    mode: SANDBOX,
    userId: new mongoose.Types.ObjectId(String(userId)),
    status: { $in: OPEN_STATUSES },
    fundsCaptured: { $ne: true },
    beneficiaryCredited: { $ne: true },
  })
    .select("_id")
    .lean();

  let cancelled = 0;

  if (open.length) {
    await Transaction.updateMany(
      { _id: { $in: open.map((t) => t._id) } },
      { $set: { autoCancelAt: now } }
    );

    const { cancelExpiredTransactionNow } = require("../transactionAutoCancelService");

    for (const tx of open) {
      const result = await cancelExpiredTransactionNow({
        transactionId: tx._id,
        workerId: `sandbox-reset:${userId}`,
      });
      if (result?.ok) cancelled += 1;
    }
  }

  return { providerOperationsFailed: failed, transactionsCancelled: cancelled };
}

async function reset(user) {
  const userId = assertSandboxUser(user);
  const profile = await requireProfile(userId);
  const currency = profile.currency;
  const initialBalance = decToNumber(profile.initialBalance);

  const closed = await closeOpenOperations(userId);

  const wallet = await readWallet(userId, currency);
  const amount = decToNumber(wallet?.amount);
  const reserved = decToNumber(wallet?.reservedAmount);
  const delta = Number(roundMoney(initialBalance - amount, currency));

  if (delta > 0) {
    await postFunding({
      userId,
      currency,
      amount: delta,
      direction: "credit",
      kind: "RESET",
      requestedBy: userId,
    });
  } else if (delta < 0) {
    const available = decToNumber(wallet?.availableAmount);
    const debit = Math.min(-delta, available);

    if (debit > 0) {
      await postFunding({
        userId,
        currency,
        amount: debit,
        direction: "debit",
        kind: "RESET",
        requestedBy: userId,
      });
    }
  }

  await scenarios.markReset(userId, new Date());

  return {
    ...closed,
    // Fonds encore gelés après clôture : une opération n'a pas pu être
    // terminée. Dit, pas masqué (règle B.1).
    reservedAfterReset: reserved,
    state: await getState(user),
  };
}

/**
 * Provisionnement — appelé par le backend principal (route interne) à la
 * création du compte. Idempotent : rappelé, il ne recrédite pas.
 */
async function provisionAccount({ userId, currency, initialBalance }) {
  const id = String(userId || "").trim();
  if (!mongoose.isValidObjectId(id)) {
    throw httpError(400, "INVALID_USER_ID", "Identifiant utilisateur invalide.");
  }

  const owner = await runtime.usersConn.db
    .collection("users")
    .findOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { projection: { mode: 1, isSandbox: 1, isReviewerAccount: 1 } }
    );

  if (!owner) throw httpError(404, "USER_NOT_FOUND", "Compte introuvable.");

  if (resolveUserMode(owner) !== SANDBOX) {
    throw httpError(409, "NOT_A_SANDBOX_ACCOUNT", "Ce compte n'est pas un compte de simulation.");
  }

  const cur = String(currency || "").trim().toUpperCase();
  if (cur.length < 3 || cur.length > 4) {
    throw httpError(400, "INVALID_CURRENCY", "Devise absente ou invalide.");
  }

  const initial = normalizeAmount(initialBalance, cur);
  const { Wallet } = models();

  await Wallet.ensureWallet(id, cur, { mode: SANDBOX });
  await scenarios.ensureProfile(id, { currency: cur, initialBalance: initial });

  const funding = await postFunding({
    userId: id,
    currency: cur,
    amount: initial,
    direction: "credit",
    kind: "PROVISION",
    idempotencyKey: `provision:${id}`,
    requestedBy: "provisioning",
  });

  return {
    userId: id,
    provisioned: true,
    funded: !funding.replayed,
    wallet: walletView(await readWallet(id, cur), cur),
  };
}

/**
 * Trésoreries de simulation : les comptes internes qui reçoivent frais et
 * marge des transactions sandbox. Seuls les rôles `SANDBOX_*` sont acceptés —
 * ce chemin ne peut pas créer une vraie trésorerie.
 */
async function provisionTreasuries(treasuries = []) {
  const {
    SANDBOX_TREASURY_SYSTEM_TYPES,
    loadTreasuryRegistry,
  } = require("../treasuryRegistry");

  const SystemBalance = runtime.SystemBalance;
  if (!SystemBalance) {
    throw httpError(503, "SYSTEM_WALLET_MODEL_UNAVAILABLE", "Modèle de trésorerie indisponible.");
  }

  const results = [];

  for (const t of treasuries) {
    const systemType = String(t?.systemType || "").trim().toUpperCase();
    if (!SANDBOX_TREASURY_SYSTEM_TYPES.includes(systemType)) {
      throw httpError(400, "NOT_A_SANDBOX_TREASURY", `Rôle refusé : ${systemType}.`);
    }

    const ownerId = String(t?.userId || "").trim();
    if (!mongoose.isValidObjectId(ownerId)) {
      throw httpError(400, "INVALID_USER_ID", `Identifiant invalide pour ${systemType}.`);
    }

    const owner = await runtime.usersConn.db
      .collection("users")
      .findOne(
        { _id: new mongoose.Types.ObjectId(ownerId) },
        { projection: { systemType: 1, isSystem: 1, mode: 1 } }
      );

    if (!owner || owner.systemType !== systemType || owner.mode !== SANDBOX) {
      throw httpError(
        409,
        "TREASURY_OWNER_MISMATCH",
        `Le compte ${ownerId} n'est pas le compte système sandbox ${systemType}.`
      );
    }

    const wallet = await SystemBalance.ensureSystemWallet(ownerId, systemType, t.currency, {
      allowCreate: true,
      fullName: systemType,
    });

    results.push({ systemType, userId: ownerId, walletId: String(wallet._id) });
  }

  await loadTreasuryRegistry(runtime.txConn.db);

  return results;
}

module.exports = {
  getState,
  updateScenario,
  faucet,
  drain,
  reset,
  provisionAccount,
  provisionTreasuries,
  // exportés pour les tests
  FAUCET_CEILING_MULTIPLIER,
  RESET_FAILURE,
};
