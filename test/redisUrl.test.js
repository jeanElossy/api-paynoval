"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { diagnoseRedisError } = require("../src/services/redisUrl");

/**
 * Ce fichier ne couvre que le DIAGNOSTIC. L'analyse d'URL elle-même est
 * verrouillée par `paynoval-backend/tests/redisUrl.test.js` (21 tests) : les
 * trois copies du module sont identiques, et une seule suite suffit à protéger
 * la partie commune.
 */
/* ==========================================================================
 * DIAGNOSTIC — TRANSFORMER UN SILENCE EN PHRASE UTILE
 * ======================================================================== */

test("une poignée de main TLS ratée nomme le VRAI coupable", () => {
  /**
   * ══ TROUVÉ EN CONDITIONS RÉELLES LE 2026-08-26 ══
   *
   * `REDIS_URL` déclarait `rediss://` et `REDIS_TLS=true` sur un point d'accès
   * qui répond EN CLAIR. Le client ne se connectait donc JAMAIS, et la
   * limitation de débit comptait en mémoire — par instance, donc multipliée par
   * leur nombre. Le message d'origine, « wrong version number », ne désigne pas
   * le coupable, et le service continuait sans que personne s'en aperçoive.
   */
  const err = new Error(
    "error:0A00010B:SSL routines:tls_validate_record_header:wrong version number"
  );
  const texte = diagnoseRedisError(err, "rediss://exemple:6379");

  assert.match(texte, /EN CLAIR/);
  assert.match(texte, /rediss:\/\//);
  assert.match(texte, /activer TLS côté/);
  assert.match(texte, /en mémoire/);
});

test("le diagnostic ne divulgue AUCUN secret", () => {
  /**
   * Il reçoit l'URL complète — mot de passe compris. La journaliser telle
   * quelle mettrait le mot de passe Redis dans les journaux, ce que la
   * politique du projet interdit explicitement.
   */
  const url = "rediss://default:motdepasse-tres-secret@cache.exemple.io:10130";
  const err = new Error("wrong version number");
  const texte = diagnoseRedisError(err, url);

  assert.ok(!texte.includes("motdepasse-tres-secret"));
  assert.ok(!texte.includes("cache.exemple.io"));
});

test("chaque panne courante a sa phrase actionnable", () => {
  const cas = [
    [new Error("WRONGPASS invalid username-password pair"), /REDIS_PASSWORD/],
    [new Error("connect ECONNREFUSED 10.0.0.1:6379"), /injoignable/],
    [new Error("getaddrinfo ENOTFOUND cache.exemple.io"), /injoignable/],
    [new Error("self signed certificate in certificate chain"), /Certificat TLS/],
  ];

  for (const [err, attendu] of cas) {
    assert.match(diagnoseRedisError(err, "rediss://x:1"), attendu);
  }
});

test("ne PAS conseiller de désactiver la vérification du certificat", () => {
  // Le conseil le plus courant sur internet, et le plus dangereux : accepter
  // n'importe quel certificat revient à accepter n'importe quel interlocuteur.
  const texte = diagnoseRedisError(
    new Error("unable to verify the first certificate"),
    "rediss://x:1"
  );

  assert.match(texte, /ne PAS désactiver/);
});

test("une panne inconnue le dit, plutôt que d'inventer", () => {
  // Une explication fausse est pire qu'un aveu d'ignorance : elle envoie
  // chercher au mauvais endroit.
  const texte = diagnoseRedisError(new Error("quelque chose d'inattendu"), "redis://x:1");

  assert.match(texte, /non reconnue/);
});
