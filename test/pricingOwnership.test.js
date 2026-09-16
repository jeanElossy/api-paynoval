"use strict";

/**
 * ============================================================================
 * LES ROUTES DE TARIFICATION N'ACCEPTENT QUE LE CANAL INTERNE
 * ============================================================================
 *
 * ── Pourquoi ce fichier existe ──────────────────────────────────────────────
 *
 * CINQ fichiers de routes annonçaient en tête : « Verrouillé par
 * `test/pricingOwnership.test.js` ». Ce fichier N'EXISTAIT PAS (constaté le
 * 2026-09-16).
 *
 * Ce n'est pas une coquille de rédaction. Ces cinq en-têtes expliquent que
 * Tx-Core ne revérifie AUCUNE session — il fait confiance au canal — et que la
 * garde tient donc à deux choses : le jeton interne posé ici, et le contrôle de
 * rôle fait au bord. Annoncer un verrou inexistant invite le prochain lecteur à
 * déplacer l'un des deux en croyant l'autre protégé par un test.
 *
 * Le §55 le dit : un document d'intention qui ne correspond pas au code est
 * pire que pas de document. Une référence à un test absent en est la forme la
 * plus trompeuse, parce qu'elle se vérifie en une seconde et que personne ne le
 * fait.
 *
 * ── Ce que ce test garantit ─────────────────────────────────────────────────
 *
 * Toute route déclarée dans les fichiers de tarification passe par
 * `internalProtect`. Rien de plus : le contrôle de RÔLE appartient au bord, et
 * un test de ce dépôt ne peut pas en témoigner — le prétendre serait reproduire
 * la faute qu'on corrige.
 *
 * Test **pur** : il lit des fichiers, n'ouvre ni serveur ni connexion.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DOSSIER_ROUTES = path.join(__dirname, "..", "src", "routes");

/**
 * Les six surfaces du domaine des prix. `pricingRoutes` y figure : ses deux
 * points d'entrée lisent `x-user-id`, en-tête qui ne vaut QUE si le canal est
 * authentifié.
 */
const FICHIERS = Object.freeze([
  "pricingRoutes.js",
  "pricingRulesRoutes.js",
  "pricingChangeRequestsRoutes.js",
  "feesRoutes.js",
  "fxRulesRoutes.js",
  "exchangeRatesRoutes.js",
]);

/** Retire les commentaires : un exemple commenté ne doit pas compter. */
function sansCommentaires(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** `router.get("/x", internalProtect, ctrl.y)` → une déclaration de route. */
const DECLARATION = /router\.(get|post|put|patch|delete|all)\s*\(\s*([^)]*)\)/g;

function routesDeclarees(source) {
  const trouvees = [];
  let m;

  while ((m = DECLARATION.exec(source)) !== null) {
    trouvees.push({ verbe: m[1], arguments: m[2] });
  }

  return trouvees;
}

test("chaque fichier de tarification déclare au moins une route", () => {
  for (const fichier of FICHIERS) {
    const source = sansCommentaires(
      fs.readFileSync(path.join(DOSSIER_ROUTES, fichier), "utf8")
    );

    assert.ok(
      routesDeclarees(source).length > 0,
      `${fichier} ne déclare aucune route — le test ne protégerait rien.`
    );
  }
});

test("aucune route de tarification n'est servie sans le jeton interne", () => {
  const fautives = [];

  for (const fichier of FICHIERS) {
    const source = sansCommentaires(
      fs.readFileSync(path.join(DOSSIER_ROUTES, fichier), "utf8")
    );

    for (const route of routesDeclarees(source)) {
      if (!route.arguments.includes("internalProtect")) {
        fautives.push(`${fichier} → router.${route.verbe}(${route.arguments.trim()})`);
      }
    }
  }

  assert.deepEqual(
    fautives,
    [],
    "Route(s) de tarification sans `internalProtect`. Tx-Core ne revérifie " +
      "aucune session : sans ce jeton, un barème serait modifiable par " +
      "quiconque atteint le réseau privé.\n" +
      fautives.join("\n")
  );
});

test("le détecteur MORD sur une route laissée ouverte", () => {
  /**
   * Un garde-fou qui ne détecte rien passe toujours. On lui soumet une route
   * sans jeton : s'il ne la voit pas, il ne voyait rien non plus des vraies.
   */
  const faux = 'router.post("/", feesCtrl.createFee);';
  const routes = routesDeclarees(sansCommentaires(faux));

  assert.equal(routes.length, 1);
  assert.ok(!routes[0].arguments.includes("internalProtect"));
});

test("les barèmes restent en LECTURE SEULE hors du circuit de gouvernance", () => {
  /**
   * Toute évolution tarifaire doit passer par `/pricing-change-requests`, qui
   * impose un second valideur et écrit une version immuable. Rétablir un POST
   * ou un PATCH sur `/pricing-rules` contournerait la gouvernance en un appel.
   */
  const source = sansCommentaires(
    fs.readFileSync(path.join(DOSSIER_ROUTES, "pricingRulesRoutes.js"), "utf8")
  );

  const ecritures = routesDeclarees(source).filter((r) =>
    ["post", "put", "patch", "delete"].includes(r.verbe)
  );

  assert.deepEqual(
    ecritures,
    [],
    "Un verbe d'écriture est réapparu sur /pricing-rules : la gouvernance " +
      "tarifaire (second valideur, version immuable) se contournerait en un appel."
  );
});
