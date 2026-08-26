"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  INVALIDATION_CHANNEL,
  createBlacklistStore,
  publishInvalidation,
} = require("../src/services/risk/blacklistStore");

const { normalizeFor } = require("../src/services/risk/normalizeIdentifiers");

/**
 * Ce que ces tests protègent : la liste noire vivait dans un fichier JSON chargé
 * par `require()` une seule fois au démarrage. Inscrire un compte frauduleux
 * exigeait un commit et un déploiement, `require` mettait le fichier en cache,
 * et à plusieurs instances chacune gardait sa copie figée. Pendant ce temps, la
 * fraude se déplace en minutes.
 */

const entries = (...list) => list.map(([type, value]) => ({ type, value }));

/* ==========================================================================
 * NORMALISATION — CELUI QUI INSCRIT ET CELUI QUI COMPARE
 * ======================================================================== */

test("inscrire et comparer normalisent PAREIL", async () => {
  /**
   * Une liste noire n'a de valeur que si les deux côtés s'accordent. Si un
   * opérateur inscrit `Ada@Paynoval.COM` et que le contrôle compare
   * `ada@paynoval.com`, l'inscription ne bloque rien — et personne ne s'en
   * aperçoit, parce qu'une liste noire qui ne bloque pas ressemble en tout
   * point à une liste noire vide.
   */
  const store = createBlacklistStore({
    loadEntries: async () => entries(["email", "  Ada@Paynoval.COM "]),
  });
  await store.refresh();

  assert.equal(store.has("email", "ada@paynoval.com"), true);
  assert.equal(store.has("email", "ADA@PAYNOVAL.COM"), true);
});

test("un IBAN se compare sans ses espaces de présentation", async () => {
  const store = createBlacklistStore({
    loadEntries: async () => entries(["iban", "FR76 3000 1234"]),
  });
  await store.refresh();

  assert.equal(store.has("iban", "fr7630001234"), true);
});

test("un nom se compare sans ses accents", async () => {
  // Sinon il suffirait de retirer un tréma pour passer une liste de sanctions.
  const store = createBlacklistStore({
    loadEntries: async () => entries(["name", "Müller"]),
  });
  await store.refresh();

  assert.equal(store.has("name", "muller"), true);
});

test("un type inconnu n'inscrit rien et ne bloque rien", async () => {
  // Inscrire une valeur non normalisable créerait une entrée que le contrôle ne
  // retrouve jamais : mieux vaut refuser l'inscription.
  const store = createBlacklistStore({
    loadEntries: async () => entries(["adresseIP", "1.2.3.4"]),
  });
  await store.refresh();

  assert.equal(store.size(), 0);
  assert.equal(normalizeFor("adresseIP", "1.2.3.4"), "");
});

/* ==========================================================================
 * LA PROPRIÉTÉ DE SÛRETÉ CENTRALE
 * ======================================================================== */

test("une lecture RATÉE ne vide JAMAIS la liste", async () => {
  /**
   * ══ LE TEST LE PLUS IMPORTANT DE CE FICHIER ══
   *
   * Le réflexe — repartir d'une liste vide en cas d'erreur — est ici le pire
   * choix possible : une liste noire vide veut dire « tout le monde est
   * autorisé ». Une panne de base deviendrait une levée automatique et
   * silencieuse de tous les blocages antifraude, d'autant plus probable qu'un
   * attaquant a intérêt à la provoquer.
   *
   * Une liste noire un peu vieille protège ; une liste noire vide ne protège de
   * rien.
   */
  let doitEchouer = false;
  const store = createBlacklistStore({
    ttlMs: 0,
    loadEntries: async () => {
      if (doitEchouer) throw new Error("base indisponible");
      return entries(["email", "fraude@x.com"]);
    },
  });

  await store.refresh();
  assert.equal(store.has("email", "fraude@x.com"), true);

  doitEchouer = true;
  const r = await store.refresh({ force: true });

  assert.equal(r.ok, false);
  assert.equal(r.stale, true);
  assert.equal(store.has("email", "fraude@x.com"), true, "le blocage TIENT");
});

test("un chargement de forme invalide est traité comme une panne", async () => {
  // `null` au lieu d'un tableau viderait la liste si on lui faisait confiance.
  const store = createBlacklistStore({
    ttlMs: 0,
    loadEntries: async () => entries(["email", "fraude@x.com"]),
  });
  await store.refresh();

  const cassé = createBlacklistStore({
    ttlMs: 0,
    loadEntries: async () => null,
  });
  const r = await cassé.refresh();

  assert.equal(r.ok, false);
  assert.equal(store.has("email", "fraude@x.com"), true);
});

test("l'état périmé est VISIBLE, pas silencieux", async () => {
  // Un blocage appliqué depuis une liste vieille de trois jours doit se voir.
  const store = createBlacklistStore({
    ttlMs: 0,
    loadEntries: async () => {
      throw new Error("base indisponible");
    },
  });

  await store.refresh();
  const s = store.snapshot();

  assert.equal(s.stale, true);
  assert.match(s.lastError, /base indisponible/);
});

/* ==========================================================================
 * AMORÇAGE, TTL, PUB/SUB
 * ======================================================================== */

test("la liste statique sert de repli AVANT le premier chargement", async () => {
  /**
   * Sans amorçage, la première seconde d'exécution se ferait avec une liste
   * VIDE — c'est-à-dire sans aucun blocage, exactement au moment où le service
   * accepte ses premières requêtes.
   */
  const store = createBlacklistStore({
    seed: { emails: ["ancien@x.com"], countries: ["kp"] },
    loadEntries: async () => [],
  });

  assert.equal(store.has("email", "ancien@x.com"), true);
  assert.equal(store.has("country", "KP"), true);
});

test("le rechargement REMPLACE la liste — une levée doit prendre effet", async () => {
  // Fusionner au lieu de remplacer rendrait tout déblocage impossible : une
  // entrée levée resterait active jusqu'au redémarrage.
  let liste = entries(["email", "a@x.com"], ["email", "b@x.com"]);
  const store = createBlacklistStore({ ttlMs: 0, loadEntries: async () => liste });

  await store.refresh();
  assert.equal(store.has("email", "a@x.com"), true);

  liste = entries(["email", "b@x.com"]);
  await store.refresh({ force: true });

  assert.equal(store.has("email", "a@x.com"), false, "la levée a pris effet");
  assert.equal(store.has("email", "b@x.com"), true);
});

test("le TTL évite de relire la base à chaque virement", async () => {
  let appels = 0;
  const store = createBlacklistStore({
    ttlMs: 60000,
    loadEntries: async () => {
      appels += 1;
      return [];
    },
  });

  await store.refresh();
  await store.refresh();
  await store.refresh();

  assert.equal(appels, 1);
});

test("un message pub/sub force le rechargement", async () => {
  /**
   * Le TTL seul laisserait passer la fraude pendant sa fenêtre. L'instance qui
   * inscrit publie, les autres rechargent dans la seconde.
   */
  let liste = [];
  let appels = 0;

  const store = createBlacklistStore({
    ttlMs: 60000,
    loadEntries: async () => {
      appels += 1;
      return liste;
    },
  });
  await store.refresh();

  const handlers = [];
  const abonne = {
    async subscribe(ch) {
      assert.equal(ch, INVALIDATION_CHANNEL);
      return 1;
    },
    on(evt, fn) {
      if (evt === "message") handlers.push(fn);
    },
  };

  assert.equal(await store.subscribe(abonne), true);

  liste = entries(["email", "nouveau@x.com"]);
  await handlers[0](INVALIDATION_CHANNEL, "1");

  assert.equal(appels, 2);
  assert.equal(store.has("email", "nouveau@x.com"), true);
});

test("un message sur un AUTRE canal ne déclenche rien", async () => {
  let appels = 0;
  const store = createBlacklistStore({ ttlMs: 60000, loadEntries: async () => { appels += 1; return []; } });
  await store.refresh();

  const handlers = [];
  await store.subscribe({
    async subscribe() {},
    on: (e, f) => e === "message" && handlers.push(f),
  });
  await handlers[0]("un:autre:canal", "1");

  assert.equal(appels, 1);
});

test("sans pub/sub, le service fonctionne quand même", async () => {
  // Le TTL reste : la liste se rafraîchit, plus lentement. Refuser de démarrer
  // faute de Redis serait disproportionné.
  const store = createBlacklistStore({ loadEntries: async () => [] });

  assert.equal(await store.subscribe(null), false);
  assert.equal(await store.subscribe({}), false);
});

test("l'abonnement n'est ANNONCÉ qu'une fois le serveur confirmé", async () => {
  /**
   * ══ DÉFAUT MESURÉ SUR L'INFRASTRUCTURE RÉELLE (2026-08-26) ══
   *
   * Une première version appelait `subscribe()` sans attendre et rendait `true`
   * dans la foulée. Mesuré : l'abonnement met **plus de 700 ms** à
   * s'enregistrer, un client dupliqué devant d'abord établir sa propre
   * connexion — poignée de main TLS comprise. Pendant cette fenêtre, `publish`
   * touchait ZÉRO abonné alors que le démarrage journalisait « invalidation par
   * pub/sub ».
   *
   * Même famille de défaut qu'un index déclaré mais jamais construit : une
   * garantie affichée que le système ne porte pas.
   */
  const store = createBlacklistStore({ loadEntries: async () => [] });

  let enregistre = false;
  const lent = {
    async subscribe() {
      await new Promise((r) => setTimeout(r, 30));
      enregistre = true;
      return 1;
    },
    on() {},
  };

  const resultat = await store.subscribe(lent);

  assert.equal(enregistre, true, "on doit avoir attendu l'enregistrement");
  assert.equal(resultat, true);
});

test("un abonnement REFUSÉ est rapporté comme tel", async () => {
  // Annoncer un succès ici ferait croire à une invalidation instantanée alors
  // que seule la fenêtre de TTL protège.
  const store = createBlacklistStore({ loadEntries: async () => [] });

  const casse = {
    async subscribe() {
      throw new Error("connexion perdue");
    },
    on() {},
  };

  assert.equal(await store.subscribe(casse), false);
});

test("le gestionnaire est posé AVANT la souscription", async () => {
  // Dans l'autre ordre, un message arrivé entre les deux serait perdu.
  const store = createBlacklistStore({ loadEntries: async () => [] });
  const ordre = [];

  await store.subscribe({
    on: () => ordre.push("on"),
    async subscribe() {
      ordre.push("subscribe");
      return 1;
    },
  });

  assert.deepEqual(ordre, ["on", "subscribe"]);
});

test("publier une invalidation ne LÈVE jamais", async () => {
  assert.equal(await publishInvalidation(null), false);
  assert.equal(
    await publishInvalidation({
      publish: async () => {
        throw new Error("Redis absent");
      },
    }),
    false
  );
  assert.equal(await publishInvalidation({ publish: async () => 1 }), true);
});
