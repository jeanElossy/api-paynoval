"use strict";

/**
 * ============================================================================
 * ACTIVATION EXPLICITE DES RAILS — LE DÉPLOIEMENT BLOQUÉ DU 2026-08-26
 * ============================================================================
 *
 * TX Core n'a pas pu démarrer sur Render : le contrôle exigeait que les SEPT
 * rails soient configurés en production, aucun contrat prestataire n'étant
 * encore signé.
 *
 * L'exigence était mal posée. PayNoval n'offrira jamais les sept rails à la
 * fois : **un rail qu'on ne propose pas n'est pas en panne, il est éteint.**
 *
 * ⚠️ CE QUE CES TESTS DOIVENT GARANTIR AVANT TOUT : que l'assouplissement du
 * DÉMARRAGE n'a rien assoupli sur le CHEMIN DE L'ARGENT. Un rail éteint doit
 * continuer de refuser tout ordre de paiement en production.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  describeProviderRails,
  formatProviderRailsReport,
  assertProviderRails,
  resolveEnabledRails,
  RAILS,
} = require("../src/providers/providerConfigReport");

const { resolveProviderMode } = require("../src/providers/providerMode");

const PROD = { NODE_ENV: "production" };

/* -------------------------------------------------------------------------- */
/* Déclaration des rails                                                      */
/* -------------------------------------------------------------------------- */

test("aucune déclaration rend null, pas un ensemble vide", () => {
  /**
   * Les deux situations sont différentes : `null` = « on n'exige rien » ;
   * un ensemble vide voudrait dire « on exige explicitement zéro rail », ce
   * qui n'a pas de sens et masquerait une variable mal orthographiée.
   */
  assert.equal(resolveEnabledRails({}), null);
  assert.equal(resolveEnabledRails({ PROVIDER_RAILS_ENABLED: "" }), null);
  assert.equal(resolveEnabledRails({ PROVIDER_RAILS_ENABLED: "   " }), null);
  assert.equal(resolveEnabledRails({ PROVIDER_RAILS_ENABLED: " , , " }), null);
});

test("la liste tolère espaces, casse et séparateurs", () => {
  const actives = resolveEnabledRails({ PROVIDER_RAILS_ENABLED: " Wave , ORANGE ,mtn" });

  assert.ok(actives.has("wave"));
  assert.ok(actives.has("orange"));
  assert.ok(actives.has("mtn"));
  assert.equal(actives.size, 3);
});

/* -------------------------------------------------------------------------- */
/* Le démarrage                                                               */
/* -------------------------------------------------------------------------- */

test("LE CAS RENDER — sans rail déclaré, le démarrage passe en production", () => {
  const rapport = describeProviderRails(PROD);

  assert.equal(rapport.ok, true);
  assert.equal(rapport.broken.length, 0);
  assert.equal(rapport.declared, false);
  assert.doesNotThrow(() => assertProviderRails(PROD));
});

test("un rail DÉCLARÉ mais non configuré bloque toujours le démarrage", () => {
  /**
   * La propriété de sûreté est intégralement conservée pour les rails qu'on
   * prétend offrir : promettre un moyen de paiement qu'on ne peut pas honorer
   * est pire que ne pas le proposer.
   */
  const env = { ...PROD, PROVIDER_RAILS_ENABLED: "wave" };

  assert.equal(describeProviderRails(env).ok, false);

  assert.throws(
    () => assertProviderRails(env),
    (err) => err.code === "PROVIDER_CONFIG_INVALID" && err.rails.includes("wave")
  );
});

test("un rail déclaré ET configuré démarre", () => {
  const env = {
    ...PROD,
    PROVIDER_RAILS_ENABLED: "wave",
    WAVE_BASE_URL: "https://api.wave.example",
    WAVE_API_KEY: "k",
  };

  assert.doesNotThrow(() => assertProviderRails(env));
  assert.equal(describeProviderRails(env).live.length, 1);
});

test("les rails NON déclarés n'apparaissent jamais en défaut", () => {
  /**
   * Sept erreurs permanentes au démarrage rendraient le journal illisible — et
   * un journal toujours rouge est un journal qu'on cesse de lire.
   */
  const env = {
    ...PROD,
    PROVIDER_RAILS_ENABLED: "wave",
    WAVE_BASE_URL: "https://api.wave.example",
  };

  const rapport = describeProviderRails(env);

  assert.equal(rapport.broken.length, 0);
  assert.equal(rapport.disabled.length, RAILS.length - 1);
});

test("un rail déclaré sous un nom inconnu n'active rien — et ne masque rien", () => {
  // Faute de frappe : `PROVIDER_RAILS_ENABLED=waves`. Aucun rail ne correspond,
  // donc rien n'est exigé — mais rien n'est non plus déclaré actif.
  const env = { ...PROD, PROVIDER_RAILS_ENABLED: "waves" };
  const rapport = describeProviderRails(env);

  assert.equal(rapport.enabled.length, 0);
  assert.equal(rapport.declared, true, "la déclaration existe, même si elle ne matche rien");
  assert.doesNotThrow(() => assertProviderRails(env));
});

/* -------------------------------------------------------------------------- */
/* ⚠️ LE CHEMIN DE L'ARGENT RESTE FERMÉ                                       */
/* -------------------------------------------------------------------------- */

test("UN RAIL ÉTEINT REFUSE TOUJOURS DE PAYER EN PRODUCTION", () => {
  /**
   * ═══ LE TEST QUI COMPTE ═══
   *
   * L'assouplissement porte sur le DÉMARRAGE, jamais sur l'exécution. Si ce
   * test tombe un jour, le service accepterait des ordres de virement sur un
   * rail incapable de payer : fonds réservés chez l'expéditeur, bénéficiaire
   * jamais payé, et accusé de réception envoyé à l'utilisateur.
   */
  assert.throws(
    () =>
      resolveProviderMode({
        provider: "wave",
        envPrefix: "WAVE",
        baseURL: "",
        env: PROD,
      }),
    (err) => /non configuré/i.test(err.message)
  );
});

test("un rail éteint refuse même quand un AUTRE rail est activé", () => {
  const env = {
    ...PROD,
    PROVIDER_RAILS_ENABLED: "wave",
    WAVE_BASE_URL: "https://api.wave.example",
  };

  // Orange n'est pas dans la liste : il ne bloque pas le démarrage, mais il
  // ne paie pas non plus.
  assert.throws(() =>
    resolveProviderMode({ provider: "orange", envPrefix: "ORANGE", baseURL: "", env })
  );
});

/* -------------------------------------------------------------------------- */
/* Le journal                                                                 */
/* -------------------------------------------------------------------------- */

test("l'absence de rail déclaré est ANNONCÉE, pas passée sous silence", () => {
  /**
   * C'est l'état normal tant qu'aucun contrat n'est signé, mais il a une
   * conséquence que personne ne doit découvrir devant un utilisateur.
   */
  const lignes = formatProviderRailsReport(describeProviderRails(PROD));
  const texte = lignes.join("\n");

  assert.match(texte, /AUCUN rail activé/);
  assert.match(texte, /PROVIDER_RAILS_ENABLED/);
  assert.match(texte, /503/, "la conséquence doit être nommée");
});

test("le journal nomme les rails activés", () => {
  const env = {
    ...PROD,
    PROVIDER_RAILS_ENABLED: "wave",
    WAVE_BASE_URL: "https://api.wave.example",
  };

  const texte = formatProviderRailsReport(describeProviderRails(env)).join("\n");

  assert.match(texte, /rails activés : wave/);
});

test("le journal ne divulgue ni clé ni URL complète", () => {
  /**
   * Une URL de base porte parfois un jeton dans son chemin. On journalise le
   * NOM du rail, son MODE et la RAISON — rien d'autre.
   */
  const env = {
    ...PROD,
    PROVIDER_RAILS_ENABLED: "wave",
    WAVE_BASE_URL: "https://api.wave.example/v1/tok_SECRET123",
    WAVE_API_KEY: "sk_live_TRESSECRET",
  };

  const texte = formatProviderRailsReport(describeProviderRails(env)).join("\n");

  assert.ok(!texte.includes("tok_SECRET123"), "l'URL ne doit pas sortir");
  assert.ok(!texte.includes("sk_live_TRESSECRET"), "la clé ne doit pas sortir");
});
