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

/**
 * ⚠️ POSÉE AVANT `loadLedgerService()`, et ce n'est pas un détail de style :
 * `TREASURY_ENV_BY_SYSTEM_TYPE` est figée au chargement du module. Renseignée
 * après, elle ne serait jamais lue et la résolution de trésorerie échouerait
 * dans les tests de cagnotte.
 */
process.env.CAGNOTTE_FEES_TREASURY_USER_ID =
  process.env.CAGNOTTE_FEES_TREASURY_USER_ID || "cccccccccccccccccccccccc";

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

/* -------------------------------------------------------------------------- */
/* CAGNOTTES — les trois chemins qui n'écrivaient rien avant le 2026-09-09     */
/* -------------------------------------------------------------------------- */

/**
 * ============================================================================
 * POURQUOI CES TESTS EXISTENT
 * ============================================================================
 *
 * Les trois points de terminaison de règlement de cagnotte déplaçaient de
 * l'argent sans écrire une seule `LedgerEntry`. Ils ont échappé au correctif du
 * chemin voisin (`internalPaymentsController`) parce qu'ils écrivaient par
 * `findOneAndUpdate({ $inc })` et `TxSystemBalance.credit()` plutôt que par
 * `TxWalletBalance.debit|credit` — la forme que cherchait le garde-fou.
 *
 * Ces tests-ci vérifient que les primitives produisent des lots ÉQUILIBRÉS.
 * `test/cagnotteLedger.test.js` vérifie qu'elles sont réellement APPELÉES, dans
 * la transaction. Les deux sont nécessaires : une primitive correcte que
 * personne n'appelle ne protège de rien.
 */

const CAGNOTTE_TREASURY = "cccccccccccccccccccccccc";
const PAYEUR = "dddddddddddddddddddddddd";
const BENEFICIAIRE = "eeeeeeeeeeeeeeeeeeeeeeee";
const REGLEMENT = "2b2b2b2b2b2b2b2b2b2b2b2b";

const { buildCagnotteCreditLots } = require("../src/services/ledger/cagnotteLegs");

const FEES = { userId: CAGNOTTE_TREASURY, systemType: "CAGNOTTE_FEES_TREASURY" };
const FX_MARGIN = { userId: "abababababababababababab", systemType: "FX_MARGIN_TREASURY" };

test("participation XOF → XOF : un lot de frais, un lot de crédit, chacun équilibré", async () => {
  written.length = 0;

  await ledger.postCagnotteLotEntries({
    settlementId: REGLEMENT,
    reference: "CAGPART-TEST-001",
    lots: buildCagnotteCreditLots({
      origin: { kind: "USER_WALLET", userId: PAYEUR },
      sourceCurrency: "XOF",
      targetCurrency: "XOF",
      gross: 5000,
      fee: 13,
      netSource: 4987,
      netTarget: 4987,
      feesTreasury: FEES,
    }),
  });

  assert.equal(written.length, 2, "frais et crédit sont deux lots distincts");

  for (const [i, lot] of written.entries()) {
    const verdict = checkBalanced(asLegs(lot));
    assert.equal(verdict.ok, true, `lot ${i} déséquilibré : ${verdict.detail}`);
  }

  const credit = written[1].find((d) => d.direction === "CREDIT");

  /**
   * ⚠️ La contrepartie va sur la compensation CAGNOTTE, pas sur la compensation
   * générale : l'encours d'une cagnotte ouverte est légitimement non nul et
   * durable, le mélanger rendrait illisible l'indicateur des fonds bloqués.
   */
  assert.equal(credit.accountId, "system_clearing:CAGNOTTE_VAULT:XOF");
  assert.equal(written[0].find((d) => d.direction === "DEBIT").accountType, "USER_WALLET");
  assert.ok(written[0].find((d) => d.direction === "CREDIT").accountId.includes("CAGNOTTE_FEES_TREASURY"));
});

test("participation CAD → XOF : le coffre ne reçoit QUE des XOF, la conversion passe par FX_CONVERSION", async () => {
  written.length = 0;

  await ledger.postCagnotteLotEntries({
    settlementId: REGLEMENT,
    reference: "CAGPART-TEST-002",
    lots: buildCagnotteCreditLots({
      origin: { kind: "USER_WALLET", userId: PAYEUR },
      sourceCurrency: "CAD",
      targetCurrency: "XOF",
      gross: 100,
      fee: 0.25,
      netSource: 99.75,
      netTarget: 43703,
      fxRevenue: 217,
      feesTreasury: FEES,
      fxMarginTreasury: FX_MARGIN,
    }),
  });

  assert.equal(written.length, 3, "frais (CAD), sortie source (CAD), entrée cible (XOF)");

  for (const [i, lot] of written.entries()) {
    const verdict = checkBalanced(asLegs(lot));
    assert.equal(verdict.ok, true, `lot ${i} déséquilibré : ${verdict.detail}`);
  }

  const toutes = written.flat();

  /**
   * ⚠️ R-16 : l'ancienne primitive créditait `CAGNOTTE_VAULT:CAD`. Le retrait,
   * lui, débite `CAGNOTTE_VAULT:XOF` — la conversion n'existait nulle part.
   */
  assert.equal(
    toutes.filter((d) => d.accountId.startsWith("system_clearing:CAGNOTTE_VAULT:") && d.currency !== "XOF").length,
    0,
    "aucune jambe du compte de coffre dans une autre devise que celle de la cagnotte"
  );
  assert.ok(toutes.some((d) => d.accountId === "system_clearing:FX_CONVERSION:CAD" && d.direction === "CREDIT"));
  assert.ok(toutes.some((d) => d.accountId === "system_clearing:FX_CONVERSION:XOF" && d.direction === "DEBIT"));
  assert.ok(toutes.some((d) => d.accountId.includes("FX_MARGIN_TREASURY") && d.entryType === "FX_REVENUE"));
});

test("participation sans frais : AUCUN lot de frais, et pas un lot à zéro", async () => {
  written.length = 0;

  await ledger.postCagnotteLotEntries({
    settlementId: REGLEMENT,
    reference: "CAGPART-TEST-003",
    lots: buildCagnotteCreditLots({
      origin: { kind: "USER_WALLET", userId: PAYEUR },
      sourceCurrency: "XOF",
      targetCurrency: "XOF",
      gross: 5000,
      fee: 0,
      netSource: 5000,
      netTarget: 5000,
    }),
  });

  assert.equal(written.length, 1, "un seul lot : le crédit du coffre");
});

test("retrait de coffre : compensation cagnotte → bénéficiaire", async () => {
  const batch = await expectBalancedPair("retrait", () =>
    ledger.postCagnotteVaultWithdrawalEntries({
      settlementId: REGLEMENT,
      reference: "CAGVLT-TEST-001",
      beneficiary: { userId: BENEFICIAIRE, amount: 4500, currency: "XOF" },
    })
  );

  const debit = batch.find((d) => d.direction === "DEBIT");
  const credit = batch.find((d) => d.direction === "CREDIT");

  /**
   * C'est la jambe de RETOUR de la participation : elle vide la compensation
   * cagnotte que la participation avait remplie. Sans elle, le solde de ce
   * compte ne redescendrait jamais.
   */
  assert.equal(debit.accountId, "system_clearing:CAGNOTTE_VAULT:XOF");
  assert.equal(credit.accountType, "USER_WALLET");
  assert.ok(credit.accountId.includes(BENEFICIAIRE));
});

test("frais de clôture : prélevés sur le coffre, versés à la trésorerie", async () => {
  const batch = await expectBalancedPair("clôture", () =>
    ledger.postCagnotteClosureFeeEntries({
      settlementId: REGLEMENT,
      reference: "CAGCLO-TEST-001",
      feeCredit: {
        treasuryUserId: CAGNOTTE_TREASURY,
        treasurySystemType: "CAGNOTTE_FEES_TREASURY",
        amount: 3.5,
        currency: "CAD",
      },
    })
  );

  assert.equal(
    batch.find((d) => d.direction === "DEBIT").accountId,
    "system_clearing:CAGNOTTE_VAULT:CAD"
  );
  assert.equal(batch.find((d) => d.direction === "CREDIT").accountType, "TREASURY");
});

test("une écriture de cagnotte REFUSE une autre trésorerie", async () => {
  /**
   * Sans cette garde, une erreur d'appel enverrait les frais de cagnotte sur
   * FEES_TREASURY : la balance resterait équilibrée — donc aucun contrôle ne
   * verrait rien — et l'analytique de trésorerie serait fausse.
   */
  written.length = 0;

  await assert.rejects(
    () =>
      ledger.postCagnotteClosureFeeEntries({
        settlementId: REGLEMENT,
        reference: "CAGCLO-TEST-002",
        feeCredit: {
          treasuryUserId: "ffffffffffffffffffffffff",
          treasurySystemType: "FEES_TREASURY",
          amount: 3.5,
          currency: "CAD",
        },
      }),
    /Trésorerie de cagnotte attendue/
  );

  assert.equal(written.length, 0, "AUCUNE écriture ne doit avoir été tentée");
});

test("les primitives de cagnotte échouent en FERMETURE, jamais par défaut", async () => {
  written.length = 0;

  // Aucun lot : refus, pas un mouvement de cagnotte sans écriture.
  await assert.rejects(
    () =>
      ledger.postCagnotteLotEntries({
        settlementId: REGLEMENT,
        reference: "CAGPART-TEST-004",
        lots: [],
      }),
    /aucun lot/
  );

  // Identifiant de règlement absent : refus.
  await assert.rejects(
    () =>
      ledger.postCagnotteVaultWithdrawalEntries({
        settlementId: null,
        reference: "CAGVLT-TEST-002",
        beneficiary: { userId: BENEFICIAIRE, amount: 100, currency: "XOF" },
      }),
    /settlementId requis/
  );

  // Frais de clôture à zéro : ce point de terminaison n'existe QUE pour des
  // frais. Zéro n'est pas un cas limite, c'est un appel qui n'a rien à faire.
  await assert.rejects(
    () =>
      ledger.postCagnotteClosureFeeEntries({
        settlementId: REGLEMENT,
        reference: "CAGCLO-TEST-003",
        feeCredit: {
          treasuryUserId: CAGNOTTE_TREASURY,
          treasurySystemType: "CAGNOTTE_FEES_TREASURY",
          amount: 0,
          currency: "CAD",
        },
      }),
    /absent ou nul/
  );

  assert.equal(written.length, 0, "aucun refus ne doit avoir laissé d'écriture");
});

/* -------------------------------------------------------------------------- */
/* Identifiant de règlement déterministe                                      */
/* -------------------------------------------------------------------------- */

test("l'identifiant de règlement est dérivé de la référence, donc rejouable", () => {
  const a = ledger.settlementObjectIdFromReference("CAGPART-XYZ", "cagnotte.participation");
  const b = ledger.settlementObjectIdFromReference("CAGPART-XYZ", "cagnotte.participation");

  assert.equal(String(a), String(b), "deux tentatives du même règlement, un seul identifiant");

  /**
   * ⚠️ C'EST CE QUI REND LE GRAND LIVRE IDEMPOTENT SANS TRANSACTION.
   *
   * `dedupKey` vaut `transactionId|scope|legIndex`. Avec un identifiant tiré au
   * hasard à chaque tentative, un rejeu produirait une clé neuve : l'index
   * unique partiel ne verrait pas le doublon, et l'idempotence ne tiendrait plus
   * que par la transaction MongoDB. On ne fait pas reposer un invariant
   * financier sur la disponibilité d'un jeu de réplicas.
   */
  const autrePortee = ledger.settlementObjectIdFromReference(
    "CAGPART-XYZ",
    "cagnotte.closureFee"
  );
  assert.notEqual(
    String(a),
    String(autrePortee),
    "deux familles de règlement ne doivent pas se heurter sur une même référence"
  );

  assert.throws(
    () => ledger.settlementObjectIdFromReference("", "cagnotte.participation"),
    /référence absente/,
    "une référence absente doit LEVER — un identifiant aléatoire rendrait " +
      "l'opération non idempotente sans qu'aucune erreur ne le signale"
  );
});
