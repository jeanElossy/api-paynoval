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

const crypto = require("node:crypto");
const mongoose = require("mongoose");
const { normalizeAccountCurrency } = require("../utils/currency");
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
  cagnotteVaultClearingAccountId,
  providerInboundClearingAccountId,
  /**
   * ⚠️ Importés depuis `doubleEntry` depuis le 2026-09-03. Ce fichier en
   * portait ses propres copies, dont la normalisation de devise DIVERGEAIT de
   * celle du module : `"FCFA"` produisait `…:XOF` ici et `…:FCFA` là-bas —
   * « deux comptes pour un seul argent ». Une convention d'identifiant de
   * compte est la clé de jointure entre le grand livre et sa projection : elle
   * ne peut pas avoir deux implémentations. `doubleEntry` normalise désormais
   * par `normalizeAccountCurrency`, comme ici.
   */
  userWalletAccountId,
  treasuryAccountId,
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

/**
 * ⚠️ CETTE FONCTION SE CONTENTAIT DE MAJUSCULER — ET C'ÉTAIT UN DÉFAUT.
 *
 * `TxWalletBalance.normCurrency` traduisait `FCFA`/`CFA` → `XOF` ; celle-ci non.
 * Un appel en `FCFA` créait donc un portefeuille en **XOF** et des écritures de
 * grand livre sur `user_wallet:<id>:**FCFA**` : deux comptes pour un seul
 * argent, dont un que plus aucun contrôle ne réconcilie.
 *
 * L'invariant 2 dit que le grand livre fait foi et que le solde en est une
 * projection. Une projection qui ne porte pas le même nom de compte que sa
 * source n'est pas une projection.
 *
 * Les deux modules partagent désormais `utils/currency.normalizeAccountCurrency`.
 * **Ne pas réintroduire de normalisation locale ici** : c'est exactement ce qui
 * a produit le défaut.
 */
function normalizeCurrency(currency) {
  return normalizeAccountCurrency(currency);
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
    // Doit rester aligné sur `ENTRY_TYPES` de models/LedgerEntry.js : les deux
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

    const found = await model.find(filtreRelectureDedup(keys));

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
 * ============================================================================
 * `$type: "string"` N'EST PAS DÉCORATIF — SANS LUI, C'EST UN BALAYAGE COMPLET
 * DE COLLECTION SUR LE CHEMIN DE L'ARGENT
 * ============================================================================
 *
 * Filtre de la RELECTURE de déduplication : après un refus d'index unique, on
 * relit les clés du lot pour distinguer « ce mouvement était déjà enregistré »
 * de « le lot précédent s'est interrompu au milieu ».
 *
 * `dedupKey_unique_partial` est un index PARTIEL, de condition
 * `{ dedupKey: { $type: "string" } }` (voir `scripts/ensure-ledger-indexes.js`).
 * MongoDB n'accepte d'utiliser un index partiel que si le prédicat PROUVE que
 * les documents cherchés satisfont sa condition — et une égalité sur une chaîne
 * littérale ne le prouve pas : le planificateur ne déduit pas « c'est une
 * chaîne » de « c'est "abc" ».
 *
 * Sans la clause `$type`, l'index existe, il est unique, il protège bien
 * l'ÉCRITURE — mais la RELECTURE balaye toute la collection.
 *
 * Mesuré le 2026-08-28 sur le banc de charge, 240 000 écritures :
 *
 *     sans `$type`  →  COLLSCAN, 240 000 documents examinés
 *     avec `$type`  →  dedupKey_unique_partial, 0 document examiné
 *
 * Sous la charge de `test-concurrency/`, ce balayage prenait **11 s en moyenne,
 * 16 s au pire**, 285 fois — sur un chemin qui ne s'exécute qu'au REJEU, donc
 * précisément quand le système est déjà en train de se rattraper. La suite
 * entière est passée de 35,7 s à 8,5 s une fois la clause posée.
 *
 * ⚠️ La clause ne change RIEN au résultat : `keys` ne contient que des chaînes,
 * donc tout document qui satisfaisait le `$in` satisfait déjà `$type: "string"`.
 * Elle ne restreint pas la recherche, elle AUTORISE le planificateur.
 *
 * ⚠️ EXPORTÉE, et ce n'est pas un détail de confort. Le garde-fou
 * (`test-concurrency/ledgerDedupPlan.concurrency.test.js`) demande à MongoDB le
 * plan d'exécution de CE filtre-ci. Une première version du test recopiait le
 * filtre : retirer `$type` du service laissait alors le test au vert — il ne
 * vérifiait plus que lui-même. Le test doit interroger le filtre RÉEL.
 */
function filtreRelectureDedup(keys) {
  return { dedupKey: { $in: keys, $type: "string" } };
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


/**
 * ============================================================================
 * PAIEMENTS INTERNES — L'ÉCRITURE COMPTABLE QUI MANQUAIT
 * ============================================================================
 *
 * ── Le défaut ────────────────────────────────────────────────────────────────
 * `controllers/internalPaymentsController.js` déplaçait des portefeuilles par
 * `TxWalletBalance.debit` et `.credit` **sans écrire une seule ligne au grand
 * livre**. Le fichier ne contenait aucune occurrence de « ledger ».
 *
 * Ce chemin n'est pas marginal : c'est celui où aboutit `POST /api/v1/pay` du
 * backend principal, via `transactionsService.createInternalPayment` →
 * `POST /api/v1/internal-payments`. De l'argent bougeait donc réellement, sans
 * contrepartie comptable.
 *
 * Deux invariants tombaient d'un coup :
 *   · **2** — le grand livre fait foi, le solde n'en est qu'une projection. Une
 *     projection qui bouge sans que sa source bouge n'est plus une projection ;
 *   · **4** — toute écriture financière est auditable. Il n'y avait rien à
 *     auditer.
 *
 * ── Pourquoi une primitive ici, et pas des appels dans le contrôleur ────────
 * Parce qu'un contrôleur n'a pas à connaître le nommage des comptes.
 * `userWalletAccountId` et `systemClearingAccountId` ne sont pas exportés, et
 * c'est délibéré : le jour où la nomenclature change, elle doit changer à un
 * seul endroit. Le contrôleur dit *quel argent a bougé* ; ce module décide
 * *comment il se book*.
 *
 * ── La forme des écritures ──────────────────────────────────────────────────
 * Chaque côté passe par **SYSTEM_CLEARING**, comme le font déjà
 * `captureSenderReserve` et `creditReceiverFunds`. Un virement interne produit
 * donc deux paires équilibrées plutôt qu'une seule ligne d'un portefeuille à
 * l'autre. Ce n'est pas un détour : un débit sans crédit correspondant se
 * constate alors comme un **solde de compensation non nul**, c'est-à-dire un
 * état observable, plutôt que comme un trou invisible.
 *
 * ── Idempotence ─────────────────────────────────────────────────────────────
 * `dedupScope` distinct par côté : un rejeu de la requête ne peut pas doubler
 * l'écriture, l'index unique partiel `dedupKey_unique_partial` la refuse. C'est
 * l'invariant 3, et il s'appuie sur un index que seul `npm run indexes:ledger`
 * pose — voir `BENCHMARKS.md` §8.2.
 *
 * ⚠️ À APPELER DANS LA MÊME SESSION que les mouvements de portefeuille. Hors
 * transaction, un échec entre les deux laisserait précisément l'incohérence que
 * cette fonction existe pour empêcher.
 */
async function postInternalPaymentEntries({
  transaction,
  debit = null,
  credit = null,
  session = null,
}) {
  assertTransactionLike(transaction);

  if (!debit && !credit) {
    throw new Error(
      "postInternalPaymentEntries : ni débit ni crédit. Un mouvement d'argent " +
        "sans côté n'existe pas — appeler cette fonction pour rien masquerait " +
        "un chemin qui ne book rien."
    );
  }

  if (debit) {
    const cur = normalizeCurrency(debit.currency);
    const amt = normalizePositiveAmount(debit.amount, cur);
    const from = normalizeObjectIdLike(debit.userId, "debit.userId");

    await postDoubleEntry({
      transactionId: transaction._id,
      reference: transaction.reference,
      entryType: "USER_DEBIT",
      context: "internalPayment.debit",
      dedupScope: "internalPayment.debit",
      legs: transferLegs({
        from: {
          accountType: "USER_WALLET",
          accountId: userWalletAccountId(from, cur),
          userId: from,
        },
        to: {
          accountType: "SYSTEM_CLEARING",
          accountId: systemClearingAccountId(cur),
          userId: null,
        },
        amount: amt,
        currency: cur,
      }),
      metadata: { stage: "internal-payment", mode: debit.mode || null },
      session,
    });
  }

  if (credit) {
    const cur = normalizeCurrency(credit.currency);
    const amt = normalizePositiveAmount(credit.amount, cur);
    const to = normalizeObjectIdLike(credit.userId, "credit.userId");

    await postDoubleEntry({
      transactionId: transaction._id,
      reference: transaction.reference,
      entryType: "USER_CREDIT",
      context: "internalPayment.credit",
      dedupScope: "internalPayment.credit",
      legs: transferLegs({
        from: {
          accountType: "SYSTEM_CLEARING",
          accountId: systemClearingAccountId(cur),
          userId: null,
        },
        to: {
          accountType: "USER_WALLET",
          accountId: userWalletAccountId(to, cur),
          userId: to,
        },
        amount: amt,
        currency: cur,
      }),
      metadata: { stage: "internal-payment", mode: credit.mode || null },
      session,
    });
  }
}

/**
 * ============================================================================
 * CAGNOTTES — LES TROIS ÉCRITURES COMPTABLES QUI MANQUAIENT
 * ============================================================================
 *
 * ── Le défaut ────────────────────────────────────────────────────────────────
 * TX Core exposait TROIS points de terminaison de règlement de cagnotte, tous
 * montés et annoncés au démarrage (`src/server.js`), tous déplaçant réellement
 * de l'argent, et **aucun n'écrivait une seule ligne au grand livre** :
 *
 *   POST /api/v1/cagnotte/participation/settle
 *        débite `tx_wallet_balances` du payeur, crédite la trésorerie cagnotte
 *   POST /api/v1/cagnotte/vault-withdrawals/settle
 *        crédite `tx_wallet_balances` du bénéficiaire
 *   POST /api/v1/cagnotte/closure-fees/settle
 *        crédite la trésorerie cagnotte
 *
 * Chacun écrivait un document de règlement en `status: "confirmed"` — donc une
 * trace, mais une trace qui n'entre dans aucune balance et que la réconciliation
 * portefeuille ↔ grand livre ne peut pas rapprocher. Les invariants 2 (le grand
 * livre fait foi) et 4 (toute écriture financière est auditable) tombaient
 * ensemble, exactement comme sur `internalPaymentsController.js` avant le
 * 2026-09-03.
 *
 * ⚠️ Ces trois chemins échappaient AUSSI au filet de
 * `test/noLedgerlessMoneyPath.test.js`, qui cherchait
 * `TxWalletBalance.debit|credit(` — or ils écrivaient par
 * `findOneAndUpdate({ $inc })` et `TxSystemBalance.credit()`. Le garde-fou a été
 * élargi le 2026-09-09 : ce n'est pas un détail de test, c'est la raison pour
 * laquelle le défaut a survécu au correctif du chemin voisin.
 *
 * ── La forme des écritures ──────────────────────────────────────────────────
 * Un coffre de cagnotte vit dans le BACKEND PRINCIPAL, pas ici. Vu de TX Core,
 * l'argent d'une participation quitte un portefeuille et n'atterrit sur aucun
 * compte connu — il revient au retrait. C'est du transit, et il passe par
 * `system_clearing:CAGNOTTE_VAULT:<devise>` (voir `doubleEntry.js` pour la
 * raison du compte séparé).
 *
 *   participation   DEBIT  user_wallet:<payeur>     montant payeur
 *                   CREDIT clearing cagnotte        montant payeur
 *                   DEBIT  clearing cagnotte        frais            ┐ si frais
 *                   CREDIT treasury CAGNOTTE_FEES   frais            ┘
 *
 *   retrait coffre  DEBIT  clearing cagnotte        montant crédité
 *                   CREDIT user_wallet:<bénéf.>     montant crédité
 *
 *   frais clôture   DEBIT  clearing cagnotte        frais
 *                   CREDIT treasury CAGNOTTE_FEES   frais
 *
 * Chaque lot est équilibré SEUL et PAR DEVISE. Le lot « frais » de la
 * participation est séparé du lot « débit » précisément parce que les deux
 * peuvent porter des devises différentes : le payeur paie en XOF, la trésorerie
 * encaisse en CAD. Les fondre en un seul lot rendrait l'équilibre par devise
 * impossible à satisfaire — et l'écart entre les deux devises sur le compte de
 * compensation EST la position de change, qui devient ainsi mesurable.
 *
 * ── Idempotence ─────────────────────────────────────────────────────────────
 * `transactionId` est l'identifiant du document de règlement, et cet identifiant
 * est DÉRIVÉ DE LA RÉFÉRENCE (`settlementObjectIdFromReference`). Deux
 * conséquences voulues :
 *   · le règlement lui-même se rejoue sans doubler — la seconde insertion entre
 *     en collision sur `_id`, en plus des index uniques sur `reference` et
 *     `{userId, idempotencyKey}` ;
 *   · `dedupKey` (`transactionId|scope|legIndex`) est STABLE d'une tentative à
 *     l'autre, donc l'index unique partiel du grand livre refuse le doublon même
 *     lorsque la transaction MongoDB n'est pas disponible.
 *
 * Sans dérivation, un rejeu produirait un `_id` neuf, donc un `dedupKey` neuf,
 * donc des écritures en double : l'idempotence ne tiendrait plus que par la
 * transaction. On ne fait pas reposer un invariant financier sur la disponibilité
 * d'un jeu de réplicas.
 *
 * ⚠️ À APPELER DANS LA MÊME SESSION que les mouvements de portefeuille.
 */

/**
 * Identifiant de document DÉTERMINISTE, dérivé de la référence du règlement.
 *
 * 96 bits de SHA-256 (la largeur d'un ObjectId). Le préfixe de portée évite
 * qu'une même référence produise le même identifiant sur deux familles de
 * règlement différentes.
 *
 * ⚠️ LÈVE sur une référence absente (règle B.2). Un repli sur un identifiant
 * aléatoire rendrait l'opération non idempotente sans qu'aucune erreur ne le
 * signale — c'est-à-dire exactement le défaut qu'on ferme ici.
 */
function settlementObjectIdFromReference(reference, scope) {
  const ref = String(reference || "").trim();
  const sc = String(scope || "").trim();

  if (!ref) {
    throw new Error(
      "settlementObjectIdFromReference : référence absente — un règlement sans " +
        "référence ne peut pas être idempotent."
    );
  }

  if (!sc) {
    throw new Error("settlementObjectIdFromReference : portée absente.");
  }

  const hex = crypto
    .createHash("sha256")
    .update(`${sc}|${ref}`)
    .digest("hex")
    .slice(0, 24);

  return new mongoose.Types.ObjectId(hex);
}

/** Trésorerie cagnotte, résolue et validée en un seul endroit. */
function resolveCagnotteTreasury({ treasuryUserId, treasurySystemType }) {
  const systemType = normalizeTreasurySystemType(
    treasurySystemType || "CAGNOTTE_FEES_TREASURY"
  );

  if (systemType !== "CAGNOTTE_FEES_TREASURY") {
    throw new Error(
      `Trésorerie de cagnotte attendue, reçu ${systemType} — une écriture de ` +
        "cagnotte ne se pose pas sur une autre trésorerie."
    );
  }

  return {
    treasuryUserId: treasuryUserId
      ? normalizeObjectIdLike(treasuryUserId, "treasuryUserId")
      : resolveTreasuryFromSystemType(systemType),
    treasurySystemType: systemType,
  };
}

/**
 * Lot « frais de cagnotte » : compensation cagnotte → trésorerie cagnotte.
 * Partagé par la participation et la clôture, qui posent la MÊME écriture.
 */
async function postCagnotteFeeLegs({
  settlementId,
  reference,
  treasuryUserId,
  treasurySystemType,
  amount,
  currency,
  metadata = null,
  session = null,
  scope,
}) {
  const cur = normalizeCurrency(currency);
  const amt = normalizePositiveAmount(amount, cur);
  const treasury = resolveCagnotteTreasury({ treasuryUserId, treasurySystemType });

  return postDoubleEntry({
    transactionId: settlementId,
    reference: reference || null,
    entryType: "FEE_REVENUE",
    context: scope,
    dedupScope: scope,
    legs: transferLegs({
      from: {
        accountType: "SYSTEM_CLEARING",
        accountId: cagnotteVaultClearingAccountId(cur),
        userId: null,
      },
      to: {
        accountType: "TREASURY",
        accountId: treasuryAccountId({
          treasuryUserId: treasury.treasuryUserId,
          treasurySystemType: treasury.treasurySystemType,
          currency: cur,
        }),
        userId: treasury.treasuryUserId,
      },
      amount: amt,
      currency: cur,
    }),
    metadata: {
      ...(metadata && typeof metadata === "object" ? metadata : {}),
      treasurySystemType: treasury.treasurySystemType,
    },
    session,
  });
}

/**
 * Participation à une cagnotte : le payeur est débité, la trésorerie encaisse
 * ses frais, le reste part en compensation cagnotte (le coffre).
 */
async function postCagnotteParticipationEntries({
  settlementId,
  reference,
  payer,
  feeCredit = null,
  metadata = null,
  session = null,
}) {
  if (!settlementId) {
    throw new Error("postCagnotteParticipationEntries : settlementId requis.");
  }

  if (!payer) {
    throw new Error(
      "postCagnotteParticipationEntries : aucun payeur. Une participation sans " +
        "débit n'existe pas — appeler cette fonction pour rien masquerait un " +
        "chemin qui ne book rien."
    );
  }

  const cur = normalizeCurrency(payer.currency);
  const amt = normalizePositiveAmount(payer.amount, cur);
  const payerId = normalizeObjectIdLike(payer.userId, "payer.userId");

  await postDoubleEntry({
    transactionId: settlementId,
    reference: reference || null,
    entryType: "USER_DEBIT",
    context: "cagnotte.participation.debit",
    dedupScope: "cagnotte.participation.debit",
    legs: transferLegs({
      from: {
        accountType: "USER_WALLET",
        accountId: userWalletAccountId(payerId, cur),
        userId: payerId,
      },
      to: {
        accountType: "SYSTEM_CLEARING",
        accountId: cagnotteVaultClearingAccountId(cur),
        userId: null,
      },
      amount: amt,
      currency: cur,
    }),
    metadata: {
      ...(metadata && typeof metadata === "object" ? metadata : {}),
      stage: "cagnotte-participation",
    },
    session,
  });

  /**
   * Frais facultatifs : ils le sont réellement. Le créateur qui participe à sa
   * propre cagnotte n'en paie pas, et le backend envoie alors `amount: 0`.
   * Un lot à zéro serait refusé par `checkBalanced` — on n'en pose pas.
   */
  if (feeCredit && Number(feeCredit.amount) > 0) {
    await postCagnotteFeeLegs({
      settlementId,
      reference,
      treasuryUserId: feeCredit.treasuryUserId,
      treasurySystemType: feeCredit.treasurySystemType,
      amount: feeCredit.amount,
      currency: feeCredit.currency,
      metadata: {
        ...(metadata && typeof metadata === "object" ? metadata : {}),
        stage: "cagnotte-participation-fee",
      },
      session,
      scope: "cagnotte.participation.fee",
    });
  }
}

/**
 * ============================================================================
 * PARTICIPATION PAR LIEN PUBLIC — LE PAYEUR N'A PAS DE PORTEFEUILLE
 * ============================================================================
 *
 * `postCagnotteParticipationEntries` ci-dessus débite un `USER_WALLET`. C'est
 * juste pour un utilisateur PayNoval qui participe depuis l'application. Ça ne
 * l'est pas pour quelqu'un qui reçoit un lien de cagnotte, n'a pas de compte,
 * et paie par mobile money ou par carte : **il n'y a aucun portefeuille à
 * débiter.** L'argent vient d'un tiers.
 *
 * ── Le défaut que cette fonction ferme (trouvé le 2026-09-09) ───────────────
 *
 * Faute de cette contrepartie, le chemin public ne bookait RIEN. Le rappel
 * prestataire (`cagnotteController.externalPaymentCallback`, backend
 * principal) créditait le coffre par un `$inc: { balance }` nu — aucun appel à
 * TX Core, aucune `LedgerEntry`. Les invariants 2 (le grand livre fait foi) et
 * 4 (toute écriture financière est auditable) tombaient ensemble.
 *
 * C'est EXACTEMENT le défaut corrigé le 2026-09-09 sur le chemin authentifié.
 * Le chemin externe vit 2 400 lignes plus bas dans le même contrôleur et avait
 * été manqué. À retenir : deux chemins qui font la même chose métier doivent
 * appeler la même primitive comptable, sinon l'un des deux dérive.
 *
 * ── Les écritures ───────────────────────────────────────────────────────────
 *
 *   participation   DEBIT  clearing PROVIDER_INBOUND:<RAIL>   montant encaissé
 *   par lien        CREDIT clearing CAGNOTTE_VAULT            montant encaissé
 *                   DEBIT  clearing CAGNOTTE_VAULT   frais            ┐ si frais
 *                   CREDIT treasury CAGNOTTE_FEES    frais            ┘
 *
 * La jambe de retour ne change pas : le retrait du coffre
 * (`postCagnotteVaultWithdrawalEntries`) vide la compensation cagnotte vers le
 * portefeuille du bénéficiaire, qu'il ait été alimenté par un utilisateur ou
 * par un inconnu. C'est la propriété qui rend ce découpage correct — le coffre
 * ne sait pas d'où vient l'argent, et n'a pas à le savoir.
 *
 * ⚠️ `rail` EST OBLIGATOIRE et ne prend aucune valeur par défaut. C'est lui qui
 * décide de quel relevé prestataire cette écriture devra être rapprochée ; s'en
 * passer rendrait le rapprochement impossible sans qu'aucune erreur ne le dise.
 *
 * ⚠️ À APPELER DANS LA MÊME SESSION que la mise à jour du règlement, comme les
 * trois autres primitives cagnotte.
 */
async function postCagnotteExternalParticipationEntries({
  settlementId,
  reference,
  rail,
  amount,
  currency,
  feeCredit = null,
  metadata = null,
  session = null,
}) {
  if (!settlementId) {
    throw new Error(
      "postCagnotteExternalParticipationEntries : settlementId requis."
    );
  }

  const cur = normalizeCurrency(currency);
  const amt = normalizePositiveAmount(amount, cur);

  /**
   * `providerInboundClearingAccountId` lève sur un rail absent — on le laisse
   * lever plutôt que de pré-valider ici : une seule autorité sur ce que vaut un
   * identifiant de compte, comme pour la devise.
   */
  const compteEntree = providerInboundClearingAccountId(rail, cur);

  await postDoubleEntry({
    transactionId: settlementId,
    reference: reference || null,
    entryType: "SYSTEM_TRANSFER",
    context: "cagnotte.participation.external.debit",
    dedupScope: "cagnotte.participation.external.debit",
    legs: transferLegs({
      from: {
        accountType: "SYSTEM_CLEARING",
        accountId: compteEntree,
        userId: null,
      },
      to: {
        accountType: "SYSTEM_CLEARING",
        accountId: cagnotteVaultClearingAccountId(cur),
        userId: null,
      },
      amount: amt,
      currency: cur,
    }),
    metadata: {
      ...(metadata && typeof metadata === "object" ? metadata : {}),
      stage: "cagnotte-participation-external",
      rail: String(rail).trim().toUpperCase(),
    },
    session,
  });

  /**
   * Frais : même primitive que la participation interne, même portée distincte.
   * Le lot « frais » est SÉPARÉ du lot « débit » parce que les deux peuvent
   * porter des devises différentes — le participant paie en XOF, la trésorerie
   * encaisse en CAD — et que l'équilibre se vérifie PAR DEVISE.
   */
  if (feeCredit && Number(feeCredit.amount) > 0) {
    await postCagnotteFeeLegs({
      settlementId,
      reference,
      treasuryUserId: feeCredit.treasuryUserId,
      treasurySystemType: feeCredit.treasurySystemType,
      amount: feeCredit.amount,
      currency: feeCredit.currency,
      metadata: {
        ...(metadata && typeof metadata === "object" ? metadata : {}),
        stage: "cagnotte-participation-external-fee",
      },
      session,
      scope: "cagnotte.participation.external.fee",
    });
  }
}

/**
 * Retrait du coffre d'une cagnotte : la compensation cagnotte se vide vers le
 * portefeuille du bénéficiaire. C'est la jambe de retour de la participation.
 */
async function postCagnotteVaultWithdrawalEntries({
  settlementId,
  reference,
  beneficiary,
  metadata = null,
  session = null,
}) {
  if (!settlementId) {
    throw new Error("postCagnotteVaultWithdrawalEntries : settlementId requis.");
  }

  if (!beneficiary) {
    throw new Error(
      "postCagnotteVaultWithdrawalEntries : aucun bénéficiaire. Un retrait sans " +
        "crédit n'existe pas."
    );
  }

  const cur = normalizeCurrency(beneficiary.currency);
  const amt = normalizePositiveAmount(beneficiary.amount, cur);
  const to = normalizeObjectIdLike(beneficiary.userId, "beneficiary.userId");

  await postDoubleEntry({
    transactionId: settlementId,
    reference: reference || null,
    entryType: "USER_CREDIT",
    context: "cagnotte.vaultWithdrawal.credit",
    dedupScope: "cagnotte.vaultWithdrawal.credit",
    legs: transferLegs({
      from: {
        accountType: "SYSTEM_CLEARING",
        accountId: cagnotteVaultClearingAccountId(cur),
        userId: null,
      },
      to: {
        accountType: "USER_WALLET",
        accountId: userWalletAccountId(to, cur),
        userId: to,
      },
      amount: amt,
      currency: cur,
    }),
    metadata: {
      ...(metadata && typeof metadata === "object" ? metadata : {}),
      stage: "cagnotte-vault-withdrawal",
    },
    session,
  });
}

/** Frais de clôture d'une cagnotte : prélevés sur le coffre. */
async function postCagnotteClosureFeeEntries({
  settlementId,
  reference,
  feeCredit,
  metadata = null,
  session = null,
}) {
  if (!settlementId) {
    throw new Error("postCagnotteClosureFeeEntries : settlementId requis.");
  }

  if (!feeCredit || !(Number(feeCredit.amount) > 0)) {
    throw new Error(
      "postCagnotteClosureFeeEntries : montant de frais absent ou nul. Ce point " +
        "de terminaison n'existe que pour encaisser des frais — sans montant, " +
        "il n'a rien à comptabiliser."
    );
  }

  await postCagnotteFeeLegs({
    settlementId,
    reference,
    treasuryUserId: feeCredit.treasuryUserId,
    treasurySystemType: feeCredit.treasurySystemType,
    amount: feeCredit.amount,
    currency: feeCredit.currency,
    metadata: {
      ...(metadata && typeof metadata === "object" ? metadata : {}),
      stage: "cagnotte-closure-fee",
    },
    session,
    scope: "cagnotte.closureFee.credit",
  });
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
  filtreRelectureDedup,
  postInternalPaymentEntries,
  settlementObjectIdFromReference,
  postCagnotteParticipationEntries,
  postCagnotteExternalParticipationEntries,
  postCagnotteVaultWithdrawalEntries,
  postCagnotteClosureFeeEntries,
};