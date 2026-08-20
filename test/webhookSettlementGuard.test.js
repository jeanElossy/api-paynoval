"use strict";

/**
 * TEST D'INTRUSION — chemin webhook hérité de règlement.
 *
 * `POST /api/v1/transactions/webhooks/:provider` n'avait aucune garde, et
 * `/api/v1/transactions` est monté sans `protect` dans `server.js`. La route
 * atteignait donc `externalSettlementController` — le moteur de règlement
 * complet — depuis Internet et sans identité. Le seul contrôle du contrôleur,
 * `verified: payload.verified !== false`, laisse la charge utile de l'appelant
 * se déclarer elle-même vérifiée.
 *
 * Ce fichier n'est pas un test unitaire déguisé : il monte un vrai serveur
 * Express, y branche la VRAIE garde (`middleware/requireInternalWebhookCaller`,
 * qui délègue à `isValidInternalToken`, la même fonction que le reste du
 * service) et envoie de vraies requêtes HTTP, dont la charge utile d'attaque
 * telle qu'elle serait envoyée en production.
 *
 * Le contrôleur de règlement est remplacé par une sonde : le test échoue si la
 * requête l'ATTEINT, ce qui est exactement la propriété à garantir. Aucune
 * connexion Mongo, aucune écriture — conforme à la règle du dépôt : les tests
 * ne démarrent pas le service et n'ouvrent pas de base.
 *
 * `dotenv-safe` est satisfait en peuplant `process.env` avant tout `require` :
 * la chaîne `requireInternalWebhookCaller → internalAuth → config` en dépend,
 * et c'est le prix à payer pour tester le code réel plutôt qu'une copie.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

/* -------------------------------------------------------------------------- */
/* Environnement minimal — AVANT tout require de code applicatif              */
/* -------------------------------------------------------------------------- */

const GATEWAY_TOKEN = "GW_token_de_test_suffisamment_long_0123456789";
const PRINCIPAL_TOKEN = "PR_token_de_test_suffisamment_long_0123456789";

(function seedEnv() {
  const examplePath = path.join(__dirname, "..", ".env.example");

  const required = fs
    .readFileSync(examplePath, "utf8")
    .split("\n")
    .map((line) => line.split("=")[0].trim())
    .filter((key) => key && !key.startsWith("#"));

  for (const key of required) {
    if (!process.env[key]) process.env[key] = "test";
  }

  process.env.GATEWAY_INTERNAL_TOKEN = GATEWAY_TOKEN;
  process.env.PRINCIPAL_INTERNAL_TOKEN = PRINCIPAL_TOKEN;
  process.env.INTERNAL_TOKEN = PRINCIPAL_TOKEN;
})();

const express = require("express");
const requireInternalWebhookCaller = require("../src/middleware/requireInternalWebhookCaller");

/* -------------------------------------------------------------------------- */
/* Banc d'essai                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Monte la route telle qu'elle est déclarée dans `transactionsRoutes.js` :
 * la garde, puis le contrôleur de règlement — ici une sonde.
 */
function startHarness() {
  const reached = [];

  const app = express();
  app.use(express.json());

  app.post(
    "/api/v1/transactions/webhooks/:provider",
    requireInternalWebhookCaller,
    (req, res) => {
      reached.push({ provider: req.params.provider, body: req.body });
      res.status(200).json({ success: true, settled: true });
    }
  );

  // Gestionnaire d'erreurs minimal, à l'image de `middleware/errorHandler.js`.
  app.use((err, _req, res, _next) => {
    res
      .status(err.status || 500)
      .json({ success: false, status: err.status || 500, message: err.message });
  });

  const server = http.createServer(app);

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, reached, port: server.address().port });
    });
  });
}

function post(port, urlPath, body, headers = {}) {
  const payload = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/**
 * La charge utile d'attaque, telle qu'elle serait réellement envoyée : elle
 * désigne une transaction par son identifiant, se déclare réussie, et se
 * déclare vérifiée.
 */
const FORGED_SETTLEMENT = {
  transactionId: "665f1c2a4b1d3e0012a4b5c6",
  status: "success",
  eventId: "evt_forge_1",
  verified: true,
  providerReference: "FORGE-REF-0001",
  amount: 500000,
};

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

test("un webhook de règlement forgé, sans identité, est refusé", async (t) => {
  const { server, reached, port } = await startHarness();
  t.after(() => server.close());

  const res = await post(
    port,
    "/api/v1/transactions/webhooks/wave",
    FORGED_SETTLEMENT
  );

  assert.equal(res.status, 401);

  // La propriété qui compte : le moteur de règlement n'est pas atteint.
  assert.equal(
    reached.length,
    0,
    "le contrôleur de règlement a été atteint sans authentification"
  );
});

test("`verified: true` dans la charge utile n'ouvre rien", async (t) => {
  const { server, reached, port } = await startHarness();
  t.after(() => server.close());

  // Le contrôleur, lui, fait confiance à ce champ (`payload.verified !== false`).
  // C'est précisément pourquoi la garde doit trancher AVANT lui.
  for (const verified of [true, "true", 1, undefined]) {
    const res = await post(port, "/api/v1/transactions/webhooks/orange", {
      ...FORGED_SETTLEMENT,
      verified,
    });

    assert.equal(res.status, 401);
  }

  assert.equal(reached.length, 0);
});

test("un token interne invalide, vide ou approchant est refusé", async (t) => {
  const { server, reached, port } = await startHarness();
  t.after(() => server.close());

  const attempts = [
    "x",
    "",
    "   ",
    "Bearer " + GATEWAY_TOKEN,
    GATEWAY_TOKEN + "x",
    GATEWAY_TOKEN.slice(0, -1),
    GATEWAY_TOKEN.toUpperCase(),
  ];

  for (const token of attempts) {
    const res = await post(
      port,
      "/api/v1/transactions/webhooks/mtn",
      FORGED_SETTLEMENT,
      { "x-internal-token": token }
    );

    assert.equal(
      res.status,
      401,
      `le token ${JSON.stringify(token)} n'aurait pas dû passer`
    );
  }

  assert.equal(reached.length, 0);
});

test("la seule PRÉSENCE de l'en-tête ne suffit pas", async (t) => {
  const { server, reached, port } = await startHarness();
  t.after(() => server.close());

  /**
   * Régression jumelle de celle du `sensitiveLimiter`, corrigée le 2026-08-19 :
   * il testait la présence de `x-internal-token` sans comparer sa valeur. La
   * même erreur ici rouvrirait le moteur de règlement à quiconque envoie un
   * en-tête arbitraire.
   */
  const res = await post(
    port,
    "/api/v1/transactions/webhooks/moov",
    FORGED_SETTLEMENT,
    { "x-internal-token": "n-importe-quoi" }
  );

  assert.equal(res.status, 401);
  assert.equal(reached.length, 0);
});

test("un appelant interne légitime passe toujours", async (t) => {
  const { server, reached, port } = await startHarness();
  t.after(() => server.close());

  // Le correctif ne doit pas casser le chemin interne : c'est la raison pour
  // laquelle la route est verrouillée plutôt que supprimée.
  for (const token of [GATEWAY_TOKEN, PRINCIPAL_TOKEN]) {
    const res = await post(
      port,
      "/api/v1/transactions/webhooks/wave",
      FORGED_SETTLEMENT,
      { "x-internal-token": token }
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.settled, true);
  }

  assert.equal(reached.length, 2);
});

test("la garde est réellement câblée sur la route, pas seulement disponible", () => {
  /**
   * Les tests ci-dessus prouvent que la garde REFUSE. Ils ne prouvent pas
   * qu'elle est MONTÉE : le banc d'essai la branche lui-même. Or la
   * vulnérabilité d'origine n'était pas une garde défaillante, c'était une
   * garde absente — la route se contentait d'un commentaire affirmant que la
   * sécurité était faite ailleurs.
   *
   * Charger `transactionsRoutes.js` pour inspecter la pile Express n'est pas
   * possible ici : il tire les contrôleurs, donc `runtime`, qui ouvre une
   * connexion Mongo au chargement — ce que les tests de ce dépôt s'interdisent.
   * On vérifie donc le câblage à la source, sur le BLOC ACTIF uniquement : le
   * fichier commence par une version héritée intégralement commentée, et une
   * recherche naïve y trouverait n'importe quoi.
   */
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "routes", "transactionsRoutes.js"),
    "utf8"
  );

  const active = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

  const registration = active.slice(active.indexOf('"/webhooks/:provider"'));
  const handlerAt = registration.indexOf("settleExternalTransactionWebhook");
  const guardAt = registration.indexOf("requireInternalWebhookCaller");

  assert.notEqual(
    guardAt,
    -1,
    "la route /webhooks/:provider n'a plus de garde d'authentification"
  );

  assert.ok(
    guardAt < handlerAt,
    "la garde doit précéder le contrôleur de règlement"
  );
});

test("le message d'erreur oriente vers la route signée sans rien divulguer", async (t) => {
  const { server, port } = await startHarness();
  t.after(() => server.close());

  const res = await post(
    port,
    "/api/v1/transactions/webhooks/stripe",
    FORGED_SETTLEMENT
  );

  assert.match(res.body.message, /webhooks\/providers/);

  // Le refus ne doit rien apprendre sur l'existence de la transaction visée,
  // sous peine de transformer l'endpoint en oracle d'énumération.
  const serialized = JSON.stringify(res.body);
  assert.equal(serialized.includes(FORGED_SETTLEMENT.transactionId), false);
  assert.equal(serialized.includes(FORGED_SETTLEMENT.providerReference), false);
});
