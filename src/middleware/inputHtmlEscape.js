"use strict";

/**
 * ============================================================================
 * ÉCHAPPEMENT DE « < » DANS LES ENTRÉES — ÉQUIVALENT EXACT DE xss-clean 0.1.4
 * ============================================================================
 *
 * Fichier IDENTIQUE à l'octet près dans Tx-Core, le backend et la passerelle
 * (épinglé par leurs tests). On le modifie dans les trois à la fois.
 *
 * `xss-clean` est abandonné (« Package no longer supported »). Ce module fait
 * EXACTEMENT ce qu'il faisait (lu dans sa source et dans celle de
 * `xss-filters#inHTMLData`), pour que rien ne change pour les données déjà
 * stockées ni pour les MOTS DE PASSE : à l'inscription et à la connexion, le
 * mot de passe passait déjà par cette transformation avant d'être haché — un
 * `<` devenu `&lt;`. Changer la transformation empêcherait ces comptes de se
 * connecter.
 *
 * La transformation, sur `req.body`, `req.query` et `req.params` :
 *   · un objet est sérialisé en JSON, chaque `<` devient `&lt;`, puis relu
 *     (les clés aussi ; les nombres et booléens restent tels quels) ;
 *   · une valeur simple devient du texte, chaque `<` devient `&lt;`, et les
 *     espaces de début et de fin sont retirés.
 *
 * Vecteurs produits par xss-clean avant son retrait :
 * `tests/fixtures/inputHtmlEscapeVectors.json` (ou `test/fixtures/…`).
 *
 * Suite prévue (chantier séparé) : la pratique moderne — ne plus modifier les
 * entrées, valider strictement et encoder à l'affichage (OWASP) — avec une
 * migration des mots de passe concernés.
 */

const LT = /</g;

/** `xss-filters#inHTMLData` : `undefined` → "undefined", `null` → "null", sinon texte avec `<` → `&lt;`. */
function inHTMLData(value) {
  return value === undefined ? "undefined" : value === null ? "null" : value.toString().replace(LT, "&lt;");
}

/** `xss-clean#clean`, à l'identique. */
function clean(data = "") {
  let isObject = false;
  let out = data;
  if (typeof out === "object") {
    out = JSON.stringify(out);
    isObject = true;
  }
  out = inHTMLData(out).trim();
  if (isObject) out = JSON.parse(out);
  return out;
}

/** Middleware Express : mêmes affectations que xss-clean. */
function inputHtmlEscape() {
  return function inputHtmlEscapeMiddleware(req, _res, next) {
    if (req.body) req.body = clean(req.body);
    if (req.query) req.query = clean(req.query);
    if (req.params) req.params = clean(req.params);
    next();
  };
}

module.exports = inputHtmlEscape;
module.exports.clean = clean;
module.exports.inHTMLData = inHTMLData;
