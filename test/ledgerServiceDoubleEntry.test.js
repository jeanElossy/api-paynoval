"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { checkBalanced } = require("../src/services/ledger/doubleEntry");

/**
 * ============================================================================
 * LES PRIMITIVES RÉELLES PRODUISENT-ELLES DES PAIRES ÉQUILIBRÉES ?
 * ============================================================================
 *
 * `doubleEntry.test.js` vérifie l'INVARIANT. Ce fichier-ci vérifie que les huit
 * primitives de `ledgerService.js` le RESPECTENT — ce qui est une question
 * différente, et la seule qui compte vraiment : un invariant parfait qu'aucun
 * appelant n'honore ne protège de rien.
 *
 * POURQUOI L'INJECTION PAR `require.cache` ET PAS UNE VRAIE BASE
 * -------------------------------------------------------------
 * `ledgerService` résout ses modèles paresseusement via `getTxConn()`. On place
 * donc un faux `config/db` dans le cache de modules AVANT de le charger : la
 * connexion rendue expose `models.LedgerEntry` et `models.TxWalletBalance`, que
 * les factories de modèles renvoient telles quelles.
 *
 * Aucune connexion Mongo n'est ouverte. C'est ce qui permet à ce test de tourner
 * en quelques millisecondes avec le reste de la suite — la propriété qui fait
 * que ces tests sont réellement exécutés à chaque poussée.
 */

/** Écritures capturées par le faux modèle de grand livre. */
const written = [];

function makeFakeWallet() {
  const noop = async () => ({ ok: true });
  return {
    reserve: noop,
    captureReserve: noop,
    releaseReserve: noop,
    credit: noop,
    debit: noop,
  };
}

/**
 * Trésorerie système. `chargeCancellationFee` et les revenus passent par elle
 * AVANT d'écrire au grand livre — sans ce double, le service échoue avant
 * d'atteindre la partie qu'on veut vérifier.
 */
function makeFakeSystemBalance() {
  return {
    async credit() {
      return { ok: true };
    },
    async debit() {
      return { ok: true };
    },
    async findOne() {
      return { _id: "sys", balances: {}, defaultCurrency: "CAD" };
    },
    async create(docs) {
      return Array.isArray(docs) ? docs : [docs];
    },
    async findOneAndUpdate() {
      return { ok: true };
    },
  };
}

function makeFakeConnection() {
  const LedgerEntry = {
    /**
     * `insertMany` et non `create` : `postDoubleEntry` envoie le lot en UNE
     * commande ordonnée. `Model.create(tableau)` lançait N sauvegardes
     * parallèles sous mongoose 7, donc pas de lot du tout.
     */
    async insertMany(docs) {
      const list = Array.isArray(docs) ? docs : [docs];
      written.push(list);
      return list;
    },
  };

  const models = {
    LedgerEntry,
    TxWalletBalance: makeFakeWallet(),
    TxSystemBalance: makeFakeSystemBalance(),
  };

  return {
    models,
    /**
     * `getClient` est interrogé par `utils/sharedSession.js` pour savoir si une
     * vraie transaction est possible. Absent, il vaut « mode dégradé » — ce qui
     * est le régime le plus contraignant, donc le bon défaut pour un test.
     */
    getClient: () => ({ id: "client-de-test" }),
    /**
     * Rendre TOUJOURS le même modèle serait un piège : le service demanderait
     * `TxSystemBalance` et recevrait le grand livre, qui n'a pas `findOne`.
     * L'erreur porterait sur la trésorerie alors que le défaut serait ici.
     */
    model: (name) => models[name] || LedgerEntry,
  };
}

function loadLedgerService() {
  const dbPath = require.resolve("../src/config/db");
  const svcPath = require.resolve("../src/services/ledgerService");

  const conn = makeFakeConnection();

  // Faux `config/db` posé dans le cache avant le chargement du service.
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { getTxConn: () => conn, getUsersConn: () => conn },
  };

  delete require.cache[svcPath];
  delete require.cache[require.resolve("../src/models/LedgerEntry")];
  delete require.cache[require.resolve("../src/models/TxWalletBalance")];
  delete require.cache[require.resolve("../src/models/TxSystemBalance")];

  return require("../src/services/ledgerService");
}

/** Les trésoreries sont résolues depuis l'environnement. */
process.env.FEES_TREASURY_USER_ID =
  process.env.FEES_TREASURY_USER_ID || "ffffffffffffffffffffffff";

const ledger = loadLedgerService();

const TX = {
  _id: "1a1a1a1a1a1a1a1a1a1a1a1a",
  reference: "PNV-TEST-001",
  flow: "PAYNOVAL_INTERNAL_TRANSFER",
};

const SENDER = "aaaaaaaaaaaaaaaaaaaaaaaa";
const RECEIVER = "bbbbbbbbbbbbbbbbbbbbbbbb";

function lastBatch() {
  return written[written.length - 1] || [];
}

/**
 * Convertit les documents écrits (montants en `Decimal128`) vers la forme
 * attendue par `checkBalanced`.
 */
function asLegs(batch) {
  return batch.map((d) => ({
    accountType: d.accountType,
    accountId: d.accountId,
    direction: d.direction,
    currency: d.currency,
    amount: Number(d.amount?.toString?.() ?? d.amount),
  }));
}

async function expectBalancedPair(label, fn) {
  written.length = 0;
  await fn();

  const batch = lastBatch();

  assert.ok(batch.length >= 2, `${label} : au moins deux jambes attendues`);

  const verdict = checkBalanced(asLegs(batch));
  assert.equal(verdict.ok, true, `${label} : ${verdict.detail}`);

  for (const doc of batch) {
    assert.equal(
      doc.metadata?.ledgerVersion,
      2,
      `${label} : l'écriture doit porter ledgerVersion=2, sinon la balance de vérification l'ignore`
    );
  }

  return batch;
}

/* -------------------------------------------------------------------------- */

test("reserveSenderFunds : user_wallet → system_reserve", async () => {
  const batch = await expectBalancedPair("reserve", () =>
    ledger.reserveSenderFunds({
      transaction: TX,
      senderId: SENDER,
      amount: 10000,
      currency: "XOF",
    })
  );

  const debit = batch.find((d) => d.direction === "DEBIT");
  const credit = batch.find((d) => d.direction === "CREDIT");

  assert.equal(debit.accountType, "USER_WALLET");
  assert.equal(credit.accountType, "SYSTEM_RESERVE");
  assert.ok(credit.accountId.includes(SENDER), "la réserve doit porter l'utilisateur");
});

test("captureSenderReserve : system_reserve → system_clearing", async () => {
  const batch = await expectBalancedPair("capture", () =>
    ledger.captureSenderReserve({
      transaction: TX,
      senderId: SENDER,
      amount: 10000,
      currency: "XOF",
    })
  );

  assert.equal(batch.find((d) => d.direction === "DEBIT").accountType, "SYSTEM_RESERVE");
  assert.equal(batch.find((d) => d.direction === "CREDIT").accountType, "SYSTEM_CLEARING");
});

test("releaseSenderReserve : exacte symétrie de la réservation", async () => {
  const batch = await expectBalancedPair("release", () =>
    ledger.releaseSenderReserve({
      transaction: TX,
      senderId: SENDER,
      amount: 10000,
      currency: "XOF",
    })
  );

  assert.equal(batch.find((d) => d.direction === "DEBIT").accountType, "SYSTEM_RESERVE");
  assert.equal(batch.find((d) => d.direction === "CREDIT").accountType, "USER_WALLET");
});

test("creditReceiverFunds : system_clearing → user_wallet", async () => {
  const batch = await expectBalancedPair("credit", () =>
    ledger.creditReceiverFunds({
      transaction: TX,
      receiverId: RECEIVER,
      amount: 9800,
      currency: "XOF",
    })
  );

  const credit = batch.find((d) => d.direction === "CREDIT");

  assert.equal(batch.find((d) => d.direction === "DEBIT").accountType, "SYSTEM_CLEARING");
  assert.equal(credit.accountType, "USER_WALLET");
  assert.ok(credit.accountId.includes(RECEIVER));
});

test("debitReceiverFunds : reprise vers la compensation", async () => {
  const batch = await expectBalancedPair("reversal", () =>
    ledger.debitReceiverFunds({
      transaction: TX,
      receiverId: RECEIVER,
      amount: 9800,
      currency: "XOF",
    })
  );

  assert.equal(batch.find((d) => d.direction === "DEBIT").accountType, "USER_WALLET");
  assert.equal(batch.find((d) => d.direction === "CREDIT").accountType, "SYSTEM_CLEARING");
});

test("refundSenderFunds : system_clearing → expéditeur", async () => {
  const batch = await expectBalancedPair("refund", () =>
    ledger.refundSenderFunds({
      transaction: TX,
      senderId: SENDER,
      amount: 10000,
      currency: "XOF",
    })
  );

  const credit = batch.find((d) => d.direction === "CREDIT");

  assert.equal(batch.find((d) => d.direction === "DEBIT").accountType, "SYSTEM_CLEARING");
  assert.ok(credit.accountId.includes(SENDER));
});

test("le cycle complet d'un virement boucle à zéro", async () => {
  /**
   * LE test de cette phase. On rejoue les quatre étapes d'un virement de
   * 10 000 XOF avec 200 de frais, et on vérifie que le TOTAL des écritures
   * s'annule — ce qui est exactement ce que fera la balance de vérification en
   * production.
   */
  written.length = 0;

  await ledger.reserveSenderFunds({ transaction: TX, senderId: SENDER, amount: 10000, currency: "XOF" });
  await ledger.captureSenderReserve({ transaction: TX, senderId: SENDER, amount: 10000, currency: "XOF" });
  await ledger.creditReceiverFunds({ transaction: TX, receiverId: RECEIVER, amount: 9800, currency: "XOF" });
  // Les frais : compensation → trésorerie. C'est ce que fait la primitive
  // interne de revenus ; on l'exprime ici par l'API publique.
  await ledger.postDoubleEntry({
    transactionId: TX._id,
    reference: TX.reference,
    entryType: "FEE_REVENUE",
    legs: [
      {
        accountType: "SYSTEM_CLEARING",
        accountId: "system_clearing:XOF",
        direction: "DEBIT",
        amount: 200,
        currency: "XOF",
      },
      {
        accountType: "TREASURY",
        accountId: "treasury:FEES_TREASURY:T:XOF",
        direction: "CREDIT",
        amount: 200,
        currency: "XOF",
      },
    ],
  });

  const all = asLegs(written.flat());

  const verdict = checkBalanced(all);
  assert.equal(verdict.ok, true, verdict.detail);
  assert.equal(verdict.byCurrency.XOF.debit, 30000);
  assert.equal(verdict.byCurrency.XOF.credit, 30000);

  /**
   * Et le compte de COMPENSATION revient exactement à zéro : tout ce qui y est
   * entré (10 000 à la capture) en est ressorti (9 800 + 200). Un solde non nul
   * signifierait que des fonds sont restés en transit.
   */
  const clearing = all.filter((l) => l.accountId === "system_clearing:XOF");
  const net = clearing.reduce(
    (n, l) => n + (l.direction === "CREDIT" ? l.amount : -l.amount),
    0
  );
  assert.equal(net, 0, "la compensation doit revenir à zéro");
});

test("un revenu de trésorerie EN AUTRE DEVISE reste équilibré dans SA devise", async () => {
  /**
   * Le cas multidevises, qui est la vraie difficulté. La contrepartie est posée
   * sur la compensation dans la devise de la TRÉSORERIE — jamais dans celle de
   * la source. Poser la contrepartie en XOF ferait un jeu impossible à
   * équilibrer.
   */
  written.length = 0;

  await ledger.chargeCancellationFee({
    transaction: TX,
    senderId: SENDER,
    senderCurrency: "XOF",
    feeSourceAmount: 500,
    treasurySystemType: "FEES_TREASURY",
    treasuryFeeAmount: 1.25,
    treasuryFeeCurrency: "CAD",
    conversionRateToTreasury: 0.0025,
  });

  const legs = asLegs(written.flat());

  // L'ensemble est équilibré DEVISE PAR DEVISE, alors que les deux montants
  // n'ont aucun rapport arithmétique entre eux.
  const verdict = checkBalanced(legs);
  assert.equal(verdict.ok, true, verdict.detail);

  assert.equal(verdict.byCurrency.XOF.debit, 500);
  assert.equal(verdict.byCurrency.XOF.credit, 500);
  assert.equal(verdict.byCurrency.CAD.debit, 1.25);
  assert.equal(verdict.byCurrency.CAD.credit, 1.25);

  /**
   * ⚠️ Et voici la POSITION DE CHANGE, enfin visible : la compensation a reçu
   * 500 XOF et versé 1,25 CAD. Ce déséquilibre ENTRE devises n'est pas une
   * erreur — c'est l'exposition au change, qui existait déjà et n'était
   * simplement pas mesurable.
   */
  const clearingXof = legs.filter((l) => l.accountId === "system_clearing:XOF");
  const clearingCad = legs.filter((l) => l.accountId === "system_clearing:CAD");

  assert.equal(clearingXof.length, 1, "une jambe de compensation en XOF");
  assert.equal(clearingCad.length, 1, "une jambe de compensation en CAD");
  assert.equal(clearingXof[0].direction, "CREDIT", "les XOF entrent");
  assert.equal(clearingCad[0].direction, "DEBIT", "les CAD sortent");
});

test("postDoubleEntry REFUSE d'écrire un jeu déséquilibré", async () => {
  /**
   * La garde doit agir AVANT l'écriture : détecter après coup ne servirait à
   * rien, les lignes seraient déjà en base et le grand livre est immuable.
   */
  written.length = 0;

  await assert.rejects(
    () =>
      ledger.postDoubleEntry({
        transactionId: TX._id,
        entryType: "ADJUSTMENT",
        legs: [
          { accountType: "USER_WALLET", accountId: "user_wallet:A:XOF", direction: "DEBIT", amount: 100, currency: "XOF" },
          { accountType: "TREASURY", accountId: "treasury:X:T:XOF", direction: "CREDIT", amount: 90, currency: "XOF" },
        ],
      }),
    (err) => {
      assert.equal(err.code, "LEDGER_UNBALANCED");
      return true;
    }
  );

  assert.equal(written.length, 0, "AUCUNE écriture ne doit avoir été tentée");
});

test("toutes les jambes partent en UN SEUL appel — pas de lot partiel", async () => {
  /**
   * Sans transaction Mongo (mode dégradé), deux `create` séparés laisseraient
   * une écriture orpheline si le processus meurt entre les deux — précisément
   * le déséquilibre que tout ceci existe pour empêcher.
   */
  written.length = 0;

  await ledger.reserveSenderFunds({
    transaction: TX,
    senderId: SENDER,
    amount: 10000,
    currency: "XOF",
  });

  assert.equal(written.length, 1, "un seul appel à create()");
  assert.equal(written[0].length, 2, "portant les deux jambes");
});
