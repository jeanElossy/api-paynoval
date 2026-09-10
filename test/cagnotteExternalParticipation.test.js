"use strict";

/**
 * ============================================================================
 * PARTICIPATION PAR LIEN PUBLIC — LA CONTREPARTIE QUI MANQUAIT
 * ============================================================================
 *
 * ── Le défaut que ces tests empêchent de revenir ────────────────────────────
 *
 * Une cagnotte se partage par lien. Qui reçoit ce lien n'a pas forcément de
 * compte PayNoval : il paie par mobile money ou par carte, depuis l'extérieur.
 *
 * `postCagnotteParticipationEntries` ne sait pas traiter ce cas — elle débite
 * un `USER_WALLET`, et il n'y en a pas. Faute d'une primitive pour la
 * contrepartie externe, le chemin public ne bookait RIEN : le rappel
 * prestataire (`cagnotteController.externalPaymentCallback`, backend principal)
 * créditait le coffre par un `$inc: { balance }` nu, sans aucune `LedgerEntry`.
 *
 * Les invariants 2 (le grand livre fait foi) et 4 (auditabilité) tombaient
 * ensemble — le même défaut que celui corrigé le 2026-09-09 sur le chemin
 * AUTHENTIFIÉ, dont le jumeau externe vit 2 400 lignes plus bas dans le même
 * fichier et avait été manqué.
 *
 * ── Ce que ces tests verrouillent ───────────────────────────────────────────
 *
 *   1. le compte d'entrée prestataire est ventilé PAR RAIL — sans quoi le
 *      rapprochement prestataire par prestataire est impossible ;
 *   2. il est DISTINCT du clearing général — sans quoi le seul indicateur qui
 *      détecte des fonds bloqués en transit acquiert un plancher permanent ;
 *   3. un rail absent LÈVE, il ne prend pas de valeur par défaut (règle B.2) ;
 *   4. le lot s'équilibre, et par devise.
 *
 * Test **pur** : aucune connexion Mongo, aucun serveur. Il n'exerce que des
 * fonctions de calcul d'identifiant et de vérification d'équilibre.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  providerInboundClearingAccountId,
  cagnotteVaultClearingAccountId,
  systemClearingAccountId,
  transferLegs,
  checkBalanced,
  assertBalanced,
} = require("../src/services/ledger/doubleEntry");

/* ────────────────────────────────────────────────────────────────────────── */
/* Le compte d'entrée prestataire                                             */
/* ────────────────────────────────────────────────────────────────────────── */

test("le compte d'entrée est ventilé par rail ET par devise", () => {
  assert.equal(
    providerInboundClearingAccountId("mobilemoney", "XOF"),
    "system_clearing:PROVIDER_INBOUND:MOBILEMONEY:XOF"
  );

  assert.equal(
    providerInboundClearingAccountId("card", "CAD"),
    "system_clearing:PROVIDER_INBOUND:CARD:CAD"
  );

  assert.notEqual(
    providerInboundClearingAccountId("mobilemoney", "XOF"),
    providerInboundClearingAccountId("card", "XOF"),
    "Deux rails ne doivent JAMAIS partager un compte d'entrée : le " +
      "rapprochement se fait relevé par relevé, et un solde global ne se " +
      "rapproche de rien."
  );
});

test("le compte d'entrée est distinct du clearing général et du clearing cagnotte", () => {
  const entree = providerInboundClearingAccountId("mobilemoney", "XOF");

  assert.notEqual(
    entree,
    systemClearingAccountId("XOF"),
    "Le solde du clearing général répond à « des fonds sont-ils bloqués en " +
      "transit ? » et doit revenir à zéro. L'encours d'un prestataire est " +
      "légitimement non nul entre l'encaissement et le règlement : les mélanger " +
      "donnerait au clearing général un plancher permanent et rendrait " +
      "illisible le seul indicateur capable de signaler un virement bloqué."
  );

  assert.notEqual(
    entree,
    cagnotteVaultClearingAccountId("XOF"),
    "L'argent ENTRE par le compte prestataire et SÉJOURNE sur le compte " +
      "cagnotte. Confondre les deux ferait disparaître la jambe d'entrée."
  );
});

test("les alias de devise sont normalisés, comme partout ailleurs", () => {
  /**
   * `FCFA` et `XOF` désignent la même monnaie. Deux identifiants pour un seul
   * argent, c'est « deux comptes pour un seul argent » — le défaut corrigé le
   * 2026-09-03 quand `ledgerService` portait ses propres copies des helpers.
   */
  assert.equal(
    providerInboundClearingAccountId("mobilemoney", "FCFA"),
    providerInboundClearingAccountId("mobilemoney", "XOF")
  );
});

test("un rail absent LÈVE — il ne prend pas de valeur par défaut", () => {
  for (const railVide of ["", "   ", null, undefined]) {
    assert.throws(
      () => providerInboundClearingAccountId(railVide, "XOF"),
      /rail absent/i,
      `Un rail « ${JSON.stringify(railVide)} » doit lever (règle B.2). Un ` +
        "compte `PROVIDER_INBOUND::XOF` ne se rapprocherait d'aucun relevé et " +
        "polluerait le rapprochement de tous les rails à la fois — sans qu'aucune " +
        "erreur ne le signale."
    );
  }
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Le lot d'écritures                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

function lotParticipationExterne({ rail = "mobilemoney", montant = 10000, devise = "XOF" } = {}) {
  return transferLegs({
    from: {
      accountType: "SYSTEM_CLEARING",
      accountId: providerInboundClearingAccountId(rail, devise),
      userId: null,
    },
    to: {
      accountType: "SYSTEM_CLEARING",
      accountId: cagnotteVaultClearingAccountId(devise),
      userId: null,
    },
    amount: montant,
    currency: devise,
  });
}

test("le lot de participation externe s'équilibre", () => {
  const resultat = checkBalanced(lotParticipationExterne());

  assert.equal(resultat.ok, true, resultat.detail || "lot déséquilibré");
  assert.deepEqual(resultat.byCurrency, {
    XOF: { debit: 10000, credit: 10000, delta: 0 },
  });

  assert.doesNotThrow(() => assertBalanced(lotParticipationExterne()));
});

test("l'équilibre se vérifie PAR DEVISE, jamais globalement", () => {
  /**
   * Un participant paie en XOF, la trésorerie encaisse ses frais en CAD. Fondre
   * les deux lots additionnerait des francs CFA et des dollars canadiens.
   * L'écart entre devises sur le compte de compensation EST la position de
   * change — c'est l'information qu'on veut mesurable, pas un défaut à masquer.
   */
  const melange = [
    ...lotParticipationExterne({ devise: "XOF", montant: 10000 }),
    ...lotParticipationExterne({ devise: "CAD", montant: 20 }),
  ];

  const resultat = checkBalanced(melange);

  assert.equal(resultat.ok, true);
  assert.equal(resultat.byCurrency.XOF.delta, 0);
  assert.equal(resultat.byCurrency.CAD.delta, 0);
});

test("un lot amputé de sa contrepartie est REFUSÉ", () => {
  const ampute = [lotParticipationExterne()[0]];

  const resultat = checkBalanced(ampute);

  assert.equal(
    resultat.ok,
    false,
    "Une écriture isolée n'est pas de la partie double — c'est exactement la " +
      "partie simple qu'on remplace."
  );
  assert.equal(resultat.reason, "single-leg");
});

/* ────────────────────────────────────────────────────────────────────────── */
/* La primitive est bien exposée                                              */
/* ────────────────────────────────────────────────────────────────────────── */

test("postCagnotteExternalParticipationEntries est exportée par ledgerService", () => {
  /**
   * `ledgerService` ouvre une connexion Mongo au chargement ? Non — il résout
   * ses modèles paresseusement. On peut donc l'importer dans un test pur.
   */
  const ledger = require("../src/services/ledgerService");

  assert.equal(
    typeof ledger.postCagnotteExternalParticipationEntries,
    "function",
    "La primitive doit être exportée : c'est elle que `externalPaymentCallback` " +
      "devra appeler à la place de son `$inc: { balance }` hors grand livre."
  );

  assert.equal(
    typeof ledger.postCagnotteParticipationEntries,
    "function",
    "La primitive du chemin authentifié ne doit pas avoir disparu au passage."
  );
});
