"use strict";

/**
 * ============================================================================
 * DEUX ROUTEURS MONTÉS SUR LE MÊME PRÉFIXE NE DÉCLARENT PAS LE MÊME SOUS-CHEMIN
 * ============================================================================
 *
 * ── Le défaut que ce test empêche de revenir ────────────────────────────────
 *
 * `cagnotteExternalSettlementRoutes` déclarait `/participation/settle` et était
 * monté sur `/api/v1/cagnotte` — exactement comme `cagnotteSettlementRoutes`,
 * monté quelques lignes PLUS HAUT avec le même sous-chemin.
 *
 * Express rend la main au PREMIER routeur qui apparie. Le second n'était donc
 * atteignable par aucune requête, et tout appel destiné au règlement d'une
 * participation externe tombait sur le règlement authentifié — lequel exige
 * `userId` et `payer`, qui n'existent pas quand le payeur n'a pas de compte.
 *
 * ── Pourquoi rien ne le signalait ───────────────────────────────────────────
 *
 * `app.use` n'a aucune notion de collision : les deux routeurs se chargent, le
 * démarrage est propre, et les journaux annoncent fièrement les deux chemins.
 * Le commentaire de `server.js` annonçait même le bon chemin — c'est le fichier
 * de route qui en déclarait un autre. Un commentaire n'est pas une route.
 *
 * Le défaut ne se serait manifesté qu'au premier encaissement par lien public,
 * en 400 sur un champ manquant : le moment où le diagnostic coûte le plus cher,
 * et où la ressemblance des deux chemins oriente vers la mauvaise piste.
 *
 * ── Comment il tombe ────────────────────────────────────────────────────────
 *
 * Remettre `/participation/settle` dans le routeur externe : l'assertion cite
 * le chemin complet en conflit et les deux fichiers qui se le disputent.
 *
 * Test **pur** : lecture de fichiers, aucune connexion, aucun serveur.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const RACINE = path.resolve(__dirname, "..");
const SERVEUR = fs.readFileSync(path.join(RACINE, "src", "server.js"), "utf8");

function sansCommentaires(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const SERVEUR_NU = sansCommentaires(SERVEUR);

/** `const x = require("./routes/y")` → { x: "y" } */
function routeursRequis(src) {
  const table = new Map();
  const motif = /\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*require\(\s*["']\.\/routes\/([^"']+)["']\s*\)/g;

  let m;
  while ((m = motif.exec(src)) !== null) table.set(m[1], m[2]);
  return table;
}

/**
 * `app.use("/prefixe", middleware, routeur)` → { prefixe, identifiant }.
 * On ne retient que le DERNIER identifiant de l'appel : c'est le routeur, les
 * précédents sont des intergiciels (`protect`, un limiteur…).
 */
function montages(src) {
  const trouves = [];
  const motif = /app\.use\(\s*(["'])([^"']+)\1\s*,\s*([^)]*)\)/g;

  let m;
  while ((m = motif.exec(src)) !== null) {
    const prefixe = m[2];
    const args = m[3]
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);

    const dernier = args[args.length - 1];
    if (dernier && /^[A-Za-z0-9_$]+$/.test(dernier)) {
      trouves.push({ prefixe, identifiant: dernier });
    }
  }
  return trouves;
}

const VERBES = "get|post|put|patch|delete|options|head|all|use";

/** Sous-chemins déclarés par un fichier de route. */
function sousChemins(fichierAbsolu) {
  const src = sansCommentaires(fs.readFileSync(fichierAbsolu, "utf8"));
  const motif = new RegExp(
    `\\brouter\\s*\\.\\s*(?:${VERBES})\\s*\\(\\s*(["'])([^"']*)\\1`,
    "g"
  );

  const vus = new Set();
  let m;
  while ((m = motif.exec(src)) !== null) vus.add(m[2]);
  return [...vus];
}

function normaliser(prefixe, sousChemin) {
  const complet = `${prefixe.replace(/\/+$/, "")}/${String(sousChemin).replace(/^\/+/, "")}`;
  return complet.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1");
}

/**
 * Un paramètre nommé n'apparie pas par son nom : `/:rail` et `/:operateur`
 * décrivent le même segment. On compare donc des FORMES, pas des libellés.
 */
function forme(chemin) {
  return chemin.replace(/:[A-Za-z0-9_$]+/g, ":param");
}

test("aucun sous-chemin n'est déclaré deux fois sur un même préfixe de montage", () => {
  const requis = routeursRequis(SERVEUR_NU);
  const parChemin = new Map();

  for (const { prefixe, identifiant } of montages(SERVEUR_NU)) {
    const relatif = requis.get(identifiant);
    if (!relatif) continue;

    const base = path.join(RACINE, "src", "routes", relatif);
    const fichier = fs.existsSync(base) ? base : `${base}.js`;
    if (!fs.existsSync(fichier)) continue;

    for (const sc of sousChemins(fichier)) {
      const cle = forme(normaliser(prefixe, sc));
      if (!parChemin.has(cle)) parChemin.set(cle, new Set());
      parChemin.get(cle).add(path.relative(RACINE, fichier));
    }
  }

  const conflits = [...parChemin.entries()]
    .filter(([, fichiers]) => fichiers.size > 1)
    .map(([chemin, fichiers]) => `${chemin} ← ${[...fichiers].join(" ET ")}`);

  assert.deepEqual(
    conflits,
    [],
    "Deux fichiers de route se disputent le même chemin. Le second est " +
      "INATTEIGNABLE : Express rend la main au premier routeur monté.\n" +
      conflits.join("\n")
  );
});

test("le règlement d'une participation externe a son chemin propre", () => {
  const src = fs.readFileSync(
    path.join(RACINE, "src", "routes", "cagnotteExternalSettlementRoutes.js"),
    "utf8"
  );

  assert.match(src, /["']\/external-participation\/settle["']/);
  assert.doesNotMatch(
    sansCommentaires(src),
    /router\s*\.\s*post\(\s*["']\/participation\/settle["']/,
    "Ce sous-chemin appartient à cagnotteSettlementRoutes, monté avant."
  );
});

test("le client du backend principal vise exactement ce chemin", () => {
  /**
   * La collision n'est visible que des DEUX côtés à la fois : le routeur doit
   * déclarer le chemin, et l'appelant doit viser le même. Vérifier un seul côté
   * laisse passer la moitié des façons de casser la liaison.
   */
  const client = path.resolve(
    RACINE,
    "..",
    "paynoval-backend",
    "services",
    "cagnotteTxCoreService.js"
  );

  if (!fs.existsSync(client)) return; // dépôt voisin absent : on ne bloque pas.

  const src = fs.readFileSync(client, "utf8");
  assert.match(src, /["']\/api\/v1\/cagnotte\/external-participation\/settle["']/);
});
