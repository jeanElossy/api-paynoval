"use strict";

/**
 * ============================================================================
 * MÊME CLÉ D'IDEMPOTENCE · MÊME RÉFÉRENCE PRESTATAIRE — `NO LOST TRANSACTION`
 * ============================================================================
 *
 * Deux registres, un seul principe : **un seul gagnant, et les autres le savent**.
 *
 * Ces deux barrières sont le dernier rempart quand tout le reste a déjà cédé —
 * un double appui sur le bouton d'envoi, un rejeu réseau, un prestataire qui
 * réémet son rappel, deux instances qui reçoivent le même message. Aucune ne
 * repose sur un verrou : toutes deux reposent sur un index unique et sur ce
 * que le code fait du refus que l'index renvoie.
 *
 * C'est ce second point qui ne se teste qu'en concurrence. Un E11000 est facile
 * à provoquer en séquence ; ce qu'on veut savoir, c'est si le perdant conclut
 * la bonne chose — « quelqu'un d'autre s'en occupe » — plutôt que de repartir
 * en erreur, ou pire, de continuer quand même.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const mongoose = require("mongoose");

const H = require("./lib/harness");

const PORTEE = `test-concurrence-${Date.now()}`;

before(async () => {
  await H.ouvrir();
  await H.verifierIndex();
});

after(async () => {
  const e = await H.ouvrir();
  await e.IdempotencyRecord.deleteMany({ scope: new RegExp(`^u:`) });
  await e.ProviderWebhookEvent.deleteMany({ provider: PORTEE });
  await H.fermer();
});

/**
 * Une réponse Express minimale. Le middleware d'idempotence s'abonne à
 * `close` pour libérer la clé si le contrôleur lève sans répondre : sans
 * `EventEmitter`, il planterait au lieu d'être testé.
 */
function fausseReponse() {
  const res = new EventEmitter();

  res.statusCode = 200;
  res.entetes = {};
  res.setHeader = (k, v) => {
    res.entetes[String(k).toLowerCase()] = v;
  };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b) => {
    res.corps = b;
    return res;
  };

  return res;
}

/** Exécute le middleware et rend la réponse, qu'il ait répondu ou appelé `next`. */
function executer(middleware, req) {
  return new Promise((resolve, reject) => {
    const res = fausseReponse();
    const json = res.json.bind(res);

    res.json = (b) => {
      const out = json(b);
      resolve(res);
      return out;
    };

    middleware(req, res, (err) => {
      if (err) return reject(err);
      res.aPoursuivi = true;
      resolve(res);
    });
  });
}

for (const N of [2, 10, 100]) {
  test(`${N} requêtes simultanées portant la MÊME clé d'idempotence`, async () => {
    const idempotency = require("../src/middleware/idempotency");
    const middleware = idempotency({ required: true });

    const userId = new mongoose.Types.ObjectId();
    const cle = `cle-${Date.now()}-${N}`;
    const corps = { amount: 10000, currency: "XOF", to: "beneficiaire@paynoval.test" };

    const r = await H.rafale(N, () =>
      executer(middleware, {
        method: "POST",
        baseUrl: "/api/v1/transactions",
        path: "/initiate",
        headers: { "idempotency-key": cle },
        body: { ...corps },
        user: { _id: userId },
      })
    );

    const poursuivis = r.reussites.filter((res) => res.aPoursuivi);
    const conflits = r.reussites.filter((res) => res.statusCode === 409);
    const autres = r.reussites.filter((res) => !res.aPoursuivi && res.statusCode !== 409);

    console.log(
      H.resumer(r, `même clé d'idempotence · N=${N}`) +
        `\n    ${poursuivis.length} poursuivent · ${conflits.length} en 409 · ` +
        `${autres.length} autre(s)`
    );

    assert.equal(
      poursuivis.length,
      1,
      `NO LOST TRANSACTION / doublon : ${poursuivis.length} requêtes ont été ` +
        `laissées passer pour UNE clé d'idempotence. Chacune aurait réservé ` +
        `des fonds.`
    );

    assert.equal(
      autres.length,
      0,
      `${autres.length} requêtes ont reçu une réponse ni 409 ni « poursuivre » : ` +
        autres.map((res) => `${res.statusCode} ${res.corps?.message || ""}`).join(" · ")
    );

    assert.equal(r.nbEchecs, 0, "aucune requête ne doit lever");
  });
}

for (const N of [2, 10, 100]) {
  test(`${N} rappels prestataire simultanés portant le MÊME identifiant`, async () => {
    const { claimEvent } = require("../src/services/webhooks/webhookEventStore");

    const eventId = `evt-${Date.now()}-${N}`;

    const r = await H.rafale(N, () =>
      claimEvent({
        provider: PORTEE,
        rail: "mobilemoney",
        eventId,
        reference: `REF-${eventId}`,
        providerReference: `PR-${eventId}`,
        providerStatus: "completed",
        eventType: "payment.succeeded",
        amount: 10000,
        currency: "XOF",
      })
    );

    const aTraiter = r.reussites.filter((x) => x.action === "process");
    const ecartes = r.reussites.filter((x) => x.action !== "process");

    console.log(
      H.resumer(r, `même identifiant de rappel · N=${N}`) +
        `\n    ${aTraiter.length} à traiter · ${ecartes.length} écarté(s) ` +
        `(${[...new Set(ecartes.map((x) => x.action))].join(", ") || "—"})`
    );

    assert.equal(
      aTraiter.length,
      1,
      `NO DOUBLE CREDIT : ${aTraiter.length} rappels ont été retenus pour ` +
        `traitement. Chacun aurait crédité le bénéficiaire.`
    );

    assert.equal(r.nbEchecs, 0, "aucune revendication ne doit lever");

    const e = await H.ouvrir();
    const enBase = await e.ProviderWebhookEvent.countDocuments({
      provider: PORTEE,
      eventId,
    });

    assert.equal(enBase, 1, "un seul enregistrement par événement prestataire");
  });
}

test("un bail périmé n'est repris que par UNE instance", async () => {
  /**
   * ── Le cas qui a motivé la garde dans le filtre
   *
   * Quand un traitement meurt en cours, son bail expire et l'événement doit
   * pouvoir être repris — sinon un rappel légitime est perdu pour de bon.
   * Mais si dix instances constatent l'expiration **en même temps**, elles
   * doivent être dix à vouloir reprendre et **une seule** à y parvenir.
   *
   * C'est pour ça que `claimEvent` répète la condition d'expiration DANS le
   * filtre du `findOneAndUpdate` au lieu de se fier à la lecture qui précède.
   * Un test séquentiel ne peut pas distinguer les deux écritures ; celui-ci si.
   */
  const e = await H.ouvrir();
  const { claimEvent } = require("../src/services/webhooks/webhookEventStore");

  const eventId = `evt-perime-${Date.now()}`;
  const charge = {
    provider: PORTEE,
    rail: "mobilemoney",
    eventId,
    reference: `REF-${eventId}`,
    providerStatus: "completed",
    amount: 10000,
    currency: "XOF",
  };

  await claimEvent(charge);

  // On vieillit le bail au lieu d'attendre : le comportement testé est la
  // course, pas la durée.
  await e.ProviderWebhookEvent.updateOne(
    { provider: PORTEE, eventId },
    { $set: { startedAt: new Date(Date.now() - 3600 * 1000) } }
  );

  const r = await H.rafale(50, () => claimEvent(charge, { leaseMs: 60 * 1000 }));

  const repris = r.reussites.filter((x) => x.action === "process");

  console.log(
    H.resumer(r, "reprise d'un bail périmé · N=50") +
      `\n    ${repris.length} reprise(s)`
  );

  assert.equal(
    repris.length,
    1,
    `${repris.length} instances ont repris le même événement expiré. ` +
      `Toutes auraient rejoué le même règlement.`
  );
});
