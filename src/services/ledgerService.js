"use strict";

/**
 * --------------------------------------------------------------------------
 * Ledger Service
 * --------------------------------------------------------------------------
 * - séparation explicite user wallet / system treasury wallet
 * - fee revenue => FEES_TREASURY
 * - fx revenue  => FX_MARGIN_TREASURY
 * - fallback prudent vers TxWalletBalance si TxSystemBalance n'existe pas encore
 * --------------------------------------------------------------------------
 */

const mongoose = require("mongoose");
const {
  roundMoney,
  buildTreasuryRevenueBreakdown,
} = require("./pricingSnapshotNormalizer");

const { getTxConn, getUsersConn } = require("../config/db");
const {
  canUseSharedSession,
  hasRealTransaction,
} = require("../utils/sharedSession");

const {
  LEDGER_VERSION,
  assertBalanced,
  transferLegs,
  systemReserveAccountId,
  systemClearingAccountId,
  buildDedupKey,
} = require("./ledger/doubleEntry");

/**
 * RÉSOLUTION PARESSEUSE DES MODÈLES
 * ---------------------------------------------------------------------------
 * Ce fichier appelait `getTxConn()` au premier niveau, puis résolvait ses trois
 * modèles dans la foulée. `getTxConn()` lève tant que `connectTransactionsDB()`
 * n'a pas tourné : charger ce service — et donc tout contrôleur de transaction —
 * était impossible hors d'un processus serveur démarré.
 *
 * C'est le même défaut que celui corrigé dans `src/config.js` : une dépendance
 * d'entrée/sortie résolue à l'import. On résout au premier usage, et une seule
 * fois.
 */
let _txConn = null;
let _LedgerEntry = null;
let _UserWalletBalance = null;
let _SystemWalletBalance = null;
let _systemLookupDone = false;

function txConnection() {
  if (!_txConn) _txConn = getTxConn();
  return _txConn;
}

function ledgerEntryModel() {
  if (!_LedgerEntry) {
    _LedgerEntry = require("../models/LedgerEntry")(txConnection());
  }
  return _LedgerEntry;
}

function userWalletModel() {
  if (!_UserWalletBalance) {
    _UserWalletBalance = require("../models/TxWalletBalance")(txConnection());
  }
  return _UserWalletBalance;
}

/**
 * `TxSystemBalance` peut légitimement ne pas exister : le repli sur
 * `TxWalletBalance` est prévu. On mémorise donc l'échec pour ne pas retenter à
 * chaque appel.
 */
function systemWalletModel() {
  if (_systemLookupDone) return _SystemWalletBalance;
  _systemLookupDone = true;

  try {
    _SystemWalletBalance = require("../models/TxSystemBalance")(txConnection());
  } catch {
    _SystemWalletBalance = null;
  }

  return _SystemWalletBalance;
}

const TREASURY_SYSTEM_TYPES = new Set([
  "REFERRAL_TREASURY",
  "FEES_TREASURY",
  "OPERATIONS_TREASURY",
  "CAGNOTTE_FEES_TREASURY",
  "FX_MARGIN_TREASURY",
]);

const TREASURY_ENV_BY_SYSTEM_TYPE = Object.freeze({
  REFERRAL_TREASURY: String(process.env.REFERRAL_TREASURY_USER_ID || "").trim(),
  FEES_TREASURY: String(process.env.FEES_TREASURY_USER_ID || "").trim(),
  OPERATIONS_TREASURY: String(process.env.OPERATIONS_TREASURY_USER_ID || "").trim(),
  CAGNOTTE_FEES_TREASURY: String(process.env.CAGNOTTE_FEES_TREASURY_USER_ID || "").trim(),
  FX_MARGIN_TREASURY: String(process.env.FX_MARGIN_TREASURY_USER_ID || "").trim(),
});

/**
 * ⚠️ `canUseSharedSession()` N'EST PAS FACULTATIF ICI.
 *
 * Cette fonction testait `session` seul. En mode dégradé, `startTxSession()`
 * rend une session malgré tout — inutile, puisqu'aucune transaction n'est
 * ouverte — et les écritures du grand livre partaient donc avec une session
 * pendant que `tx.save()` n'en portait pas, via la version de `runtime.js` qui,
 * elle, posait bien la garde. Deux régimes pour un même mouvement.
 *
 * Le prédicat vit maintenant dans `utils/sharedSession.js`, en un seul
 * exemplaire. Il n'est PAS importé depuis `runtime.js` : `runtime` importe déjà
 * ce fichier.
 */
function sharedSessionAvailable() {
  return canUseSharedSession(getUsersConn, getTxConn);
}

function maybeSessionOpts(session) {
  return sharedSessionAvailable() && session ? { session } : {};
}

function normalizeCurrency(currency) {
  const cur = String(currency || "").trim().toUpperCase();
  if (!cur || cur.length < 3 || cur.length > 6) {
    throw new Error(`Devise invalide: ${currency}`);
  }
  return cur;
}

function normalizeObjectIdLike(v, fieldName) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${fieldName} requis`);
  return s;
}

function normalizePositiveAmount(amount, currency = "CAD", { allowZero = false } = {}) {
  const rounded = Number(roundMoney(Number(amount || 0), currency));
  if (!Number.isFinite(rounded)) {
    throw new Error(`Montant invalide: ${amount}`);
  }
  if (allowZero ? rounded < 0 : rounded <= 0) {
    throw new Error(`Montant invalide (${rounded}) pour ${currency}`);
  }
  return rounded;
}

function normalizeTreasurySystemType(value, fieldName = "treasurySystemType") {
  const s = String(value || "").trim().toUpperCase();
  if (!s) throw new Error(`${fieldName} requis`);
  if (!TREASURY_SYSTEM_TYPES.has(s)) {
    throw new Error(`${fieldName} invalide: ${value}`);
  }
  return s;
}

function getTreasuryUserIdBySystemType(systemType) {
  const normalizedType = normalizeTreasurySystemType(systemType, "systemType");
  const treasuryUserId = String(
    TREASURY_ENV_BY_SYSTEM_TYPE[normalizedType] || ""
  ).trim();

  if (!treasuryUserId) {
    throw new Error(`Aucun treasuryUserId configuré pour ${normalizedType}`);
  }

  return treasuryUserId;
}

function resolveTreasuryFromSystemType(systemType) {
  return getTreasuryUserIdBySystemType(systemType);
}

function normalizeOptionalLabel(value, fallback = "") {
  return String(value || fallback || "").trim();
}

function dec(n, currency = "CAD") {
  const value = normalizePositiveAmount(n, currency, { allowZero: true });
  return mongoose.Types.Decimal128.fromString(String(value));
}

function assertTransactionLike(transaction) {
  if (!transaction || !transaction._id) {
    throw new Error("transaction invalide");
  }
}

function userWalletAccountId(userId, currency) {
  return `user_wallet:${normalizeObjectIdLike(userId, "userId")}:${normalizeCurrency(currency)}`;
}

function treasuryAccountId({ treasuryUserId, treasurySystemType, currency }) {
  const userId = normalizeObjectIdLike(treasuryUserId, "treasuryUserId");
  const systemType = normalizeTreasurySystemType(treasurySystemType);
  const cur = normalizeCurrency(currency);
  return `treasury:${systemType}:${userId}:${cur}`;
}

function assertUserWalletModel() {
  const UserWalletBalance = userWalletModel();

  if (!UserWalletBalance) {
    throw new Error("TxWalletBalance indisponible");
  }

  const requiredMethods = [
    "reserve",
    "captureReserve",
    "releaseReserve",
    "credit",
    "debit",
  ];

  for (const method of requiredMethods) {
    if (typeof UserWalletBalance[method] !== "function") {
      throw new Error(`TxWalletBalance.${method} indisponible`);
    }
  }
}

function resolveTreasuryContext({
  treasuryUserId = null,
  treasurySystemType,
  treasuryLabel = "",
}) {
  const systemType = normalizeTreasurySystemType(treasurySystemType);
  const resolvedTreasuryUserId = treasuryUserId
    ? normalizeObjectIdLike(treasuryUserId, "treasuryUserId")
    : resolveTreasuryFromSystemType(systemType);

  return {
    treasuryUserId: resolvedTreasuryUserId,
    treasurySystemType: systemType,
    treasuryLabel: normalizeOptionalLabel(treasuryLabel),
  };
}

function getSystemWalletModel() {
  return systemWalletModel();
}

function buildSystemBalanceQuery({ treasuryUserId, treasurySystemType }) {
  const id = normalizeObjectIdLike(treasuryUserId, "treasuryUserId");
  const systemType = normalizeTreasurySystemType(treasurySystemType);

  const clauses = [
    { userId: id, systemType },
    { ownerId: id, systemType },
  ];

  if (mongoose.Types.ObjectId.isValid(id)) {
    const oid = new mongoose.Types.ObjectId(id);
    clauses.push({ userId: oid, systemType }, { ownerId: oid, systemType });
  }

  return {
    $or: clauses,
  };
}

async function ensureSystemBalanceDocument({
  treasuryUserId,
  treasurySystemType,
  currency,
  treasuryLabel = "",
  session = null,
}) {
  const SystemBalance = getSystemWalletModel();
  if (!SystemBalance) return null;

  const cur = normalizeCurrency(currency);
  const query = buildSystemBalanceQuery({ treasuryUserId, treasurySystemType });

  let doc = await SystemBalance.findOne(query).session(session || null);
  if (doc) {
    if (doc.balances == null || typeof doc.balances !== "object") {
      doc.balances = {};
    }
    if (doc.balances[cur] == null) {
      doc.balances[cur] = 0;
    }
    return doc;
  }

  const seedBalances = { [cur]: 0 };
  const [created] = await SystemBalance.create(
    [
      {
        userId: treasuryUserId,
        systemType: normalizeTreasurySystemType(treasurySystemType),
        fullName: normalizeOptionalLabel(treasuryLabel) || treasurySystemType,
        isSystem: true,
        managedCurrency: "MULTI",
        defaultCurrency: cur,
        balances: seedBalances,
        isActive: true,
        metadata: {
          source: "ledgerService.ensureSystemBalanceDocument",
        },
      },
    ],
    maybeSessionOpts(session)
  );

  return created;
}

async function creditSystemWallet({
  treasuryUserId,
  treasurySystemType,
  amount,
  currency,
  treasuryLabel = "",
  session = null,
}) {
  const cur = normalizeCurrency(currency);
  const amt = normalizePositiveAmount(amount, cur);

  const SystemBalance = getSystemWalletModel();

  if (SystemBalance && typeof SystemBalance.credit === "function") {
    return SystemBalance.credit(
      treasuryUserId,
      normalizeTreasurySystemType(treasurySystemType),
      cur,
      amt,
      maybeSessionOpts(session)
    );
  }

  if (SystemBalance) {
    const doc = await ensureSystemBalanceDocument({
      treasuryUserId,
      treasurySystemType,
      currency: cur,
      treasuryLabel,
      session,
    });

    const balancePath = `balances.${cur}`;
    return SystemBalance.findOneAndUpdate(
      { _id: doc._id },
      {
        $inc: { [balancePath]: amt },
        $set: {
          updatedAt: new Date(),
          defaultCurrency: doc.defaultCurrency || cur,
          managedCurrency: doc.managedCurrency || "MULTI",
          isSystem: true,
          isActive: doc.isActive !== false,
        },
        $push: {
          balanceHistory: {
            type: "credit",
            amount: amt,
            currency: cur,
            reason: `ledger:${normalizeTreasurySystemType(treasurySystemType)}`,
            createdAt: new Date(),
          },
        },
      },
      { new: true, session }
    );
  }

  await userWalletModel().credit(
    treasuryUserId,
    cur,
    amt,
    maybeSessionOpts(session)
  );

  return null;
}

async function debitSystemWallet({
  treasuryUserId,
  treasurySystemType,
  amount,
  currency,
  treasuryLabel = "",
  session = null,
}) {
  const cur = normalizeCurrency(currency);
  const amt = normalizePositiveAmount(amount, cur);

  const SystemBalance = getSystemWalletModel();

  if (SystemBalance && typeof SystemBalance.debit === "function") {
    return SystemBalance.debit(
      treasuryUserId,
      normalizeTreasurySystemType(treasurySystemType),
      cur,
      amt,
      maybeSessionOpts(session)
    );
  }

  if (SystemBalance) {
    const doc = await ensureSystemBalanceDocument({
      treasuryUserId,
      treasurySystemType,
      currency: cur,
      treasuryLabel,
      session,
    });

    const current = Number(doc?.balances?.[cur] || 0);
    if (current < amt) {
      throw new Error(
        `Solde insuffisant sur ${treasurySystemType} en ${cur}. Disponible=${current}, requis=${amt}`
      );
    }

    const balancePath = `balances.${cur}`;
    return SystemBalance.findOneAndUpdate(
      { _id: doc._id, [balancePath]: { $gte: amt } },
      {
        $inc: { [balancePath]: -amt },
        $set: { updatedAt: new Date() },
        $push: {
          balanceHistory: {
            type: "debit",
            amount: amt,
            currency: cur,
            reason: `ledger:${normalizeTreasurySystemType(treasurySystemType)}`,
            createdAt: new Date(),
          },
        },
      },
      { new: true, session }
    );
  }

  await userWalletModel().debit(
    treasuryUserId,
    cur,
    amt,
    maybeSessionOpts(session)
  );

  return null;
}

async function createLedgerEntry({
  transactionId,
  reference,
  userId = null,
  accountType,
  accountId,
  direction,
  entryType,
  amount,
  currency,
  metadata = null,
  session = null,
}) {
  const normalizedCurrency = normalizeCurrency(currency);
  const normalizedAmount = normalizePositiveAmount(amount, normalizedCurrency, {
    allowZero: false,
  });

  const allowedDirections = new Set(["DEBIT", "CREDIT"]);
  const allowedAccountTypes = new Set([
    "USER_WALLET",
    "TREASURY",
    "SYSTEM_CLEARING",
    "SYSTEM_RESERVE",
  ]);
  const allowedEntryTypes = new Set([
    "RESERVE",
    "RESERVE_CAPTURE",
    "RESERVE_RELEASE",
    "USER_DEBIT",
    "USER_CREDIT",
    "REVERSAL",
    "REFUND",
    "FEE_REVENUE",
    "FX_REVENUE",
    "ADJUSTMENT",
    // Doit rester aligné sur `ENTRY_TYPES` de models/ledgerEntryModel().js : les deux
    // listes sont séparées, un ajout ici sans l'autre passe la validation du
    // service puis échoue à l'écriture.
    "REFERRAL_PAYOUT",
  ]);

  if (!allowedDirections.has(String(direction || "").toUpperCase())) {
    throw new Error(`direction ledger invalide: ${direction}`);
  }

  if (!allowedAccountTypes.has(String(accountType || "").toUpperCase())) {
    throw new Error(`accountType ledger invalide: ${accountType}`);
  }

  if (!allowedEntryTypes.has(String(entryType || "").toUpperCase())) {
    throw new Error(`entryType ledger invalide: ${entryType}`);
  }

  const [doc] = await ledgerEntryModel().create(
    [
      {
        transactionId,
        reference: reference || null,
        userId: userId || null,
        accountType: String(accountType).toUpperCase(),
        accountId: String(accountId || "").trim(),
        direction: String(direction).toUpperCase(),
        entryType: String(entryType).toUpperCase(),
        amount: dec(normalizedAmount, normalizedCurrency),
        currency: normalizedCurrency,
        status: "POSTED",
        metadata:
          metadata && typeof metadata === "object" && !Array.isArray(metadata)
            ? metadata
            : null,
      },
    ],
    maybeSessionOpts(session)
  );

  return doc;
}

/**
 * ============================================================================
 * ÉCRITURE EN PARTIE DOUBLE
 * ============================================================================
 *
 * Écrit un jeu de jambes ÉQUILIBRÉ, ou n'écrit rien.
 *
 * ⚠️ L'ÉQUILIBRE EST VÉRIFIÉ AVANT TOUTE ÉCRITURE, PAS APRÈS.
 * Détecter un déséquilibre après coup ne servirait à rien : les lignes seraient
 * déjà en base, et le grand livre est immuable — on ne les retirerait pas. La
 * seule protection utile est le refus en amont.
 *
 * ⚠️ `insertMany({ ordered: true })`, ET SURTOUT PAS `create(tableau)`.
 *
 * RECTIFICATIF — ce commentaire affirmait auparavant que `Model.create(tableau)`
 * partait « en une commande `insertMany`, atomique au niveau du lot ». C'est
 * FAUX sous Mongoose 7 : sans l'option `ordered`, `create` prend la branche
 * `Promise.all(args.map(doc => doc.$save()))` (`lib/model.js`), soit N
 * insertions INDÉPENDANTES et PARALLÈLES. Vérifié sur mongoose 7.8.12.
 *
 * Deux conséquences, toutes deux contraires à l'intention du module :
 *   - hors transaction, une panne entre les deux jambes laissait une écriture
 *     orpheline — le déséquilibre que ce code existe pour empêcher ;
 *   - sur un lot déjà partiellement écrit, la jambe en collision et la jambe
 *     manquante partaient EN MÊME TEMPS : la relecture de rattrapage courait
 *     contre une insertion en vol, et `LEDGER_PARTIAL_POSTING` se levait de
 *     façon non déterministe sur un lot en train de se compléter correctement.
 *
 * `insertMany` avec `ordered: true` envoie une SEULE commande, séquentielle et
 * au niveau du lot pour un même lot ordonné.
 *
 * `metadata.ledgerVersion` marque ces écritures : la balance de vérification ne
 * porte que sur elles, l'historique en partie simple étant laissé intact.
 */
async function postDoubleEntry({
  transactionId,
  reference = null,
  entryType,
  legs,
  metadata = null,
  session = null,
  context = "",
  dedupScope = null,
}) {
  assertBalanced(legs, context || entryType || "");

  const normalizedType = String(entryType || "").toUpperCase();

  const docs = legs.map((leg, legIndex) => {
    const cur = normalizeCurrency(leg.currency);

    const dedupKey = buildDedupKey({
      transactionId,
      scope: dedupScope,
      legIndex,
    });

    return {
      // Absent — et non `null` — quand aucune portée n'est fournie : l'index
      // unique partiel ne doit pas voir ce document. Voir `models/LedgerEntry`.
      ...(dedupKey ? { dedupKey } : {}),
      transactionId,
      reference: reference || null,
      userId: leg.userId || null,
      accountType: String(leg.accountType).toUpperCase(),
      accountId: String(leg.accountId).trim(),
      direction: String(leg.direction).toUpperCase(),
      entryType: String(leg.entryType || normalizedType).toUpperCase(),
      amount: dec(normalizePositiveAmount(leg.amount, cur), cur),
      currency: cur,
      status: "POSTED",
      metadata: {
        ...(metadata && typeof metadata === "object" && !Array.isArray(metadata)
          ? metadata
          : {}),
        ...(leg.metadata && typeof leg.metadata === "object" ? leg.metadata : {}),
        ledgerVersion: LEDGER_VERSION,
      },
    };
  });

  const model = ledgerEntryModel();

  try {
    // Une seule commande, séquentielle : la première jambe qui échoue arrête
    // le lot. `create(docs)` aurait lancé les jambes en parallèle.
    return await model.insertMany(docs, {
      ordered: true,
      ...maybeSessionOpts(session),
    });
  } catch (err) {
    /**
     * ========================================================================
     * L'INDEX A REFUSÉ UNE ÉCRITURE — CE N'EST PAS FORCÉMENT UNE ERREUR
     * ========================================================================
     *
     * Une collision sur `dedupKey` signifie une seule chose : CE MOUVEMENT A
     * DÉJÀ ÉTÉ ENREGISTRÉ. Le rejeu doit donc réussir en silence — c'est tout
     * l'intérêt de l'idempotence. Relancer l'erreur ferait échouer une
     * transaction pourtant correctement comptabilisée, et un appelant qui
     * réessaie encore tournerait en boucle sur un mouvement déjà passé.
     *
     * ⚠️ MAIS ON NE LE CROIT PAS SUR PAROLE. On relit les clés du lot : si
     * elles ne sont pas TOUTES présentes, la première tentative s'est
     * interrompue au milieu et le grand livre porte un lot INCOMPLET — donc
     * déséquilibré. C'est précisément le cas qu'il ne faut pas absorber : on
     * lève une erreur nommée, qui dit quoi chercher.
     *
     * Le rattrapage ne s'applique QUE hors session. Avec une session, la
     * transaction MongoDB annule déjà tout le lot et rejoue proprement ; lire
     * dans une session en cours d'annulation n'aurait aucun sens.
     */
    const keys = docs.map((d) => d.dedupKey).filter(Boolean);

    /**
     * ⚠️ `hasRealTransaction`, ET SURTOUT PAS `session` SEUL.
     *
     * Le test portait sur la véracité de `session`. En mode dégradé,
     * `startTxSession()` rend pourtant une session — sans transaction derrière.
     * Le rattrapage se désactivait donc EXACTEMENT dans le régime pour lequel
     * il avait été écrit, et le seul chemin qui l'atteignait était celui des
     * tests, qui passent `session: null`.
     *
     * Avec une vraie transaction, relancer est le bon geste : MongoDB annule
     * tout le lot et l'appelant rejoue proprement. Sans transaction, relancer
     * laisse un mouvement de portefeuille déjà validé et non annulable en face
     * d'un grand livre qui refuse l'écriture.
     */
    if (
      !isDuplicateKeyError(err) ||
      !keys.length ||
      hasRealTransaction(session, getUsersConn, getTxConn)
    ) {
      throw err;
    }

    const found = await model.find({ dedupKey: { $in: keys } });

    /**
     * Remis dans l'ordre des jambes. `find` rend l'ordre de l'index, pas celui
     * de `keys` : un appelant qui prend `[0]` — c'est le cas de
     * `creditRevenueLineToTreasury` — recevrait sinon une jambe arbitraire.
     */
    const byKey = new Map(found.map((doc) => [doc.dedupKey, doc]));
    const existing = keys.map((k) => byKey.get(k)).filter(Boolean);

    if (existing.length === docs.length) return existing;

    const partial = new Error(
      `Grand livre INCOMPLET pour ${context || normalizedType || "?"} : ` +
        `${existing.length} jambe(s) enregistrée(s) sur ${docs.length}. ` +
        "Le lot précédent s'est interrompu en cours d'écriture — la " +
        "contre-écriture manquante doit être posée à la main."
    );
    partial.code = "LEDGER_PARTIAL_POSTING";
    partial.status = 500;
    partial.details = { transactionId: String(transactionId), keys };
    throw partial;
  }
}

/**
 * Une violation d'index unique MongoDB, quelle que soit la couche qui la
 * remonte : le pilote pose `code: 11000`, `insertMany` l'enveloppe parfois dans
 * un `writeErrors[]`, et Mongoose peut la retyper en `MongoBulkWriteError`.
 * Tester le seul `err.code` laisserait passer la forme groupée.
 */
function isDuplicateKeyError(err) {
  if (!err) return false;
  if (err.code === 11000 || err.code === 11001) return true;

  const writeErrors = err.writeErrors || err?.result?.writeErrors;
  if (Array.isArray(writeErrors)) {
    return writeErrors.some((e) => (e?.code ?? e?.err?.code) === 11000);
  }

  return false;
}

async function reserveSenderFunds({ transaction, senderId, amount, currency, session = null }) {
  assertTransactionLike(transaction);
  assertUserWalletModel();

  const sender = normalizeObjectIdLike(senderId, "senderId");
  const cur = normalizeCurrency(currency);
  const amt = normalizePositiveAmount(amount, cur);

  const wallet = await userWalletModel().reserve(
    sender,
    cur,
    amt,
    maybeSessionOpts(session)
  );

  /**
   * PARTIE DOUBLE. Une réservation déplace des fonds du solde DISPONIBLE vers un
   * compte de fonds GELÉS — ce n'est pas une sortie d'argent, c'est un
   * changement de disponibilité. Les deux jambes le disent ; une jambe unique
   * laissait croire à une sortie.
   */
  await postDoubleEntry({
    transactionId: transaction._id,
    reference: transaction.reference,
    entryType: "RESERVE",
    context: "reserveSenderFunds",
    dedupScope: "reserveSenderFunds",
    legs: transferLegs({
      from: {
        accountType: "USER_WALLET",
        accountId: userWalletAccountId(sender, cur),
        userId: sender,
      },
      to: {
        accountType: "SYSTEM_RESERVE",
        // L'identifiant porte l'utilisateur : sans lui, impossible de répondre
        // à « de qui sont ces fonds gelés ? » quand une réserve reste bloquée.
        accountId: systemReserveAccountId(sender, cur),
        userId: sender,
      },
      amount: amt,
      currency: cur,
    }),
    metadata: { stage: "initiate", flow: transaction.flow || null },
    session,
  });

  return wallet;
}

async function captureSenderReserve({ transaction, senderId, amount, currency, session = null }) {
  assertTransactionLike(transaction);
  assertUserWalletModel();

  const sender = normalizeObjectIdLike(senderId, "senderId");
  const cur = normalizeCurrency(currency);
  const amt = normalizePositiveAmount(amount, cur);

  const wallet = await userWalletModel().captureReserve(
    sender,
    cur,
    amt,
    maybeSessionOpts(session)
  );

  /**
   * PARTIE DOUBLE. La capture sort les fonds de la réserve vers la
   * COMPENSATION : ils ont quitté l'expéditeur mais ne sont pas encore chez le
   * bénéficiaire. C'est cet état intermédiaire qui n'existait nulle part, et
   * c'est exactement là que l'argent se perd quand quelque chose échoue entre
   * les deux.
   */
  await postDoubleEntry({
    transactionId: transaction._id,
    reference: transaction.reference,
    entryType: "RESERVE_CAPTURE",
    context: "captureSenderReserve",
    dedupScope: "captureSenderReserve",
    legs: transferLegs({
      from: {
        accountType: "SYSTEM_RESERVE",
        accountId: systemReserveAccountId(sender, cur),
        userId: sender,
      },
      to: {
        accountType: "SYSTEM_CLEARING",
        accountId: systemClearingAccountId(cur),
        userId: null,
      },
      amount: amt,
      currency: cur,
    }),
    metadata: { stage: "confirm", flow: transaction.flow || null },
    session,
  });

  return wallet;
}

async function releaseSenderReserve({ transaction, senderId, amount, currency, session = null }) {
  assertTransactionLike(transaction);
  assertUserWalletModel();

  const sender = normalizeObjectIdLike(senderId, "senderId");
  const cur = normalizeCurrency(currency);
  const amt = normalizePositiveAmount(amount, cur);

  const wallet = await userWalletModel().releaseReserve(
    sender,
    cur,
    amt,
    maybeSessionOpts(session)
  );

  /**
   * PARTIE DOUBLE — l'exacte symétrie de la réservation. Les fonds gelés
   * redeviennent disponibles ; rien n'entre ni ne sort du système.
   */
  await postDoubleEntry({
    transactionId: transaction._id,
    reference: transaction.reference,
    entryType: "RESERVE_RELEASE",
    context: "releaseSenderReserve",
    dedupScope: "releaseSenderReserve",
    legs: transferLegs({
      from: {
        accountType: "SYSTEM_RESERVE",
        accountId: systemReserveAccountId(sender, cur),
        userId: sender,
      },
      to: {
        accountType: "USER_WALLET",
        accountId: userWalletAccountId(sender, cur),
        userId: sender,
      },
      amount: amt,
      currency: cur,
    }),
    metadata: { stage: "cancel_or_failure", flow: transaction.flow || null },
    session,
  });

  return wallet;
}

async function creditReceiverFunds({ transaction, receiverId, amount, currency, session = null }) {
  assertTransactionLike(transaction);
  assertUserWalletModel();

  const receiver = normalizeObjectIdLike(receiverId, "receiverId");
  const cur = normalizeCurrency(currency);
  const amt = normalizePositiveAmount(amount, cur);

  const wallet = await userWalletModel().credit(
    receiver,
    cur,
    amt,
    maybeSessionOpts(session)
  );

  /**
   * PARTIE DOUBLE. Le bénéficiaire est crédité DEPUIS la compensation : l'argent
   * vient de quelque part, et ce quelque part est la capture faite chez
   * l'expéditeur. La boucle se ferme, et son bouclage devient vérifiable.
   */
  await postDoubleEntry({
    transactionId: transaction._id,
    reference: transaction.reference,
    entryType: "USER_CREDIT",
    context: "creditReceiverFunds",
    dedupScope: "creditReceiverFunds",
    legs: transferLegs({
      from: {
        accountType: "SYSTEM_CLEARING",
        accountId: systemClearingAccountId(cur),
        userId: null,
      },
      to: {
        accountType: "USER_WALLET",
        accountId: userWalletAccountId(receiver, cur),
        userId: receiver,
      },
      amount: amt,
      currency: cur,
    }),
    metadata: { stage: "confirm", flow: transaction.flow || null },
    session,
  });

  return wallet;
}

async function debitReceiverFunds({ transaction, receiverId, amount, currency, session = null }) {
  assertTransactionLike(transaction);
  assertUserWalletModel();

  const receiver = normalizeObjectIdLike(receiverId, "receiverId");
  const cur = normalizeCurrency(currency);
  const amt = normalizePositiveAmount(amount, cur);

  const wallet = await userWalletModel().debit(
    receiver,
    cur,
    amt,
    maybeSessionOpts(session)
  );

  /**
   * PARTIE DOUBLE. Reprise chez le bénéficiaire : les fonds retournent en
   * compensation, d'où ils repartiront vers l'expéditeur (`refundSenderFunds`).
   *
   * Les deux mouvements sont DISTINCTS et c'est voulu — une reprise sans
   * remboursement laisse les fonds en compensation, ce qui est un état
   * observable plutôt qu'un trou.
   */
  await postDoubleEntry({
    transactionId: transaction._id,
    reference: transaction.reference,
    entryType: "REVERSAL",
    context: "debitReceiverFunds",
    dedupScope: "debitReceiverFunds",
    legs: transferLegs({
      from: {
        accountType: "USER_WALLET",
        accountId: userWalletAccountId(receiver, cur),
        userId: receiver,
      },
      to: {
        accountType: "SYSTEM_CLEARING",
        accountId: systemClearingAccountId(cur),
        userId: null,
      },
      amount: amt,
      currency: cur,
    }),
    metadata: { stage: "refund", flow: transaction.flow || null },
    session,
  });

  return wallet;
}

async function refundSenderFunds({ transaction, senderId, amount, currency, session = null }) {
  assertTransactionLike(transaction);
  assertUserWalletModel();

  const sender = normalizeObjectIdLike(senderId, "senderId");
  const cur = normalizeCurrency(currency);
  const amt = normalizePositiveAmount(amount, cur);

  const wallet = await userWalletModel().credit(
    sender,
    cur,
    amt,
    maybeSessionOpts(session)
  );

  /**
   * PARTIE DOUBLE. Le remboursement rend les fonds à l'expéditeur DEPUIS la
   * compensation — symétrique du crédit au bénéficiaire.
   */
  /**
   * ⚠️ AUCUN `dedupScope` ICI, ET C'EST DÉLIBÉRÉ.
   *
   * Un remboursement n'est pas garanti unique par transaction : deux
   * remboursements partiels du même montant sur la même transaction sont une
   * opération légitime. Une portée réduite à « refundSenderFunds » les rendrait
   * indiscernables et l'index REFUSERAIT le second — un faux rejet sur le
   * chemin de l'argent, aussi grave qu'un doublon.
   *
   * Pour protéger ce chemin, il faut d'abord que l'appelant transmette
   * l'identité du remboursement (l'identifiant de la demande, `TxRefundRequest`)
   * jusqu'ici : la portée deviendra `refundSenderFunds:<refundRequestId>`. Tant
   * qu'elle n'est pas disponible dans cette signature, mieux vaut pas de clé
   * qu'une clé fausse.
   */
  await postDoubleEntry({
    transactionId: transaction._id,
    reference: transaction.reference,
    entryType: "REFUND",
    context: "refundSenderFunds",
    legs: transferLegs({
      from: {
        accountType: "SYSTEM_CLEARING",
        accountId: systemClearingAccountId(cur),
        userId: null,
      },
      to: {
        accountType: "USER_WALLET",
        accountId: userWalletAccountId(sender, cur),
        userId: sender,
      },
      amount: amt,
      currency: cur,
    }),
    metadata: { stage: "refund", flow: transaction.flow || null },
    session,
  });

  return wallet;
}

async function creditRevenueLineToTreasury({
  transaction,
  revenueLine,
  explicitTreasuryUserId = null,
  explicitTreasuryLabel = "",
  entryType,
  session = null,
}) {
  const systemType = normalizeTreasurySystemType(revenueLine?.systemType);

  const treasury = resolveTreasuryContext({
    treasuryUserId: explicitTreasuryUserId,
    treasurySystemType: systemType,
    treasuryLabel: explicitTreasuryLabel,
  });

  const treasuryCurrency = normalizeCurrency(revenueLine?.treasuryCurrency || "CAD");
  const treasuryAmount = normalizePositiveAmount(
    revenueLine?.treasuryAmount || 0,
    treasuryCurrency,
    { allowZero: true }
  );

  if (treasuryAmount <= 0) {
    return null;
  }

  const walletAfter = await creditSystemWallet({
    treasuryUserId: treasury.treasuryUserId,
    treasurySystemType: treasury.treasurySystemType,
    amount: treasuryAmount,
    currency: treasuryCurrency,
    treasuryLabel: treasury.treasuryLabel,
    session,
  });

  const metadata = {
    treasuryUserId: treasury.treasuryUserId,
    treasurySystemType: treasury.treasurySystemType,
    treasuryLabel: treasury.treasuryLabel || null,
    sourceAmount: Number(revenueLine?.sourceAmount || 0),
    sourceCurrency: revenueLine?.sourceCurrency || null,
    treasuryAmount,
    treasuryCurrency,
    conversionRateToTreasury: Number(revenueLine?.conversionRateToTreasury || 0),
    flow: transaction.flow || null,
  };

  if (entryType === "FX_REVENUE") {
    metadata.idealNetTo = Number(revenueLine?.idealNetTo || 0);
    metadata.actualNetTo = Number(revenueLine?.actualNetTo || 0);
    metadata.rawAmount = Number(revenueLine?.rawAmount || 0);
  }

  /**
   * ═══ PARTIE DOUBLE, ET LE CAS MULTIDEVISES ═══════════════════════════════
   *
   * C'est le seul mouvement du grand livre qui peut CHANGER DE DEVISE :
   * l'expéditeur paie 200 XOF de frais, la trésorerie encaisse l'équivalent en
   * CAD. `revenueLine.sourceCurrency` et `treasuryCurrency` diffèrent alors.
   *
   * Exiger `Σ DEBIT = Σ CREDIT` toutes devises confondues n'aurait aucun sens —
   * on additionnerait des francs CFA et des dollars canadiens. La règle de tous
   * les grands livres multidevises, et celle appliquée ici, est :
   *
   *     l'équilibre est vérifié PAR DEVISE.
   *
   * La contrepartie est donc posée sur la compensation **dans la devise de la
   * trésorerie**, jamais dans celle de la source. Les deux jambes s'équilibrent,
   * et la conversion apparaît comme un écart entre les soldes de compensation
   * XOF et CAD.
   *
   * ⚠️ CET ÉCART N'EST PAS UNE ERREUR : c'est la POSITION DE CHANGE. Elle
   * existait déjà — elle était simplement invisible. Elle devient mesurable, ce
   * qui est tout l'intérêt de l'opération.
   */
  /**
   * ⚠️ AUCUN `dedupScope` ICI, POUR LA MÊME RAISON QUE LE REMBOURSEMENT.
   *
   * Une transaction peut porter PLUSIEURS lignes de revenu de même nature —
   * deux commissions distinctes versées à `FEES_TREASURY`, par exemple. Elles
   * partageraient alors `entryType` ET compte de destination : une portée
   * dérivée du seul type refuserait la seconde, c'est-à-dire perdrait un revenu
   * réellement encaissé.
   *
   * La portée correcte suppose que `revenueLine` porte un identifiant propre.
   * Elle deviendra `creditRevenueLineToTreasury:<revenueLineId>` le jour où le
   * calcul de tarification en produira un.
   */
  const [entry] = await postDoubleEntry({
    transactionId: transaction._id,
    reference: transaction.reference,
    entryType,
    context: `creditRevenueLineToTreasury:${entryType}`,
    legs: transferLegs({
      from: {
        accountType: "SYSTEM_CLEARING",
        accountId: systemClearingAccountId(treasuryCurrency),
        userId: null,
      },
      to: {
        accountType: "TREASURY",
        accountId: treasuryAccountId({
          treasuryUserId: treasury.treasuryUserId,
          treasurySystemType: treasury.treasurySystemType,
          currency: treasuryCurrency,
        }),
        userId: treasury.treasuryUserId,
      },
      amount: treasuryAmount,
      currency: treasuryCurrency,
    }),
    metadata,
    session,
  });

  return {
    entry,
    walletAfter,
    treasuryUserId: treasury.treasuryUserId,
    treasurySystemType: treasury.treasurySystemType,
    treasuryLabel: treasury.treasuryLabel,
    treasuryAmount,
    treasuryCurrency,
    sourceAmount: Number(revenueLine?.sourceAmount || 0),
    sourceCurrency: revenueLine?.sourceCurrency || null,
    conversionRateToTreasury: Number(revenueLine?.conversionRateToTreasury || 0),
  };
}

async function creditTreasuryRevenue({
  transaction,
  pricingSnapshot,
  treasuryUserId = null,
  treasurySystemType = null,
  treasuryLabel = "",
  session = null,
}) {
  assertTransactionLike(transaction);
  assertUserWalletModel();

  const revenue = buildTreasuryRevenueBreakdown(pricingSnapshot || {});
  const entries = [];

  const feeLine = revenue?.feeRevenue || null;
  const fxLine = revenue?.fxRevenue || null;

  let feeCredit = null;
  let fxCredit = null;

  if (feeLine && Number(feeLine.treasuryAmount || 0) > 0) {
    feeCredit = await creditRevenueLineToTreasury({
      transaction,
      revenueLine: { ...feeLine, systemType: "FEES_TREASURY" },
      explicitTreasuryUserId: treasurySystemType === "FEES_TREASURY" ? treasuryUserId : null,
      explicitTreasuryLabel: treasurySystemType === "FEES_TREASURY" ? treasuryLabel : "",
      entryType: "FEE_REVENUE",
      session,
    });

    if (feeCredit?.entry) entries.push(feeCredit.entry);
  }

  if (fxLine && Number(fxLine.treasuryAmount || 0) > 0) {
    fxCredit = await creditRevenueLineToTreasury({
      transaction,
      revenueLine: { ...fxLine, systemType: "FX_MARGIN_TREASURY" },
      explicitTreasuryUserId: treasurySystemType === "FX_MARGIN_TREASURY" ? treasuryUserId : null,
      explicitTreasuryLabel: treasurySystemType === "FX_MARGIN_TREASURY" ? treasuryLabel : "",
      entryType: "FX_REVENUE",
      session,
    });

    if (fxCredit?.entry) entries.push(fxCredit.entry);
  }

  return {
    feeRevenue: feeCredit,
    fxRevenue: fxCredit,
    pricingSnapshot: revenue?.pricingSnapshot || pricingSnapshot || {},
    entries,
  };
}

async function chargeCancellationFee({
  transaction,
  senderId,
  senderCurrency,
  feeSourceAmount,
  treasuryUserId = null,
  treasurySystemType = "FEES_TREASURY",
  treasuryLabel = "",
  treasuryFeeAmount,
  treasuryFeeCurrency,
  conversionRateToTreasury = 0,
  feeType = "fixed",
  feePercent = 0,
  feeId = null,
  session = null,
}) {
  assertTransactionLike(transaction);
  assertUserWalletModel();

  const sender = normalizeObjectIdLike(senderId, "senderId");
  const treasury = resolveTreasuryContext({
    treasuryUserId,
    treasurySystemType,
    treasuryLabel,
  });

  const sourceCurrency = normalizeCurrency(senderCurrency);
  const targetCurrency = normalizeCurrency(treasuryFeeCurrency);

  const out = {
    senderDebited: false,
    treasuryCredited: false,
    feeSourceAmount: normalizePositiveAmount(feeSourceAmount || 0, sourceCurrency, {
      allowZero: true,
    }),
    feeSourceCurrency: sourceCurrency,
    treasuryFeeAmount: normalizePositiveAmount(treasuryFeeAmount || 0, targetCurrency, {
      allowZero: true,
    }),
    treasuryFeeCurrency: targetCurrency,
    treasuryUserId: treasury.treasuryUserId,
    treasurySystemType: treasury.treasurySystemType,
    treasuryLabel: treasury.treasuryLabel,
    conversionRateToTreasury: Number(conversionRateToTreasury || 0),
    feeType: String(feeType || "fixed").trim().toLowerCase() === "percent" ? "percent" : "fixed",
    feePercent: Number(feePercent || 0),
    feeId: feeId || null,
  };

  if (out.feeSourceAmount > 0) {
    await userWalletModel().debit(
      sender,
      out.feeSourceCurrency,
      out.feeSourceAmount,
      maybeSessionOpts(session)
    );

    /**
     * PARTIE DOUBLE. Les frais d'annulation quittent l'expéditeur vers la
     * compensation, PUIS partent en trésorerie (bloc suivant).
     *
     * Deux écritures distinctes, pas une : les deux montants peuvent être dans
     * des devises différentes (`feeSourceCurrency` ≠ `treasuryFeeCurrency`) et
     * ne s'équilibrent donc pas entre eux. Passer par la compensation permet à
     * chaque devise de rester équilibrée seule.
     */
    await postDoubleEntry({
      transactionId: transaction._id,
      reference: transaction.reference,
      entryType: "ADJUSTMENT",
      context: "chargeCancellationFee:sender",
      dedupScope: "chargeCancellationFee:sender",
      legs: transferLegs({
        from: {
          accountType: "USER_WALLET",
          accountId: userWalletAccountId(sender, out.feeSourceCurrency),
          userId: sender,
        },
        to: {
          accountType: "SYSTEM_CLEARING",
          accountId: systemClearingAccountId(out.feeSourceCurrency),
          userId: null,
        },
        amount: out.feeSourceAmount,
        currency: out.feeSourceCurrency,
      }),
      metadata: {
        stage: "cancel",
        reason: "cancellation_fee",
        feeType: out.feeType,
        feePercent: out.feePercent,
        feeId: out.feeId,
        flow: transaction.flow || null,
        treasuryUserId: treasury.treasuryUserId,
        treasurySystemType: treasury.treasurySystemType,
        treasuryLabel: treasury.treasuryLabel || null,
      },
      session,
    });

    out.senderDebited = true;
  }

  if (out.treasuryFeeAmount > 0) {
    await creditSystemWallet({
      treasuryUserId: treasury.treasuryUserId,
      treasurySystemType: treasury.treasurySystemType,
      amount: out.treasuryFeeAmount,
      currency: out.treasuryFeeCurrency,
      treasuryLabel: treasury.treasuryLabel,
      session,
    });

    /**
     * PARTIE DOUBLE, jambe trésorerie — dans la devise de la TRÉSORERIE.
     * Voir `creditRevenueLineToTreasury` pour le raisonnement multidevises.
     */
    await postDoubleEntry({
      transactionId: transaction._id,
      reference: transaction.reference,
      entryType: "FEE_REVENUE",
      context: "chargeCancellationFee:treasury",
      dedupScope: "chargeCancellationFee:treasury",
      legs: transferLegs({
        from: {
          accountType: "SYSTEM_CLEARING",
          accountId: systemClearingAccountId(out.treasuryFeeCurrency),
          userId: null,
        },
        to: {
          accountType: "TREASURY",
          accountId: treasuryAccountId({
            treasuryUserId: treasury.treasuryUserId,
            treasurySystemType: treasury.treasurySystemType,
            currency: out.treasuryFeeCurrency,
          }),
          userId: treasury.treasuryUserId,
        },
        amount: out.treasuryFeeAmount,
        currency: out.treasuryFeeCurrency,
      }),
      metadata: {
        stage: "cancel",
        reason: "cancellation_fee",
        feeType: out.feeType,
        feePercent: out.feePercent,
        feeId: out.feeId,
        sourceAmount: out.feeSourceAmount,
        sourceCurrency: out.feeSourceCurrency,
        treasuryUserId: treasury.treasuryUserId,
        treasurySystemType: treasury.treasurySystemType,
        treasuryLabel: treasury.treasuryLabel || null,
        conversionRateToTreasury: out.conversionRateToTreasury,
        flow: transaction.flow || null,
      },
      session,
    });

    out.treasuryCredited = true;
  }

  return out;
}

module.exports = {
  postDoubleEntry,
  TREASURY_SYSTEM_TYPES,
  TREASURY_ENV_BY_SYSTEM_TYPE,
  normalizeTreasurySystemType,
  getTreasuryUserIdBySystemType,
  resolveTreasuryFromSystemType,
  getSystemWalletModel,
  creditSystemWallet,
  debitSystemWallet,
  reserveSenderFunds,
  captureSenderReserve,
  releaseSenderReserve,
  creditReceiverFunds,
  debitReceiverFunds,
  refundSenderFunds,
  creditTreasuryRevenue,
  chargeCancellationFee,
  createLedgerEntry,
};