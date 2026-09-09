"use strict";

/**
 * ============================================================================
 * AUCUN COMMENTAIRE NE DOIT AFFIRMER QUE `autoIndex` EST ACTIF
 * ============================================================================
 *
 * ── Pourquoi ce test existe ─────────────────────────────────────────────────
 * `config/db.js` coupe `autoIndex` **pour toutes les connexions** du service.
 * Pourtant, cinq commentaires raisonnaient encore sur l'hypothèse inverse :
 *
 *   · `models/LedgerEntry.js`   — « `autoIndex` n'est pas désactivé sur cette connexion »
 *   · `scripts/ensure-ledger-indexes.js` — « `autoIndex` n'est désactivé nulle part »
 *   · `models/ProviderWebhookEvent.js`   — « tant que `autoIndex` est actif »
 *   · `models/Outbox.js` et `models/Transaction.js` — « désactivé **en
 *     production** », ce qui laisse croire qu'il serait actif ailleurs
 *
 * Ce ne sont pas des broutilles de rédaction. **Chacun justifiait une décision
 * technique par un fait faux.** Quelqu'un qui les lit conclut que déclarer un
 * index au schéma suffit à le poser — et livre une garantie que la base ne
 * porte pas. C'est exactement le mécanisme qui a laissé
 * `dedupKey_unique_partial` absent d'une base neuve pendant que l'audit
 * affichait « tous les index sont posés » (`BENCHMARKS.md` §8.2).
 *
 * Le §55 le dit : *un document d'intention qui ne correspond pas au code est
 * pire que pas de document*. Un commentaire est un document.
 *
 * ── Pourquoi la faute est revenue deux fois ─────────────────────────────────
 * Parce que rien ne la détectait. Corriger les cinq occurrences ne protège que
 * jusqu'à la prochaine. Ce test fige la propriété.
 *
 * ── Comment il tombe ────────────────────────────────────────────────────────
 * Écrire dans un commentaire que `autoIndex` est actif, ou qu'il n'est
 * désactivé qu'en production.
 *
 * Test **pur** : il lit des fichiers, n'ouvre aucune connexion.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const RACINE = path.join(__dirname, "..");

/**
 * Tournures qui affirment le contraire du code.
 * `config/db.js` est exclu : c'est lui qui POSE `autoIndex: false`, et son
 * en-tête explique légitimement ce qui se passait avant.
 */
const AFFIRMATIONS_FAUSSES = [
  /autoIndex[^\n]{0,40}(est|reste)\s+actif/i,
  /tant que\s+`?autoIndex`?\s+est\s+actif/i,
  /autoIndex[^\n]{0,40}n'est\s+pas\s+désactivé/i,
  /autoIndex[^\n]{0,40}n'est\s+désactivé\s+nulle\s+part/i,
  /autoIndex[^\n]{0,60}désactivé\s+en\s+production/i,
];

const EXCLUS = new Set([
  path.join("src", "config", "db.js"),
  path.join("test", "autoIndexClaims.test.js"),
]);

function fichiersJs(dossier) {
  const trouves = [];

  for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
    if (entree.name === "node_modules") continue;

    const complet = path.join(dossier, entree.name);
    if (entree.isDirectory()) trouves.push(...fichiersJs(complet));
    else if (entree.name.endsWith(".js")) trouves.push(complet);
  }

  return trouves;
}

test("aucun commentaire n'affirme que `autoIndex` est actif", () => {
  const fautes = [];

  for (const dossier of ["src", "scripts", "test", "test-concurrency"]) {
    const complet = path.join(RACINE, dossier);
    if (!fs.existsSync(complet)) continue;

    for (const fichier of fichiersJs(complet)) {
      const relatif = path.relative(RACINE, fichier);
      if (EXCLUS.has(relatif)) continue;

      const lignes = fs.readFileSync(fichier, "utf8").split("\n");

      for (let i = 0; i < lignes.length; i++) {
        /**
         * ⚠️ UNE CITATION N'EST PAS UNE AFFIRMATION.
         *
         * Corriger un commentaire faux se fait souvent en CITANT ce qu'il
         * disait — c'est ce qui permet à la session suivante de comprendre
         * pourquoi la justification a changé. La première version de ce test
         * signalait donc ses propres correctifs.
         *
         * Un test qui crie sur la correction qu'on vient d'apporter finit par
         * être désactivé, et emporte la protection avec lui. Les guillemets
         * français encadrent une citation : on les respecte.
         */
        if (/«[^»]*autoIndex[^»]*»/.test(lignes[i])) continue;

        for (const motif of AFFIRMATIONS_FAUSSES) {
          if (motif.test(lignes[i])) {
            fautes.push(`${relatif}:${i + 1}  ${lignes[i].trim().slice(0, 100)}`);
            break;
          }
        }
      }
    }
  }

  assert.deepEqual(
    fautes,
    [],
    "Un commentaire affirme que `autoIndex` est actif, ou qu'il ne serait coupé " +
      "qu'en production. Il est coupé pour TOUTES les connexions du service " +
      "(`src/config/db.js`). Un commentaire qui justifie une décision par un fait " +
      "faux conduit à déclarer un index au schéma en croyant qu'il sera posé — " +
      "et à livrer une garantie que la base ne porte pas.\n\n  " +
      fautes.join("\n  ")
  );
});

/**
 * Le contrôle ci-dessus ne vaut que si `autoIndex` est effectivement coupé.
 * Sans celui-ci, quelqu'un pourrait le réactiver et rendre les commentaires
 * corrects — en réintroduisant le danger qu'ils décrivaient.
 */
test("`autoIndex` et `autoCreate` sont bien coupés dans la configuration", () => {
  const db = fs.readFileSync(path.join(RACINE, "src", "config", "db.js"), "utf8");

  assert.match(
    db,
    /autoIndex:\s*false/,
    "`autoIndex` a été réactivé : une déclaration d'index égarée dans un schéma " +
      "partirait en production au premier redéploiement, sur l'instance et au " +
      "moment que personne n'a choisis."
  );

  assert.match(
    db,
    /autoCreate:\s*false/,
    "`autoCreate` a été réactivé : une faute de frappe sur un nom de modèle " +
      "fabriquerait une collection vide en production au lieu d'échouer bruyamment."
  );
});
