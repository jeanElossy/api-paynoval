"use strict";

/**
 * ============================================================================
 * AUCUN SCORE DE RISQUE NE PEUT ÊTRE ALÉATOIRE
 * ============================================================================
 *
 * ── L'origine ───────────────────────────────────────────────────────────────
 *
 * `getMLScore` renvoyait `Math.random() * 0.4`, ou `0.92` au-delà d'un certain
 * montant. Un contrôle de conformité qui ne contrôlait rien, et dont le défaut
 * était INVISIBLE à l'exécution : le middleware répondait correctement, les
 * tests passaient.
 *
 * Le retrait avait été fait dans Tx-Core et **jamais reporté dans la
 * passerelle** — les deux `aml.js` recevaient chacun la moitié des correctifs.
 * C'est cette divergence qui a motivé la fusion du 2026-09-10 : il n'existe
 * plus qu'un seul AML, et ce garde le surveille.
 *
 * ── Ce qu'il vérifie vraiment ───────────────────────────────────────────────
 *
 * Qu'aucun hasard n'entre dans le calcul d'un score. Un score de risque doit
 * être REPRODUCTIBLE : lors d'un litige ou d'un contrôle, il faut pouvoir
 * réexpliquer pourquoi une transaction a été notée comme elle l'a été.
 * `Math.random()` rend cela impossible — ni explicable au client, ni
 * justifiable devant un régulateur.
 *
 * Test **pur** : il lit des fichiers, n'ouvre aucune connexion.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const RACINE = path.join(__dirname, "..");

const lire = (rel) => fs.readFileSync(path.join(RACINE, rel), "utf8");

/** On teste le code, pas ce qu'on en dit : commentaires retirés. */
const sansCommentaires = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const FICHIERS_AML = [
  "src/services/aml.js",
  "src/middleware/aml.js",
  "src/services/risk/riskScore.js",
  "src/services/risk/velocity.js",
  "src/services/risk/sanctionsScreening.js",
];

/**
 * ⚠️ TOUT `Math.random` N'EST PAS UN DÉFAUT, et un garde qui les interdit tous
 * se fait désactiver au premier faux positif — emportant avec lui la protection
 * qu'il apportait.
 *
 * `middleware/aml.js` en contient un LÉGITIME : il tire au sort LAQUELLE des
 * questions de sécurité de l'utilisateur sera posée. L'imprévisibilité y est la
 * propriété recherchée, l'exact inverse d'un score.
 *
 * Ce garde épingle donc l'usage connu par son contexte, et fait échouer TOUT
 * ajout. Un nouveau `Math.random` sur le chemin AML devra être justifié ici,
 * explicitement, pour passer.
 */
const USAGES_LEGITIMES = Object.freeze({
  "src/middleware/aml.js": [
    {
      motif: /const qIdx = Math\.floor\(Math\.random\(\) \* userQuestions\.length\);/,
      raison:
        "choix de la question de sécurité à poser — l'imprévisibilité est la " +
        "propriété voulue, ce n'est pas une notation",
    },
  ],
  "src/services/aml.js": [],
  "src/services/risk/riskScore.js": [],
  "src/services/risk/velocity.js": [],
  "src/services/risk/sanctionsScreening.js": [],
});

for (const rel of FICHIERS_AML) {
  test(`${rel} — aucun \`Math.random\` qui ne soit explicitement justifié`, () => {
    const src = sansCommentaires(lire(rel));

    let restant = src;

    for (const { motif } of USAGES_LEGITIMES[rel]) {
      assert.match(
        restant,
        motif,
        `L'usage légitime attendu a disparu de ${rel} — la liste ci-dessus est ` +
          `périmée, la relire avant de la corriger.`
      );
      restant = restant.replace(motif, "");
    }

    const orphelins = restant.match(/Math\.random\s*\(/g) || [];

    assert.deepEqual(
      orphelins,
      [],
      `${rel} contient ${orphelins.length} \`Math.random()\` non justifié(s). ` +
        `Si c'est un score de risque : un tirage au sort n'est pas une ` +
        `approximation en attendant mieux — il occupe la place du vrai contrôle ` +
        `et rend le score d'une transaction passée irreproductible. Si c'est un ` +
        `usage légitime, l'ajouter à USAGES_LEGITIMES avec sa raison.`
    );
  });

  test(`${rel} — \`getMLScore\` n'est pas réintroduit`, () => {
    const src = sansCommentaires(lire(rel));

    assert.ok(
      !/getMLScore\s*\(/.test(src),
      `${rel} réintroduit \`getMLScore\`. Le moteur de risque qui fait autorité ` +
        `est \`src/services/risk/riskScore.js\` — déterministe, à trois bandes, ` +
        `chaque point de score nommant son motif.`
    );
  });
}

/**
 * Le plafond par transaction, LUI, doit rester — c'était le seul contrôle réel
 * que le bloc supprimé prétendait porter. Sans cette assertion, quelqu'un
 * pourrait retirer le vrai plafond en croyant nettoyer le reste du faux score.
 */
test("le plafond par transaction survit au retrait du faux score", () => {
  const src = sansCommentaires(lire("src/middleware/aml.js"));

  assert.match(src, /AML_SINGLE_LIMIT/);
  assert.match(src, /amount\s*>\s*singleTxLimit/);
});

/**
 * ⚠️ LA MOITIÉ QUI MANQUAIT : L'AML NE DOIT PAS REVENIR AU BORD.
 *
 * Ce test vivait dans la passerelle et surveillait DEUX implémentations. Il n'y
 * en a plus qu'une. Ce qu'il surveille désormais, c'est qu'une seconde ne
 * reparaisse pas : c'est la divergence, pas le hasard, qui avait laissé le faux
 * score en place pendant des mois d'un seul côté.
 */
test("la passerelle n'a réintroduit aucun AML", () => {
  const bord = path.join(RACINE, "..", "api-gateway", "api-gateway");

  if (!fs.existsSync(bord)) {
    /**
     * Le dépôt voisin peut être absent d'un checkout isolé. On ne fait pas
     * échouer la suite pour ça — mais on ne prétend pas non plus avoir vérifié,
     * et le `skip` le dit dans le rapport.
     */
    test.skip("dépôt api-gateway absent de ce checkout");
    return;
  }

  for (const rel of [
    "src/middlewares/aml.js",
    "src/middlewares/publicCollectionAml.js",
    "src/services/aml.js",
    "src/services/sanctionsScreeningService.js",
    "src/tools/amlLimits.js",
  ]) {
    assert.ok(
      !fs.existsSync(path.join(bord, rel)),
      `${rel} est réapparu dans la passerelle — l'AML doit rester unique.`
    );
  }
});
