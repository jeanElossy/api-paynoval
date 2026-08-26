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

test("« bank » RESTE dans l'énumération du modèle — et c'est délibéré", () => {
  /**
   * Cette liste n'est pas un catalogue d'offre, c'est une VALIDATION. Retirer
   * la valeur rendrait insauvegardable toute transaction héritée qui la porte :
   * document lu, modifié, puis rejeté en validation. Les actions admin, les
   * remboursements et la réconciliation échoueraient dessus — et le §26
   * interdit de faire disparaître une écriture financière en silence.
   *
   * Ce test existe pour que la conservation soit un CHOIX visible, et non un
   * oubli que quelqu'un « nettoiera » sans mesurer la conséquence.
   *
   * À retirer seulement après avoir vérifié en production que
   * `db.transactions.countDocuments({ rail: "bank" })` rend 0.
   */
  const src = fs.readFileSync(path.join(SRC, "models", "Transaction.js"), "utf8");
  assert.ok(src.includes('"bank"'), "la valeur héritée doit rester valide");
  assert.match(src, /countDocuments\(\{ rail: "bank" \}\)/, "la condition de retrait doit être écrite");
});
