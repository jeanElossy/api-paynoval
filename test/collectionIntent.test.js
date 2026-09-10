"use strict";

/**
 * ============================================================================
 * ENCAISSEMENT ENTRANT — CE QUI DOIT RESTER VRAI
 * ============================================================================
 *
 * ── Le défaut de fond ───────────────────────────────────────────────────────
 *
 * Les cinq adaptateurs exposent `collect()`. AUCUN appelant n'existait dans le
 * dépôt : la capacité d'encaisser était écrite, testée unitairement, et morte.
 * C'est la raison de fond pour laquelle la contribution à une cagnotte par lien
 * public ne fonctionnait pas — l'URL fermée en 410 côté passerelle n'en était
 * que le symptôme visible.
 *
 * Tests **purs** : fonctions pures et lecture de fichiers. Aucune connexion,
 * aucun serveur.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const RACINE = path.resolve(__dirname, "..");

function lire(...segments) {
  return fs.readFileSync(path.join(RACINE, ...segments), "utf8");
}

function sansCommentaires(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const service = require("../src/services/collections/collectionService");

/* ══════════════════════════════════════════════════════════════════════════ */
/* 1. LE PAN N'ENTRE PAS                                                     */
/* ══════════════════════════════════════════════════════════════════════════ */

test("une donnée de carte en clair est refusée à toute profondeur", () => {
  const cas = [
    { cardNumber: "4242424242424242" },
    { source: { pan: "4242424242424242" } },
    { payer: { card: { cvc: "123" } } },
    { expMonth: 12 },
    { "exp-year": 2030 },
  ];

  for (const charge of cas) {
    assert.throws(
      () => service.assertAucuneDonneeCarte(charge),
      (err) => err.code === "RAW_CARD_DATA_REFUSED",
      `${JSON.stringify(charge)} aurait dû être refusé`
    );
  }

  assert.doesNotThrow(() =>
    service.assertAucuneDonneeCarte({ amount: 1000, cardToken: "tok_abc" })
  );
});

test("le message de refus ne contient JAMAIS la valeur du champ", () => {
  try {
    service.assertAucuneDonneeCarte({ cardNumber: "4242424242424242" });
    assert.fail("aurait dû lever");
  } catch (err) {
    assert.ok(!err.message.includes("4242"));
    assert.ok(err.message.includes("cardNumber"));
  }
});

test("l'adaptateur carte refuse un PAN et exige un jeton", async () => {
  const adaptateur = require("../src/providers/card/visaDirectAdapter");
  const avant = process.env.VISA_DIRECT_COLLECT_ENABLED;
  process.env.VISA_DIRECT_COLLECT_ENABLED = "true";

  try {
    const avecPan = await adaptateur.collect({
      pan: "4242424242424242",
      amount: 10,
      currency: "USD",
    });
    assert.equal(avecPan.errorCode, "RAW_CARD_DATA_REFUSED");

    const sansRien = await adaptateur.collect({ amount: 10, currency: "USD" });
    assert.equal(sansRien.errorCode, "CARD_TOKEN_REQUIRED");
  } finally {
    if (avant === undefined) delete process.env.VISA_DIRECT_COLLECT_ENABLED;
    else process.env.VISA_DIRECT_COLLECT_ENABLED = avant;
  }
});

test("l'adaptateur carte ne construit plus aucun champ de PAN", () => {
  const src = sansCommentaires(
    lire("src", "providers", "card", "visaDirectAdapter.js")
  );

  const collect = src.slice(src.indexOf("async function collect"));
  const payload = collect.slice(collect.indexOf("const payload = {"), collect.indexOf("if (cfg.mock)"));

  assert.ok(!payload.includes("pan:"), "le payload ne doit plus porter de PAN");
  assert.match(payload, /token:\s*cardToken/);
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* 2. LE RAIL NE SE DEVINE PAS                                               */
/* ══════════════════════════════════════════════════════════════════════════ */

test("la table des rails est close", () => {
  assert.deepEqual(Object.keys(service.RAILS).sort(), ["card", "mobilemoney"]);
  assert.deepEqual([...service.RAILS.mobilemoney].sort(), [
    "moov",
    "mtn",
    "orange",
    "wave",
  ]);
  assert.deepEqual([...service.RAILS.card], ["visa_direct"]);

  assert.deepEqual(service.assertRailEtPrestataire("mobilemoney", "WAVE"), {
    rail: "mobilemoney",
    provider: "wave",
  });

  /**
   * Le rail désigne le compte de compensation d'entrée
   * (`PROVIDER_INBOUND:<RAIL>`), donc le relevé prestataire auquel l'écriture
   * sera rapprochée. Un rail deviné rend le rapprochement impossible sans
   * qu'aucune erreur ne le signale (règle B.2).
   */
  assert.throws(
    () => service.assertRailEtPrestataire("mobilemoney", "flutterwave"),
    (e) => e.code === "UNKNOWN_PROVIDER"
  );
  assert.throws(
    () => service.assertRailEtPrestataire("bank", "sg"),
    (e) => e.code === "UNKNOWN_RAIL"
  );
  assert.throws(
    () => service.assertRailEtPrestataire("", ""),
    (e) => e.code === "UNKNOWN_RAIL"
  );
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* 3. IDEMPOTENCE                                                            */
/* ══════════════════════════════════════════════════════════════════════════ */

test("la référence est DÉRIVÉE de la clé d'idempotence, jamais tirée au hasard", () => {
  const a = service.referenceFromIdempotencyKey("cle-de-paiement-1");
  const b = service.referenceFromIdempotencyKey("cle-de-paiement-1");
  const c = service.referenceFromIdempotencyKey("cle-de-paiement-2");

  assert.equal(a, b, "deux tentatives de la même clé donnent la même référence");
  assert.notEqual(a, c);

  /**
   * Une référence aléatoire rendrait chaque rejeu unique — c'est-à-dire non
   * idempotent, présenté comme idempotent. Le `_id` du document en dérive, si
   * bien que le rejeu entre en collision sur la clé primaire AVANT même
   * d'atteindre l'index unique.
   */
  assert.equal(
    String(service.objectIdFromReference(a)),
    String(service.objectIdFromReference(b))
  );
});

test("une clé d'idempotence absente ou trop courte est REFUSÉE", () => {
  for (const cle of ["", "  ", "court"]) {
    assert.throws(
      () => service.referenceFromIdempotencyKey(cle),
      (e) => e.code === "IDEMPOTENCY_KEY_REQUIRED"
    );
  }
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* 4. UNE INTENTION N'EST PAS DE L'ARGENT                                    */
/* ══════════════════════════════════════════════════════════════════════════ */

test("l'initiation n'écrit RIEN au grand livre", () => {
  const src = sansCommentaires(
    lire("src", "services", "collections", "collectionService.js")
  );

  /**
   * Créer une intention ne déplace pas d'argent : le prestataire n'a encore
   * rien prélevé. Écrire au grand livre ici créerait de la monnaie à chaque
   * tentative de paiement, y compris celles que le payeur abandonne
   * (invariant 2, règle B.3).
   */
  for (const interdit of [
    "ledgerService",
    "postCagnotte",
    "LedgerEntry",
    "assertBalanced",
  ]) {
    assert.ok(
      !src.includes(interdit),
      `collectionService ne doit pas toucher au grand livre (${interdit})`
    );
  }
});

test("aucun appel prestataire n'est enfermé dans une transaction Mongo", () => {
  const src = sansCommentaires(
    lire("src", "services", "collections", "collectionService.js")
  );

  /**
   * ⚠️ CE TEST A ÉTÉ AFFÛTÉ LE 2026-09-10 — lire avant de le corriger.
   *
   * Il assertait `!src.includes("withTransaction")`. C'était un bon RACCOURCI
   * tant que ce fichier n'ouvrait aucune transaction : interdire le mot
   * revenait à interdire le danger.
   *
   * Le danger, lui, n'a jamais été la transaction : c'est l'APPEL RÉSEAU DEDANS.
   * `collect()` attend jusqu'à 30 s, contre une durée de vie de transaction
   * MongoDB de 60 s : la tenir ouverte pendant l'attente garde des verrous, et
   * au-delà le serveur la tue sous nos pieds — après que le prestataire a bien
   * reçu l'ordre.
   *
   * `confirmCollection` a désormais besoin d'une transaction, et pour une bonne
   * raison : elle doit écrire l'état ET son événement de domaine ensemble, sans
   * quoi un encaissement confirmé pourrait échapper définitivement à la
   * surveillance de conformité. Cette transaction ne touche pas au réseau.
   *
   * Le test vise donc maintenant le danger lui-même, et il est PLUS STRICT
   * qu'avant : il inspecte le contenu de chaque bloc transactionnel.
   */
  const DANGERS = [
    "adapter.",
    "collect(",
    "axios",
    "fetch(",
    "notifier",
    "http",
  ];

  /** Extrait le corps de chaque `withTransaction(...)` par équilibrage de parenthèses. */
  const blocs = [];
  let curseur = src.indexOf("withTransaction(");

  while (curseur !== -1) {
    let profondeur = 0;
    let i = src.indexOf("(", curseur);
    const debut = i;

    for (; i < src.length; i += 1) {
      if (src[i] === "(") profondeur += 1;
      else if (src[i] === ")") {
        profondeur -= 1;
        if (profondeur === 0) break;
      }
    }

    blocs.push(src.slice(debut, i));
    curseur = src.indexOf("withTransaction(", i);
  }

  for (const bloc of blocs) {
    for (const danger of DANGERS) {
      assert.ok(
        !bloc.includes(danger),
        `un appel réseau (« ${danger} ») est enfermé dans une transaction Mongo : ` +
          "les verrous seraient tenus pendant l'attente, et au-delà de 60 s le " +
          "serveur tuerait la transaction après que le prestataire a reçu l'ordre"
      );
    }
  }

  /**
   * Et la fonction QUI APPELLE le prestataire n'ouvre aucune transaction, sous
   * aucune forme. C'est la moitié que le raccourci d'origine protégeait, et
   * elle reste protégée.
   */
  const initiation = src.slice(
    src.indexOf("async function initiateCollection"),
    src.indexOf("async function confirmCollection")
  );

  assert.ok(initiation.length > 200, "découpage de `initiateCollection` à revoir");
  assert.ok(!initiation.includes("startTransaction"));
  assert.ok(!initiation.includes("withTransaction"));
});

test("un rejeu ne rappelle JAMAIS le prestataire", () => {
  const src = sansCommentaires(
    lire("src", "services", "collections", "collectionService.js")
  );

  const initiation = src.slice(src.indexOf("async function initiateCollection"));
  const posExistant = initiation.indexOf("if (existant)");
  const posCollect = initiation.indexOf("adapter.collect(");

  assert.ok(posExistant > -1 && posCollect > -1);
  assert.ok(
    posExistant < posCollect,
    "le retour anticipé sur rejeu doit précéder l'appel prestataire : " +
      "redemander un prélèvement déjà demandé prélève deux fois le payeur"
  );
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* 5. LA CONFIRMATION EST LE SEUL CHEMIN VERS `succeeded`                    */
/* ══════════════════════════════════════════════════════════════════════════ */

test("le webhook aiguille les encaissements AVANT le règlement de transaction", () => {
  const src = sansCommentaires(
    lire("src", "controllers", "providerWebhookController.js")
  );

  const posEncaissement = src.indexOf("await traiterCommeEncaissement(");
  const posReglement = src.indexOf("await settleExternalTransaction(req.body)");

  assert.ok(posEncaissement > -1, "la branche encaissement doit exister");
  assert.ok(posReglement > -1);
  assert.ok(
    posEncaissement < posReglement,
    "un rappel entrant n'a pas de Transaction : le laisser aller au règlement " +
      "produirait « transaction introuvable » et une réémission sans fin"
  );
});

test("l'aiguillage repose sur NOS données, pas sur la charge utile du tiers", () => {
  const src = sansCommentaires(
    lire("src", "controllers", "providerWebhookController.js")
  );

  const fonction = src.slice(
    src.indexOf("async function traiterCommeEncaissement"),
    src.indexOf("async function providerWebhookController")
  );

  /**
   * La branche est prise sur l'EXISTENCE d'une intention portant cette
   * référence. Un aiguillage confié à un champ que le prestataire renseigne
   * serait un aiguillage qu'un tiers contrôle.
   */
  assert.match(fonction, /confirmCollection\(/);
  assert.ok(!/charge\.(type|kind|purpose)\s*===/.test(fonction));
});

test("la confirmation est branchée APRÈS la vérification de signature", () => {
  const src = sansCommentaires(
    lire("src", "controllers", "providerWebhookController.js")
  );

  const posSignature = src.indexOf("parsed.verified !== true");
  const posClaim = src.indexOf("await claimEvent(");
  const posEncaissement = src.indexOf("await traiterCommeEncaissement(");

  assert.ok(posSignature > -1 && posClaim > -1 && posEncaissement > -1);
  assert.ok(posSignature < posClaim, "signature avant réservation d'événement");
  assert.ok(
    posClaim < posEncaissement,
    "réservation d'événement avant tout effet — sinon un rejeu double l'effet"
  );
});

test("un statut prestataire intermédiaire ne devient jamais `succeeded`", () => {
  const src = sansCommentaires(
    lire("src", "services", "collections", "collectionService.js")
  );

  const fonction = src.slice(src.indexOf("async function confirmCollection"));

  assert.match(fonction, /outcome:\s*"pending"/);
  assert.match(fonction, /reussi\s*&&|!reussi\s*&&\s*!echoue/);
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* 6. LA CONFIGURATION MANQUANTE ÉCHOUE EN FERMETURE                         */
/* ══════════════════════════════════════════════════════════════════════════ */

test("annoncer un encaissement sans configuration échoue en FERMETURE", () => {
  const src = sansCommentaires(
    lire("src", "services", "collections", "collectionNotifier.js")
  );

  for (const code of [
    "PRINCIPAL_URL_MISSING",
    "CAGNOTTE_GATEWAY_TOKEN_MISSING",
    "CAGNOTTE_ID_MISSING",
  ]) {
    assert.ok(src.includes(code), `${code} doit être levé, pas contourné`);
  }
});

test("l'annonce ne journalise ni la charge utile ni la réponse brute", () => {
  const src = sansCommentaires(
    lire("src", "services", "collections", "collectionNotifier.js")
  );

  /**
   * Elles portent le nom du contributeur — donnée personnelle (règle B.4).
   *
   * ⚠️ CE QU'ON INTERDIT, C'EST L'OBJET ENTIER, PAS SES CHAMPS NOMMÉS.
   * `donnees.code` est légitime et doit rester possible ; `donnees` tout court
   * déverse la réponse complète du backend dans le journal. La première
   * version de cette assertion ne faisait pas la différence et criait sur du
   * code sain — un test qui crie à tort finit désactivé, et emporte avec lui
   * la protection qu'il apportait.
   */
  const objetEntier = (nom) =>
    new RegExp(`logger\\.\\w+\\([^)]*(?<![.\\w$])${nom}\\b(?!\\s*\\.)`);

  assert.doesNotMatch(src, objetEntier("charge"));
  assert.doesNotMatch(src, objetEntier("donnees"));

  /** Le champ nommé, lui, doit rester présent : sinon l'assertion est vide. */
  assert.match(src, /code:\s*donnees\.code/);
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* 7. LA LIMITE DE DÉBIT VIT AILLEURS — ET IL FAUT LE SAVOIR                 */
/* ══════════════════════════════════════════════════════════════════════════ */

test("l'exemption de limite de Tx-Core suppose une limite à la passerelle", () => {
  const serveur = lire("src", "server.js");

  assert.ok(
    serveur.includes('req.path === "/api/v1/collections/initiate"'),
    "l'exemption doit rester explicite et nommée"
  );

  /**
   * Tx-Core ne voit que l'adresse de la passerelle : un compteur par IP y
   * fondrait tous les payeurs en un seul. La limite qui compte est donc portée
   * par la passerelle, qui voit la vraie adresse. Si elle disparaissait
   * là-bas, ce chemin n'aurait plus AUCUNE limite.
   */
  const limiteur = path.resolve(
    RACINE,
    "..",
    "api-gateway",
    "api-gateway",
    "src",
    "middlewares",
    "rateLimit.js"
  );

  if (!fs.existsSync(limiteur)) return; // dépôt voisin absent : on ne bloque pas

  assert.match(
    fs.readFileSync(limiteur, "utf8"),
    /publicCollectionLimiter/,
    "la passerelle doit porter le limiteur des encaissements publics"
  );
});
