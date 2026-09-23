"use strict";

/**
 * ============================================================================
 * LA VRAIE CHARGE, SOUMISE AU VRAI CONTRAT
 * ============================================================================
 *
 * ── L'incident qui a produit ce fichier (2026-09-23) ───────────────────────
 *
 * `transactionNotificationService` a été réécrit pour que Tx-Core n'annonce
 * plus qu'un fait et un type du catalogue. La charge a gagné quatre champs
 * (`legacyType`, `aggregateType`, `variables`, `meta`) ; le contrat de
 * `notification.requested.v1` n'a pas suivi. `buildPayload` a donc refusé
 * CHAQUE événement, le `catch` l'a journalisé en `OUTBOX_EVENT_LOST`, et plus
 * aucune transaction — initiée, confirmée, annulée — n'a notifié personne.
 *
 * Les tests de l'époque lisaient le TEXTE du service (« il contient
 * `resolveTransactionType` », « il ne contient plus `channels` ») : ils
 * passaient tous. Aucun ne faisait tourner la fonction jusqu'au contrat.
 *
 * ── Ce que ce fichier fait, et que les autres ne faisaient pas ─────────────
 *
 * Il EXÉCUTE `notifyTransactionEvent` pour chaque statut, avec une base
 * simulée, et un publieur qui passe la charge au VRAI `buildPayload`. Il échoue
 * si quelqu'un :
 *   · ajoute un champ à la charge sans l'ajouter au contrat (l'incident) ;
 *   · fait disparaître la notification d'un statut (initiée, confirmée,
 *     annulée, échouée, remboursée) ;
 *   · se trompe de type du catalogue pour un rôle ;
 *   · remet une adresse e-mail dans `variables` ou `meta` ;
 *   · recommence à choisir les canaux côté Tx-Core.
 *
 * Test **en mémoire** : aucune base, aucun Redis.
 */

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

const RACINE = path.join(__dirname, "..");
const chemin = (...p) => require.resolve(path.join(RACINE, "src", ...p));

/* -------------------------------------------------------------------------- */
/* Doublures posées AVANT le chargement du service                            */
/* -------------------------------------------------------------------------- */

const publies = [];
const erreurs = [];

const { buildPayload } = require(chemin("services", "events", "contract.js"));

/** Le publieur réel valide par `buildPayload` : la doublure fait EXACTEMENT pareil. */
require.cache[chemin("services", "events", "publisher.js")] = {
  id: "publisher-doublure",
  loaded: true,
  exports: {
    async publishDomainEvent({ name, aggregateId, payload }) {
      const charge = buildPayload(name, payload || {});
      if (!String(aggregateId || "").trim()) throw new Error("EVENT_AGGREGATE_ID_MISSING");
      publies.push({ name, aggregateId, payload: charge });
      return { _id: "evt" };
    },
  },
};

const UTILISATEURS = {
  exp: { _id: "exp", email: "exp@paynoval.test", fullName: "Awa Koné", countryCode: "CI" },
  dest: { _id: "dest", email: "dest@paynoval.test", fullName: "", countryCode: "CI" },
};

function requete(doc) {
  return {
    select() { return this; },
    lean() { return this; },
    session() { return Promise.resolve(doc); },
  };
}

require.cache[chemin("services", "transactions", "shared", "runtime.js")] = {
  id: "runtime-doublure",
  loaded: true,
  exports: {
    User: { findById: (id) => requete(UTILISATEURS[String(id)] || null) },
    logger: {
      info() {},
      debug() {},
      warn() {},
      error: (m, d) => erreurs.push({ m: String(m), d }),
    },
    maybeSessionOpts: (session) => (session ? { session } : {}),
  },
};

const { notifyTransactionEvent } = require(
  chemin("services", "transactions", "transactionNotificationService.js")
);

function transaction() {
  return {
    _id: { toString: () => "tx123" },
    sender: "exp",
    receiver: "dest",
    reference: "PNV-TEST-1",
    amount: 1000,
    localAmount: 1000,
    currencySource: "XOF",
    currencyTarget: "XOF",
    createdAt: new Date("2026-09-23T10:00:00Z"),
  };
}

async function notifier(status) {
  publies.length = 0;
  erreurs.length = 0;
  await notifyTransactionEvent(transaction(), status, null, "XOF");
  return { publies: [...publies], erreurs: [...erreurs] };
}

/* -------------------------------------------------------------------------- */

const ATTENDU = {
  initiated: { sender: "TRANSACTION_SENT", receiver: "TRANSACTION_RECEIVED" },
  confirmed: { sender: "TRANSACTION_SENT", receiver: "TRANSACTION_RECEIVED" },
  cancelled: { sender: "TRANSACTION_CANCELLED", receiver: "TRANSACTION_CANCELLED" },
  failed: { sender: "TRANSACTION_FAILED", receiver: "TRANSACTION_FAILED" },
  refunded: { sender: "TRANSACTION_REFUND", receiver: "TRANSACTION_REFUND" },
};

for (const [status, types] of Object.entries(ATTENDU)) {
  test(`« ${status} » : deux demandes de notification, acceptées par le contrat`, async () => {
    const { publies: evts, erreurs: errs } = await notifier(status);

    /**
     * LE VERROU DE L'INCIDENT. Une charge hors contrat fait lever
     * `buildPayload` ; le service l'attrape et journalise `OUTBOX_EVENT_LOST`
     * — donc ce tableau d'erreurs, et non une exception, est le signal.
     */
    assert.deepStrictEqual(
      errs.map((e) => e.d?.err || e.m),
      [],
      "la notification a été PERDUE (OUTBOX_EVENT_LOST) — charge refusée par le contrat ?"
    );

    assert.strictEqual(evts.length, 2, "une demande par destinataire");

    const parRole = Object.fromEntries(evts.map((e) => [e.payload.meta.role, e.payload]));

    assert.strictEqual(parRole.sender.notificationType, types.sender);
    assert.strictEqual(parRole.receiver.notificationType, types.receiver);
    assert.strictEqual(parRole.sender.recipient, "exp");
    assert.strictEqual(parRole.receiver.recipient, "dest");
  });
}

test("Tx-Core ne choisit PAS les canaux", async () => {
  const { publies: evts } = await notifier("cancelled");

  for (const e of evts) assert.ok(!("channels" in e.payload), "channels restreindrait les canaux côté backend");
});

test("aucune adresse e-mail dans les champs AJOUTÉS (variables, meta)", async () => {
  /**
   * `BANNIS` ne contrôle que le premier niveau. `variables` retombait sur
   * l'adresse quand le nom manquait (le destinataire de ce test n'a pas de nom) :
   * elle aurait été stockée dans `domain_events` et diffusée sur le flux.
   */
  const { publies: evts } = await notifier("initiated");

  for (const e of evts) {
    const ajoutes = JSON.stringify({ variables: e.payload.variables, meta: e.payload.meta });
    assert.doesNotMatch(ajoutes, /@/, `adresse e-mail dans variables/meta : ${ajoutes}`);
  }
});

test("la clé d'idempotence distingue les statuts d'une même transaction", async () => {
  const a = (await notifier("initiated")).publies.map((e) => e.payload.idempotencyKey);
  const b = (await notifier("cancelled")).publies.map((e) => e.payload.idempotencyKey);

  // Sinon l'annulation serait dédoublonnée contre l'initiation, et jamais envoyée.
  for (const k of b) assert.ok(!a.includes(k));
});
