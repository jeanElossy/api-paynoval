"use strict";

/**
 * Garde contre la réintroduction du rail bancaire.
 *
 * Le §1 de l'architecture cible est explicite : PayNoval n'a AUCUN rail
 * bancaire direct, et il ne faut en créer un que si cela devient explicitement
 * nécessaire. Du code bancaire existait pourtant — adapter, exécuteur,
 * routage, entrée au registre — et il contredisait la cible depuis le début.
 *
 * Retiré le 2026-08-26. PayNoval démarre sur trois rails : transferts
 * internes, mobile money, cartes.
 *
 * ── Pourquoi un test et pas seulement une suppression ─────────────────────
 * Parce que le code supprimé revient. Quelqu'un lira « bank » dans une
 * énumération héritée, conclura qu'il manque un adapter, et le réécrira « au
 * cas où ». Or un rail présent dans le code finit par être proposé, et un rail
 * proposé sans contrat ACCEPTE des ordres que personne n'exécute : fonds
 * réservés, jamais versés, transaction bloquée. C'était le défaut n°1 de
 * l'audit d'architecture.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");

test("aucun adapter bancaire sur le disque", () => {
  assert.equal(
    fs.existsSync(path.join(SRC, "providers", "bank")),
    false,
    "src/providers/bank/ ne doit pas exister"
  );
  assert.equal(
    fs.existsSync(path.join(SRC, "services", "transactions", "providers", "bankExecutor.js")),
    false,
    "bankExecutor.js ne doit pas exister"
  );
});

test("le registre des rails n'annonce aucun rail bancaire", () => {
  // Ce registre décide du journal de démarrage et des refus 503 : il ne doit
  // annoncer que ce qui existe réellement.
  const { RAILS } = require("../src/providers/providerConfigReport");
  assert.ok(Array.isArray(RAILS));
  assert.ok(!RAILS.some((r) => r.rail === "bank"), "aucune entrée `bank`");
  assert.ok(!RAILS.some((r) => /bank/i.test(r.provider)), "aucun prestataire bancaire");
});

test("le sélecteur REFUSE le rail bancaire au lieu de replier en silence", () => {
  // Le refus est la propriété essentielle. Router un ordre bancaire vers un
  // autre adapter déplacerait de l'argent par un chemin que personne n'a
  // choisi — bien pire qu'une erreur.
  const { getProviderAdapter } = require("../src/providers/providerSelector");

  for (const rail of ["bank", "bank_transfer", "bank-transfer"]) {
    assert.throws(
      () => getProviderAdapter({ rail, provider: "bank_generic" }),
      /rail bancaire a été retiré/i,
      `le rail « ${rail} » doit lever`
    );
  }
});

test("le sélecteur n'exporte plus getBankAdapter", () => {
  const selecteur = require("../src/providers/providerSelector");
  assert.equal(selecteur.getBankAdapter, undefined);
  assert.ok(selecteur.getMobileMoneyAdapter, "mobile money reste");
  assert.ok(selecteur.getCardAdapter, "cartes restent");
});

test("aucun flux bancaire ne trouve d'exécuteur", () => {
  // `resolveExecutor` doit rendre `null` : l'appelant traite ce null comme
  // « aucun rail ne sert ce flux », donc un refus.
  const registre = require("../src/services/transactions/providers/providerExecutorRegistry");
  assert.equal(registre.resolveBankExecutor, undefined);

  if (typeof registre.resolveExecutor === "function") {
    for (const flow of ["PAYNOVAL_TO_BANK_PAYOUT", "BANK_TRANSFER_TO_PAYNOVAL"]) {
      assert.equal(
        registre.resolveExecutor(flow, "bank_generic"),
        null,
        `le flux ${flow} ne doit trouver aucun exécuteur`
      );
    }
  }
});

test("aucune trace du rail bancaire dans le modèle Transaction", () => {
  /**
   * L'énumération avait d'abord été CONSERVÉE, par précaution : retirer une
   * valeur d'une liste de validation rend insauvegardable tout document
   * hérité qui la porte, et le §26 interdit de faire disparaître une écriture
   * financière en silence.
   *
   * L'utilisateur a confirmé le 2026-08-26 qu'aucune transaction bancaire
   * n'existe en base. La précaution n'avait donc plus d'objet et la valeur a
   * été retirée.
   *
   * Si une transaction bancaire héritée réapparaissait un jour, le symptôme
   * serait une erreur de validation Mongoose à la sauvegarde — bruyante, donc
   * diagnosticable. C'est le bon mode de défaillance.
   */
  const src = fs.readFileSync(path.join(SRC, "models", "Transaction.js"), "utf8");
  assert.ok(!/"bank"/.test(src), "aucun rail `bank`");
  assert.ok(!/BANK_TRANSFER_TO_PAYNOVAL/.test(src), "aucun flux entrant bancaire");
  assert.ok(!/PAYNOVAL_TO_BANK_PAYOUT/.test(src), "aucun flux sortant bancaire");
});

test("les rails offerts restent intacts", () => {
  // Une garde qui emporterait les rails réels serait pire que le défaut
  // qu'elle corrige.
  //
  // `stripe` figurait dans cette liste jusqu'au 2026-09-08. Il en a été retiré
  // par DÉCISION PRODUIT, pas par accident : les cartes passeront par un
  // partenaire servant Visa, Mastercard et les autres réseaux. La garde suit le
  // périmètre réel — trois rails.
  const src = fs.readFileSync(path.join(SRC, "models", "Transaction.js"), "utf8");
  for (const rail of ["paynoval", "mobilemoney", "visa_direct"]) {
    assert.ok(src.includes(`"${rail}"`), `le rail ${rail} doit rester`);
  }
});

test("les rails retirés du produit ne reviennent pas par l'énumération", () => {
  /**
   * Le pendant de la garde ci-dessus. Un rail retiré de la politique AML mais
   * laissé dans l'énumération du modèle serait persistable sans plafond : la
   * transaction se créerait, et c'est seulement au moment de bouger l'argent
   * que ça coincerait — trop tard, et sans dire pourquoi.
   */
  const src = fs.readFileSync(path.join(SRC, "models", "Transaction.js"), "utf8");
  for (const retiré of ["stripe", "stripe2momo", "flutterwave", "cashin", "cashout"]) {
    assert.ok(
      !new RegExp(`"${retiré}"`).test(src),
      `le rail ${retiré} a été retiré du produit et ne doit plus être persistable`
    );
  }
});

/* ==========================================================================
 * UNE CONSTANTE RETIRÉE LAISSE DES COMPARAISONS QUI DISENT « OUI »
 * ======================================================================== */

test("aucune comparaison ne survit à la constante bancaire qu'elle testait", () => {
  /**
   * ⚠️ LE DÉFAUT MESURÉ LE 2026-09-10, ET POURQUOI IL EST DE CETTE FAMILLE.
   *
   * Les constantes `PAYNOVAL_TO_BANK_PAYOUT` et `BANK_TRANSFER_TO_PAYNOVAL`
   * avaient été retirées des tables de flux — proprement. Mais les
   * COMPARAISONS qui les testaient étaient restées dans
   * `resolveProviderForFlow` :
   *
   *     flow === OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_BANK_PAYOUT ||
   *     flow === INBOUND_EXTERNAL_FLOWS.BANK_TRANSFER_TO_PAYNOVAL
   *
   * Les deux membres droits valant `undefined`, la condition se lisait
   * `flow === undefined || flow === undefined`. Elle rendait donc VRAI pour
   * tout flux non résolu, et `resolveProviderForFlow(undefined)` répondait
   * `"bank"` — un rail retiré, sans adaptateur.
   *
   * Un retrait à moitié fait est pire qu'un retrait non fait : le premier
   * laisse une condition privée de ses deux bornes, et une comparaison sans
   * bornes finit par dire oui.
   *
   * Ce test ne verrouille pas le texte du code : il vérifie le COMPORTEMENT
   * pour toutes les valeurs qu'un flux non résolu peut prendre.
   */
  const {
    resolveProviderForFlow,
    resolveExternalFlow,
  } = require("../src/services/transactions/handlers/flowHelpers");

  for (const flou of [undefined, null, "", "UNKNOWN_FLOW", "N_IMPORTE_QUOI"]) {
    const prestataire = resolveProviderForFlow(flou, {});

    assert.notEqual(
      prestataire,
      "bank",
      `resolveProviderForFlow(${JSON.stringify(flou)}) rend « bank » : un flux ` +
        "non résolu sélectionne un rail retiré, qui n'a aucun adaptateur."
    );
  }

  /** Et les deux charges bancaires ne résolvent aucun flux. */
  for (const charge of [
    { funds: "paynoval", destination: "bank", action: "withdraw" },
    { funds: "bank", destination: "paynoval", action: "deposit" },
    { funds: "paynoval", destination: "banque", action: "send" },
  ]) {
    assert.equal(
      resolveExternalFlow(charge),
      "UNKNOWN_FLOW",
      `${JSON.stringify(charge)} résout encore un flux. Le rail bancaire est ` +
        "hors périmètre : trois rails et rien d'autre."
    );
  }
});

test("les trois rails du périmètre restent résolvables", () => {
  /**
   * Le volet positif. Un test qui n'interdit que des choses pousse à tout
   * supprimer : celui-ci exige que le périmètre arrêté — PayNoval interne,
   * mobile money, carte Visa — continue de fonctionner.
   */
  const {
    resolveExternalFlow,
  } = require("../src/services/transactions/handlers/flowHelpers");

  const attendus = [
    [{ funds: "paynoval", destination: "mobilemoney", action: "withdraw" },
     "PAYNOVAL_TO_MOBILEMONEY_PAYOUT"],
    [{ funds: "mobilemoney", destination: "paynoval", action: "deposit" },
     "MOBILEMONEY_COLLECTION_TO_PAYNOVAL"],
    [{ funds: "paynoval", destination: "visa_direct", action: "withdraw" },
     "PAYNOVAL_TO_CARD_PAYOUT"],
    [{ funds: "card", destination: "paynoval", action: "deposit" },
     "CARD_TOPUP_TO_PAYNOVAL"],
  ];

  for (const [charge, flux] of attendus) {
    assert.equal(
      resolveExternalFlow(charge),
      flux,
      `${JSON.stringify(charge)} ne résout plus « ${flux} ». Le retrait du ` +
        "rail bancaire a emporté un rail du périmètre."
    );
  }
});
