"use strict";

const crypto = require("crypto");

/**
 * IDENTIFIANT DE CORRÉLATION
 * ============================================================================
 *
 * ⚠️ COPIE À L'IDENTIQUE de `api-gateway/api-gateway/src/utils/requestId.js`,
 * comme le sont déjà `services/metrics.js`, `redisMetrics.js` et
 * `mongoPoolMetrics.js`. Toute correction se porte dans les trois.
 *
 * Portée ici le 2026-08-28, et c'est le service qui en avait le plus besoin :
 * **Tx Core n'avait aucun intergiciel de corrélation**. `x-request-id` n'y
 * apparaissait qu'en liste CORS et dans trois lectures ponctuelles
 * (`utils/idempotency.js`, `providerHttpClient.js`,
 * `internalPaymentsController.js`), qui retombaient sur une chaîne vide quand
 * l'appelant n'en fournissait pas.
 *
 * Autrement dit : **le moteur qui déplace l'argent ne reliait pas ses journaux
 * à la requête d'origine.** L'invariant 11 — toute mutation financière est
 * traçable par `requestId`, `transactionId`, `userId` et référence prestataire
 * — n'était donc pas tenu de bout en bout, précisément au maillon qui compte.
 *
 * La passerelle *relayait* `x-request-id` vers les services amont
 * (`app.js:612`, `app.js:743`) — mais uniquement si l'appelant en fournissait
 * un. Or le client mobile n'en envoie aucun, et c'est lui qui produit
 * l'essentiel du trafic. `X-Request-Id` figurait même déjà dans les en-têtes
 * CORS exposés : l'intention était posée, l'implémentation manquait.
 *
 * Conséquence concrète : quand un utilisateur signalait un virement échoué, il
 * n'existait aucun moyen de relier son incident aux journaux de la passerelle,
 * du backend et de Tx-Core. Il fallait chercher par horodatage et par adresse
 * e-mail, dans trois services, à la main.
 *
 * ═══ POURQUOI ON NE FAIT PAS CONFIANCE À L'EN-TÊTE REÇU ═══════════════════
 *
 * Un identifiant fourni par le client entre directement dans les journaux des
 * trois services. Accepté tel quel, il permettrait d'y injecter des retours à
 * la ligne — donc de forger de fausses lignes de journal — ou d'y déverser des
 * kilo-octets à chaque requête.
 *
 * On accepte donc l'identifiant du client (utile : il permet de corréler depuis
 * l'application jusqu'au serveur) mais **seulement s'il est inoffensif** :
 * caractères sûrs, longueur bornée. Sinon on en génère un. Le client n'est
 * jamais refusé pour autant — un mauvais identifiant ne doit pas coûter une
 * requête à l'utilisateur.
 */

/**
 * Caractères admis : ceux d'un UUID, d'un ULID ou d'un nanoid.
 * Ni espace, ni retour à la ligne, ni deux-points — donc rien qui puisse
 * fabriquer une fausse entrée dans un journal structuré.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Décide de l'identifiant d'une requête.
 *
 * @param {string|string[]|undefined} incoming Valeur de l'en-tête reçu.
 * @returns {{ id: string, source: "client" | "generated" }}
 *          `source` sert aux journaux : savoir si l'identifiant vient du client
 *          ou de nous change la façon de remonter une trace.
 */
function resolveRequestId(incoming) {
  // Un en-tête répété arrive sous forme de tableau. On ne retient que le
  // premier : concaténer deux valeurs produirait une chaîne qui n'identifie
  // rien.
  const raw = Array.isArray(incoming) ? incoming[0] : incoming;
  const candidate = typeof raw === "string" ? raw.trim() : "";

  if (SAFE_ID.test(candidate)) {
    return { id: candidate, source: "client" };
  }

  return { id: generateRequestId(), source: "generated" };
}

/**
 * `randomUUID` est disponible sur Node 20, la cible du dépôt. Le repli couvre
 * les environnements où l'API manquerait : mieux vaut un identifiant moins
 * élégant que pas d'identifiant du tout.
 */
function generateRequestId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return crypto.randomBytes(16).toString("hex");
}

/**
 * Middleware Express : garantit qu'une requête porte toujours un identifiant.
 *
 * Il est monté très tôt, avant les limiteurs et les proxys, pour que TOUT ce
 * qui journalise ensuite — y compris un rejet 429 ou une erreur de validation —
 * dispose du même identifiant.
 *
 * Trois effets :
 *   1. `req.id` — pour le code de la passerelle ;
 *   2. `req.headers["x-request-id"]` — pour que les proxys existants le
 *      relaient sans modification (`onProxyReq` lit cet en-tête) ;
 *   3. l'en-tête de réponse — pour que l'utilisateur puisse citer une référence
 *      au support. `X-Request-Id` est déjà dans les en-têtes CORS exposés, donc
 *      lisible par le navigateur.
 */
function requestIdMiddleware(req, res, next) {
  const { id, source } = resolveRequestId(req.headers["x-request-id"]);

  req.id = id;
  req.requestIdSource = source;
  req.headers["x-request-id"] = id;

  try {
    res.setHeader("X-Request-Id", id);
  } catch (_) {
    // En-têtes déjà envoyés : sans intérêt de faire échouer la requête.
  }

  return next();
}

module.exports = {
  requestIdMiddleware,
  resolveRequestId,
  generateRequestId,
  SAFE_ID,
};
