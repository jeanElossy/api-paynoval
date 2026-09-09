"use strict";

/**
 * ============================================================================
 * TX CORE DOIT CORRÉLER SES JOURNAUX — INVARIANT 11
 * ============================================================================
 *
 * ── Ce que ce test empêche de revenir ────────────────────────────────────────
 * Tx Core n'avait **aucun intergiciel de corrélation**. `x-request-id` n'y
 * apparaissait qu'en liste CORS et dans trois lectures ponctuelles
 * (`utils/idempotency.js`, `services/transactions/providers/providerHttpClient.js`,
 * `controllers/internalPaymentsController.js`) qui retombaient sur une chaîne
 * VIDE quand l'appelant n'en fournissait pas.
 *
 * Le moteur qui déplace l'argent ne reliait donc pas ses journaux à la requête
 * d'origine. L'invariant 11 — toute mutation financière traçable par
 * `requestId`, `transactionId`, `userId` et référence prestataire — n'était pas
 * tenu de bout en bout, précisément au maillon qui compte.
 *
 * ── Et l'identifiant reçu n'est pas digne de confiance ──────────────────────
 * Il entre dans les journaux de trois services. Accepté brut, il permet
 * d'injecter des retours à la ligne — donc de forger de fausses entrées — ou
 * d'y déverser des kilo-octets par requête.
 *
 * ── Comment il tombe ────────────────────────────────────────────────────────
 * Démonter `requestIdMiddleware` de `src/server.js`, ou relâcher `SAFE_ID`.
 *
 * Test **pur** : aucune connexion, aucun serveur.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { resolveRequestId, requestIdMiddleware, SAFE_ID } = require("../src/utils/requestId");

function fausseReponse() {
  const entetes = {};
  return { setHeader: (k, v) => { entetes[k] = v; }, entetes };
}

test("un identifiant propre du client est conservé", () => {
  const { id, source } = resolveRequestId("01JAX7Q2M8ZK3VN4P5R6S7T8U9");
  assert.equal(id, "01JAX7Q2M8ZK3VN4P5R6S7T8U9");
  assert.equal(source, "client");
});

test("un identifiant porteur d'un retour à la ligne est refusé", () => {
  const forge = "abc12345\n2026-01-01 [error]: virement approuve";
  const { id, source } = resolveRequestId(forge);

  assert.equal(source, "generated");
  assert.ok(!id.includes("\n"), "l'identifiant retenu permet encore de forger une ligne de journal");
});

test("un identifiant est toujours posé, même sans en-tête", () => {
  const req = { headers: {} };
  requestIdMiddleware(req, fausseReponse(), () => {});

  assert.ok(SAFE_ID.test(req.id), "aucun identifiant posé : rien ne corrèlera les journaux");
  assert.equal(req.headers["x-request-id"], req.id, "l'en-tête aval doit porter la même valeur");
});

/**
 * ⚠️ Contrôle de CÂBLAGE, et non de comportement. Les trois tests ci-dessus
 * passeraient à l'identique si l'intergiciel n'était monté nulle part — c'est
 * exactement l'état dans lequel se trouvait Tx Core.
 */
test("l'intergiciel est effectivement monté dans server.js, avant les métriques", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");

  const posCorrelation = source.indexOf("app.use(requestIdMiddleware)");
  const posMetriques = source.indexOf("app.use(metrics.httpMiddleware)");

  assert.ok(
    posCorrelation !== -1,
    "`requestIdMiddleware` n'est monté nulle part : Tx Core ne corrèle plus ses " +
      "journaux à la requête d'origine (invariant 11)."
  );

  assert.ok(
    posCorrelation < posMetriques,
    "`requestIdMiddleware` est monté APRÈS les métriques : tout ce qui journalise " +
      "en amont — rejet 429, erreur de validation — perdra son identifiant, " +
      "c'est-à-dire précisément les lignes qu'on cherche en cas d'incident."
  );
});
