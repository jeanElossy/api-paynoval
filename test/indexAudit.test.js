"use strict";

/**
 * Tests de l'audit d'index. Aucune base : seules les fonctions pures sont
 * visées, et `auditerIndex` est exercée sur une connexion factice.
 *
 * Ce que ces tests protègent réellement : la décision de couper `autoIndex`.
 * Elle n'est défendable QUE si l'écart entre déclaré et posé est visible.
 * Si cet audit se met à taire un manque, la coupure devient une régression.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  empreinteIndex,
  comparerIndex,
  formaterRapport,
  auditerIndex,
} = require("../src/services/indexAudit");

/* -------------------------------------------------------------------------- */
/* empreinteIndex                                                             */
/* -------------------------------------------------------------------------- */

test("empreinte : clé simple", () => {
  assert.equal(empreinteIndex({ provider: 1 }), "provider:1");
});

test("empreinte : sens décroissant conservé", () => {
  assert.equal(empreinteIndex({ createdAt: -1 }), "createdAt:-1");
});

test("empreinte : L'ORDRE DES CHAMPS EST SIGNIFICATIF", () => {
  // Un index composé ne sert que ses préfixes de GAUCHE : {a,b} et {b,a} ne
  // servent pas les mêmes requêtes. Les confondre ferait passer un index
  // manquant pour présent — le défaut exact que cet audit doit attraper.
  assert.notEqual(empreinteIndex({ a: 1, b: 1 }), empreinteIndex({ b: 1, a: 1 }));
});

test("empreinte : entrée invalide ne lève pas", () => {
  assert.equal(empreinteIndex(null), "");
  assert.equal(empreinteIndex(undefined), "");
  assert.equal(empreinteIndex("nope"), "");
});

/* -------------------------------------------------------------------------- */
/* comparerIndex                                                              */
/* -------------------------------------------------------------------------- */

test("comparer : concordance parfaite", () => {
  const r = comparerIndex(["a:1", "b:1"], ["_id:1", "a:1", "b:1"]);
  assert.deepEqual(r.manquants, []);
  assert.deepEqual(r.enTrop, []);
});

test("comparer : un index déclaré et absent est signalé", () => {
  const r = comparerIndex(["a:1", "b:1"], ["_id:1", "a:1"]);
  assert.deepEqual(r.manquants, ["b:1"]);
});

test("comparer : _id n'est JAMAIS compté en trop", () => {
  // `_id` est créé par MongoDB, jamais déclaré par un schéma. Le compter en
  // trop mettrait un avertissement permanent sur chaque collection saine —
  // et un avertissement permanent finit par ne plus être lu.
  const r = comparerIndex([], ["_id:1"]);
  assert.deepEqual(r.enTrop, []);
});

test("comparer : un index en base et non déclaré est signalé, pas supprimé", () => {
  const r = comparerIndex(["a:1"], ["_id:1", "a:1", "vieux:1"]);
  assert.deepEqual(r.enTrop, ["vieux:1"]);
});

test("comparer : entrées vides ne lèvent pas", () => {
  const r = comparerIndex(undefined, undefined);
  assert.deepEqual(r.manquants, []);
  assert.deepEqual(r.enTrop, []);
});

/* -------------------------------------------------------------------------- */
/* formaterRapport                                                            */
/* -------------------------------------------------------------------------- */

test("rapport : concordance produit une ligne informative sans alerte", () => {
  const lignes = formaterRapport([]);
  assert.equal(lignes.length, 1);
  assert.ok(!lignes[0].includes("⚠️"));
});

test("rapport : un manque porte l'alerte ET nomme l'index", () => {
  const lignes = formaterRapport([{ modele: "Transaction", manquants: ["a:1"], enTrop: [] }]);
  assert.ok(lignes[0].includes("⚠️"));
  assert.ok(lignes[0].includes("Transaction"));
  assert.ok(lignes[0].includes("a:1"), "l'index doit être nommé, pas juste compté");
});

test("rapport : un manque dit sa CONSÉQUENCE, pas seulement son existence", () => {
  // Règle 6 des invariants : un journal de démarrage dit la vérité AVEC sa
  // conséquence. « index absent » n'aide personne ; « balaye la collection »
  // se traduit directement en décision.
  const lignes = formaterRapport([{ modele: "T", manquants: ["a:1"], enTrop: [] }]);
  assert.ok(/balaye/i.test(lignes[0]));
});

test("rapport : un surplus n'est PAS une alerte", () => {
  const lignes = formaterRapport([{ modele: "T", manquants: [], enTrop: ["x:1"] }]);
  assert.ok(!lignes[0].includes("⚠️"));
});

/* -------------------------------------------------------------------------- */
/* auditerIndex — connexion factice                                           */
/* -------------------------------------------------------------------------- */

function connexionFactice({ declares, reels, leve = false }) {
  return {
    models: {
      Faux: {
        schema: { indexes: () => declares.map((k) => [k]) },
        collection: {
          collectionName: "faux",
          indexes: async () => {
            if (leve) throw new Error("ns does not exist");
            return reels.map((key) => ({ key }));
          },
        },
      },
    },
  };
}

test("audit : détecte un index déclaré et absent", async () => {
  const ecarts = await auditerIndex(
    connexionFactice({ declares: [{ a: 1 }, { b: 1 }], reels: [{ _id: 1 }, { a: 1 }] })
  );
  assert.equal(ecarts.length, 1);
  assert.deepEqual(ecarts[0].manquants, ["b:1"]);
});

test("audit : collection absente n'est PAS un écart", async () => {
  // Avec `autoCreate: false`, une collection n'existe qu'à la première
  // écriture. Traiter son absence comme un écart d'index remplirait le
  // démarrage d'une base neuve de fausses alertes.
  const ecarts = await auditerIndex(connexionFactice({ declares: [{ a: 1 }], reels: [], leve: true }));
  assert.deepEqual(ecarts, []);
});

test("audit : NE LÈVE JAMAIS, même sur une connexion absurde", async () => {
  // Un audit qui casse le démarrage transformerait un outil d'observabilité
  // en panne. Priorité §60 : fiabilité avant observabilité.
  assert.deepEqual(await auditerIndex(null), []);
  assert.deepEqual(await auditerIndex({}), []);
  assert.deepEqual(await auditerIndex({ models: null }), []);
});

test("audit : journalise le manque en warn, la concordance en info", async () => {
  const vus = { warn: [], info: [] };
  const logger = { warn: (m) => vus.warn.push(m), info: (m) => vus.info.push(m) };

  await auditerIndex(connexionFactice({ declares: [{ a: 1 }], reels: [{ _id: 1 }] }), { logger });
  assert.equal(vus.warn.length, 1);

  vus.warn.length = 0;
  await auditerIndex(connexionFactice({ declares: [{ a: 1 }], reels: [{ _id: 1 }, { a: 1 }] }), { logger });
  assert.equal(vus.warn.length, 0, "une base saine ne doit produire AUCUN warn");
});

test("audit : ne crée ni ne supprime jamais d'index", async () => {
  // Garde structurelle : si quelqu'un ajoute un `createIndex` ici, il
  // réintroduit `autoIndex` sous un autre nom. Le test lit le source.
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../src/services/indexAudit.js"),
    "utf8"
  );
  assert.ok(!/\.createIndex\s*\(/.test(src), "indexAudit ne doit JAMAIS créer d'index");
  assert.ok(!/\.dropIndex\s*\(/.test(src), "indexAudit ne doit JAMAIS supprimer d'index");
});
