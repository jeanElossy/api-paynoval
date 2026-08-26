"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  LEASE_MS,
  computeEventFingerprint,
  resolveEventKey,
  decideFromRecord,
} = require("../src/services/webhooks/webhookIdempotency");

const store = require("../src/services/webhooks/webhookEventStore");

/**
 * Ce que ces tests protègent : AUCUNE déduplication n'existait sur les rappels
 * prestataire. Or le rejeu est le comportement NORMAL — tous réémettent tant
 * qu'ils n'ont pas reçu un 2xx, et plusieurs réémettent même après. Un
 * « paiement confirmé » traité deux fois créditait le bénéficiaire deux fois.
 */

const PAYLOAD = {
  eventId: "evt_123",
  provider: "wave",
  rail: "mobilemoney",
  reference: "PNV-1",
  providerReference: "WV-9",
  providerStatus: "completed",
  eventType: "payment.succeeded",
  amount: 5000,
  currency: "XOF",
};

/* ==========================================================================
 * LA CLÉ
 * ======================================================================== */

test("l'identifiant du prestataire est la clé quand il existe", () => {
  const { key, derived } = resolveEventKey(PAYLOAD);

  assert.equal(key, "evt_123");
  assert.equal(derived, false);
});

test("sans identifiant, une empreinte DÉTERMINISTE prend le relais", () => {
  // Tous les prestataires n'envoient pas d'identifiant d'événement.
  const sans = { ...PAYLOAD, eventId: undefined };
  const a = resolveEventKey(sans);
  const b = resolveEventKey({ ...sans });

  assert.equal(a.derived, true);
  assert.match(a.key, /^fp:[0-9a-f]{64}$/);
  assert.equal(a.key, b.key);
});

test("l'empreinte ignore l'ordre des clés", () => {
  // `{a,b}` et `{b,a}` décrivent le même fait : les distinguer ferait échouer
  // la déduplication sur un simple caprice de sérialisation.
  const a = computeEventFingerprint({ reference: "A", amount: 10 });
  const b = computeEventFingerprint({ amount: 10, reference: "A" });

  assert.equal(a, b);
});

test("l'empreinte ne retient QUE ce qui décrit le fait", () => {
  /**
   * ══ LE PIÈGE À ÉVITER ══
   *
   * Inclure l'horodatage de réception ou un identifiant de requête rendrait
   * CHAQUE rejeu unique : la déduplication ne dédupliquerait plus rien, tout en
   * donnant l'apparence de fonctionner.
   */
  const base = computeEventFingerprint(PAYLOAD);
  const bruite = computeEventFingerprint({
    ...PAYLOAD,
    receivedAt: new Date().toISOString(),
    requestId: Math.random().toString(),
    rawHeaders: { "x-signature": "abc" },
  });

  assert.equal(base, bruite);
});

test("deux faits DIFFÉRENTS ont des empreintes différentes", () => {
  const a = computeEventFingerprint(PAYLOAD);

  assert.notEqual(a, computeEventFingerprint({ ...PAYLOAD, amount: 5001 }));
  assert.notEqual(a, computeEventFingerprint({ ...PAYLOAD, providerStatus: "failed" }));
  assert.notEqual(a, computeEventFingerprint({ ...PAYLOAD, reference: "PNV-2" }));
});

/* ==========================================================================
 * LA DÉCISION
 * ======================================================================== */

test("un événement inconnu se traite", () => {
  assert.deepEqual(decideFromRecord(null), { action: "process", status: 200 });
});

test("un événement DÉJÀ TRAITÉ se rejoue en 200", () => {
  /**
   * Toute autre réponse ferait réessayer le prestataire indéfiniment sur un
   * événement dont on a déjà tiré toutes les conséquences.
   */
  const d = decideFromRecord({ status: "processed", responseStatus: 200 });

  assert.equal(d.action, "replay");
  assert.equal(d.status, 200);
});

test("un événement EN COURS ailleurs rend 409, jamais 200", () => {
  /**
   * ══ LE CHOIX DE CODE LE PLUS IMPORTANT DU MODULE ══
   *
   * Acquitter en 200 un traitement qui peut encore échouer ferait cesser les
   * réémissions du prestataire — et l'événement serait perdu définitivement.
   * Le 409 dit « reviens », ce qui est exactement ce qu'on veut.
   */
  const d = decideFromRecord({ status: "processing", startedAt: new Date() });

  assert.equal(d.action, "conflict");
  assert.equal(d.status, 409);
});

test("une réservation PÉRIMÉE se reprend", () => {
  // Un processus tué au milieu du règlement laisserait sinon un `processing`
  // éternel, et l'événement serait bloqué pour toujours.
  const vieux = new Date(Date.now() - LEASE_MS - 1000);
  const d = decideFromRecord({ status: "processing", startedAt: vieux });

  assert.equal(d.action, "retake");
});

test("le bail est LONG — reprendre trop tôt recréerait le double traitement", () => {
  // Un règlement qui appelle un prestataire peut être lent.
  assert.equal(LEASE_MS, 5 * 60 * 1000);

  const recent = new Date(Date.now() - 60_000);
  assert.equal(decideFromRecord({ status: "processing", startedAt: recent }).action, "conflict");
});

test("un ÉCHEC se rejoue — c'est tout l'intérêt du rejeu prestataire", () => {
  const d = decideFromRecord({ status: "failed", startedAt: new Date() });

  assert.equal(d.action, "retake");
});

/* ==========================================================================
 * LA RÉSERVATION — CE QUI SE PASSE À DEUX INSTANCES
 * ======================================================================== */

function fakeModel({ existing = null } = {}) {
  const state = { created: [], updates: [], existing };

  return {
    state,
    async create(doc) {
      if (state.existing) {
        const err = new Error("E11000 duplicate key");
        err.code = 11000;
        throw err;
      }
      state.existing = { ...doc };
      state.created.push(doc);
      return doc;
    },
    findOne() {
      // Chaînable comme Mongoose : `findOne(...).lean()`.
      return { lean: async () => state.existing };
    },
    async findOneAndUpdate(filtre, maj, _opts) {
      state.updates.push({ filtre, maj });
      if (!state.reprisePossible) return null;
      state.existing = { ...state.existing, status: "processing" };
      return state.existing;
    },
    async updateOne(filtre, maj) {
      state.updates.push({ filtre, maj });
      return { modifiedCount: 1 };
    },
  };
}

test("le premier arrivé RÉSERVE, le second est refusé", async () => {
  /**
   * ══ POURQUOI L'INSERTION D'ABORD, ET PAS UNE LECTURE ══
   *
   * « Lire puis écrire » laisse une fenêtre : deux instances recevant le même
   * rappel — ce que les prestataires font couramment — liraient toutes deux
   * « rien » et régleraient toutes deux. On tente donc l'INSERTION et on laisse
   * l'index unique trancher.
   */
  const m = fakeModel();
  store.setEventModel(m);

  const premier = await store.claimEvent(PAYLOAD);
  assert.equal(premier.action, "process");

  // Le second tombe sur l'index unique, relit, et voit un `processing` récent.
  m.state.existing = { status: "processing", startedAt: new Date() };
  const second = await store.claimEvent(PAYLOAD);

  assert.equal(second.action, "conflict");
  assert.equal(second.status, 409);
});

test("un rejeu après traitement est signalé comme tel", async () => {
  const m = fakeModel({
    existing: { status: "processed", responseStatus: 200 },
  });
  store.setEventModel(m);

  const r = await store.claimEvent(PAYLOAD);

  assert.equal(r.action, "replay");
  assert.equal(r.status, 200);
});

test("la reprise d'un bail périmé est ATOMIQUE", async () => {
  /**
   * Sans condition dans le filtre, deux instances constatant simultanément
   * l'expiration reprendraient toutes deux — et régleraient toutes deux.
   */
  const m = fakeModel({
    existing: { status: "processing", startedAt: new Date(Date.now() - LEASE_MS - 5000) },
  });
  m.state.reprisePossible = true;
  store.setEventModel(m);

  const r = await store.claimEvent(PAYLOAD);

  assert.equal(r.action, "process");

  const filtre = m.state.updates[0].filtre;
  assert.ok(filtre.$or, "la condition d'origine doit être reprise dans le filtre");
  assert.ok(filtre.$or.some((c) => c.status === "failed"));
  assert.ok(filtre.$or.some((c) => c.status === "processing" && c.startedAt?.$lte));
});

test("si un autre a repris entre-temps, on s'efface", async () => {
  const m = fakeModel({
    existing: { status: "processing", startedAt: new Date(Date.now() - LEASE_MS - 5000) },
  });
  m.state.reprisePossible = false; // `findOneAndUpdate` rend null
  store.setEventModel(m);

  const r = await store.claimEvent(PAYLOAD);

  assert.equal(r.action, "conflict");
});

test("une erreur qui n'est PAS un doublon remonte intacte", async () => {
  const m = fakeModel();
  m.create = async () => {
    const err = new Error("base indisponible");
    err.code = "ECONNRESET";
    throw err;
  };
  store.setEventModel(m);

  await assert.rejects(() => store.claimEvent(PAYLOAD), /base indisponible/);
});

test("le message d'erreur enregistré est TRONQUÉ", async () => {
  // Une réponse prestataire entière peut porter des données personnelles.
  const m = fakeModel();
  store.setEventModel(m);

  await store.markFailed("evt_123", "wave", new Error("x".repeat(1000)));

  const valeur = m.state.updates[0].maj.$set.lastError;
  assert.equal(valeur.length, 300);
});

/* ==========================================================================
 * LE CÂBLAGE — LA PARTIE QU'AUCUN TEST UNITAIRE NE COUVRE
 * ======================================================================== */

const fs = require("node:fs");

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const CONTROLEUR = stripComments(
  fs.readFileSync(require.resolve("../src/controllers/providerWebhookController"), "utf8")
);

test("la déduplication est posée APRÈS la signature et AVANT le règlement", () => {
  /**
   * L'ordre n'est pas un détail :
   *   - enregistrer un événement NON authentifié permettrait à n'importe qui de
   *     remplir le registre — et pire, de RÉSERVER l'identifiant d'un vrai
   *     événement pour empêcher son traitement ;
   *   - régler avant de réserver rendrait la réservation inutile.
   */
  const iSignature = CONTROLEUR.lastIndexOf("parsed.verified !== true");
  const iClaim = CONTROLEUR.lastIndexOf("await claimEvent(");
  const iReglement = CONTROLEUR.lastIndexOf("await settleExternalTransaction(req.body)");

  assert.ok(iSignature > 0 && iClaim > 0 && iReglement > 0, "ancres introuvables");
  assert.ok(iSignature < iClaim, "la réservation doit suivre la vérification de signature");
  assert.ok(iClaim < iReglement, "la réservation doit précéder le règlement");
});

test("un rejeu répond 200, jamais une erreur", () => {
  // Toute autre réponse ferait réessayer le prestataire indéfiniment.
  const bloc = CONTROLEUR.slice(
    CONTROLEUR.indexOf('claim.action === "replay"'),
    CONTROLEUR.indexOf('claim.action === "conflict"')
  );

  assert.match(bloc, /res\.status\(200\)/);
  assert.match(bloc, /Webhook-Replayed/);
});

test("un traitement concurrent répond 409, JAMAIS 200", () => {
  /**
   * ══ LE CHOIX DE CODE LE PLUS IMPORTANT ══
   *
   * Acquitter en 200 un traitement qui peut encore échouer ferait cesser les
   * réémissions — et l'événement serait perdu définitivement.
   */
  const iConflit = CONTROLEUR.indexOf('claim.action === "conflict"');
  const iReglement = CONTROLEUR.lastIndexOf("await settleExternalTransaction(req.body)");

  // Bornes VÉRIFIÉES : une ancre disparue rendrait `indexOf` négatif et le
  // découpage silencieusement faux — le test passerait sans plus rien couvrir.
  assert.ok(iConflit > 0 && iReglement > iConflit, "ancres introuvables");

  const bloc = CONTROLEUR.slice(iConflit, iReglement);

  assert.match(bloc, /res\.status\(409\)/);
  assert.ok(!/res\.status\(200\)/.test(bloc));
});

test("l'événement est marqué APRÈS le règlement, sur son résultat réel", () => {
  /**
   * Marquer d'abord ferait perdre l'événement pour de bon si le règlement
   * échouait ensuite : le rejeu suivant serait pris pour un doublon et ignoré,
   * l'argent n'arriverait jamais, et aucune erreur n'apparaîtrait nulle part.
   *
   * L'ancre a changé en F.4 (`res.on("finish")` → `await`), la PROPRIÉTÉ non.
   * La clôture précède désormais l'envoi de la réponse, ce qui est strictement
   * meilleur : avec `finish`, un processus tué entre réponse et clôture
   * laissait l'événement en `processing` pour toujours alors que le règlement
   * était acquis.
   */
  const iReglement = CONTROLEUR.lastIndexOf("await settleExternalTransaction(req.body)");
  const iMarque = CONTROLEUR.lastIndexOf("await markProcessed(claim.key");

  assert.ok(iReglement > 0 && iMarque > 0, "ancres introuvables");
  assert.ok(iReglement < iMarque, "le règlement doit précéder la clôture");

  assert.match(CONTROLEUR, /markFailed\(claim\.key, provider, err\)/);
  assert.match(CONTROLEUR, /responseStatus: result\.statusCode/);
});

test("aucun `markProcessed` n'est appelé avant le règlement", () => {
  const iReglement = CONTROLEUR.lastIndexOf("await settleExternalTransaction(req.body)");

  assert.ok(iReglement > 0, "ancre introuvable");
  assert.ok(!/markProcessed\(/.test(CONTROLEUR.slice(0, iReglement)));
});

test("l'adaptateur HTTP ne contient AUCUNE règle de règlement", () => {
  /**
   * F.4 a séparé le moteur du transport pour que le rejeu depuis le registre
   * exécute exactement le même code que le rappel direct. Toute règle qui
   * reviendrait vivre dans le contrôleur HTTP échapperait au rejeu — et le
   * rejeu produirait alors un résultat différent du direct, divergence qui ne
   * se voit qu'en incident.
   */
  const MOTEUR = stripComments(
    fs.readFileSync(
      require.resolve("../src/controllers/externalSettlementController"),
      "utf8"
    )
  );

  // Les primitives monétaires n'appartiennent qu'au moteur.
  for (const primitive of [
    "captureSenderReserve",
    "creditReceiverFunds",
    "refundSenderFunds",
    "releaseSenderReserve",
  ]) {
    assert.ok(
      MOTEUR.includes(primitive),
      `${primitive} doit vivre dans le moteur`
    );
    assert.ok(
      !CONTROLEUR.includes(primitive),
      `${primitive} ne doit PAS apparaître dans l'adaptateur HTTP`
    );
  }
});

test("le moteur rend un résultat au lieu d'écrire la réponse", () => {
  const MOTEUR = stripComments(
    fs.readFileSync(
      require.resolve("../src/controllers/externalSettlementController"),
      "utf8"
    )
  );

  const debut = MOTEUR.indexOf("async function settleExternalTransaction(");
  const fin = MOTEUR.indexOf("async function settleExternalTransactionWebhook(");

  assert.ok(debut > 0 && fin > debut, "ancres introuvables");

  // `res` n'existe pas dans le moteur : c'est ce qui le rend rejouable.
  assert.ok(!/\bres\.(status|json|send)\(/.test(MOTEUR.slice(debut, fin)));
});
