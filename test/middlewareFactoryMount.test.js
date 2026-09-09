"use strict";

/**
 * ============================================================================
 * UNE FABRIQUE D'INTERGICIEL S'APPELLE — ELLE NE SE MONTE PAS
 * ============================================================================
 *
 * ── Le défaut, et ce qu'il a coûté ──────────────────────────────────────────
 * `middleware/internalAuth.js` exporte une **fabrique** :
 *
 *     module.exports = function requireInternalAuth(scope = 'any') {
 *       return function internalAuthMiddleware(req, res, next) { … };
 *     };
 *
 * `internalPaymentsRoutes.js` écrivait `router.use(requireInternalAuth)` —
 * la fabrique elle-même. Express l'appelle alors avec `(req, res, next)` : elle
 * s'exécute avec `scope = req`, **rend une fonction**, et n'appelle jamais
 * `next()`.
 *
 * Deux conséquences, et la seconde est pire que la première :
 *
 *   1. **Toute requête sur la route pendait indéfiniment.** Mesuré le
 *      2026-08-28 : GET, POST, avec ou sans corps, avec ou sans jeton — aucune
 *      réponse. Une autre route `/api/v1` inexistante répondait 404 en 22 ms.
 *      Après correctif : 401 en **4 ms**, 400 en **6 ms**, transfert en 240 ms.
 *   2. **L'authentification interne n'était jamais appliquée.** Qui aurait
 *      corrigé le blocage sans voir ce point aurait ouvert la route SANS
 *      contrôle de jeton.
 *
 * C'est l'endpoint où aboutit `POST /api/v1/pay` du backend principal, qui
 * réessaie **trois fois** — chaque tentative attendait le délai complet.
 *
 * ── Pourquoi rien ne l'a détecté ────────────────────────────────────────────
 * Les deux formes sont du JavaScript parfaitement valide. Aucun linter, aucun
 * type, aucun test unitaire ne les distingue : la faute ne se voit qu'à
 * l'exécution, et elle se manifeste par une ABSENCE — pas d'erreur, pas de
 * journal, juste une requête qui ne revient jamais. `internalReferralRoutes.js`
 * l'appelle correctement (`requireInternalAuth("principal")`) : deux usages du
 * même module dans le même dépôt, un juste, un faux.
 *
 * ── Comment ce test tombe ───────────────────────────────────────────────────
 * Remettre `router.use(requireInternalAuth)` sans les parenthèses.
 *
 * Test **pur** : il lit des sources, n'ouvre aucune connexion.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROUTES = path.join(__dirname, "..", "src", "routes");

/**
 * Fabriques connues du dépôt : un module dont l'export est une fonction qui
 * REND l'intergiciel. Toute nouvelle fabrique doit être ajoutée ici — c'est le
 * prix d'un contrôle qui ne peut pas deviner l'intention d'une fonction.
 */
const FABRIQUES = ["requireInternalAuth"];

function fichiersRoutes() {
  return fs
    .readdirSync(ROUTES)
    .filter((n) => n.endsWith(".js"))
    .map((n) => path.join(ROUTES, n));
}

test("aucune fabrique d'intergiciel n'est montée sans être appelée", () => {
  const fautes = [];

  for (const fichier of fichiersRoutes()) {
    const lignes = fs.readFileSync(fichier, "utf8").split("\n");

    for (let i = 0; i < lignes.length; i++) {
      const nue = lignes[i].trim();
      if (nue.startsWith("*") || nue.startsWith("//") || nue.startsWith("/*")) continue;

      for (const fabrique of FABRIQUES) {
        /**
         * On cherche la fabrique passée comme VALEUR à `use`/`get`/`post`/… —
         * c'est-à-dire suivie d'une virgule ou d'une parenthèse fermante, et
         * jamais d'une parenthèse ouvrante.
         */
        const monteeSansAppel = new RegExp(
          `\\.(use|all|get|post|put|patch|delete)\\s*\\([^)]*\\b${fabrique}\\s*[,)]`
        );

        if (monteeSansAppel.test(nue)) {
          fautes.push(
            `${path.basename(fichier)}:${i + 1}  ${nue.slice(0, 100)}`
          );
        }
      }
    }
  }

  assert.deepEqual(
    fautes,
    [],
    "Une FABRIQUE d'intergiciel est montée sans être appelée. Express l'exécute " +
      "avec (req, res, next), elle rend une fonction et n'appelle JAMAIS `next()` : " +
      "toute requête sur la route pend indéfiniment, ET le contrôle qu'elle porte " +
      "n'est jamais appliqué. Écrire `" + FABRIQUES[0] + "('any')`, avec les " +
      "parenthèses.\n\n  " + fautes.join("\n  ")
  );
});

/**
 * Le contrôle ci-dessus suppose que `internalAuth` est bien une fabrique. Sans
 * ce second test, transformer le module en intergiciel direct rendrait le
 * premier faux — il exigerait alors des parenthèses là où il n'en faut plus.
 */
test("`internalAuth` est bien une fabrique, et son intergiciel a la bonne arité", () => {
  const requireInternalAuth = require("../src/middleware/internalAuth");

  assert.equal(typeof requireInternalAuth, "function");

  const intergiciel = requireInternalAuth("any");

  assert.equal(
    typeof intergiciel,
    "function",
    "`internalAuth` ne rend plus un intergiciel : le contrôle de montage " +
      "ci-dessus est devenu faux et doit être revu."
  );

  assert.equal(
    intergiciel.length,
    3,
    "l'intergiciel rendu n'a pas la signature `(req, res, next)` : Express ne " +
      "le traiterait pas comme un intergiciel ordinaire."
  );

  assert.notEqual(
    requireInternalAuth.length,
    3,
    "la FABRIQUE a maintenant une arité de 3 : montée par erreur, Express la " +
      "prendrait pour un intergiciel sans que rien ne le signale."
  );
});
