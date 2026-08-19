"use strict";

/**
 * Comparaison des tokens internes — logique PURE.
 *
 * Extrait de `middleware/internalAuth.js` pour une raison précise : ce
 * middleware charge `../config`, donc `dotenv-safe`, donc un `.env` complet.
 * Une logique de sécurité qu'on ne peut pas tester sans configuration est une
 * logique qu'on ne teste pas. Le dépôt applique déjà ce découpage
 * (`utils/userScopeQuery.js`, extrait du contrôleur pour la même raison).
 */

const crypto = require("crypto");

/**
 * Comparaison à temps constant.
 *
 * `crypto.timingSafeEqual` exige des tampons de même longueur — on complète
 * donc par des zéros avant de comparer, puis on vérifie séparément l'égalité
 * des longueurs. Comparer d'abord les longueurs révélerait, par le temps de
 * réponse, la taille du secret attendu.
 */
function timingSafeEqualStr(a, b) {
  const aBuf = Buffer.from(String(a || ""), "utf8");
  const bBuf = Buffer.from(String(b || ""), "utf8");

  const len = Math.max(aBuf.length, bBuf.length);
  const aPadded = Buffer.concat([aBuf, Buffer.alloc(len - aBuf.length)]);
  const bPadded = Buffer.concat([bBuf, Buffer.alloc(len - bBuf.length)]);

  return crypto.timingSafeEqual(aPadded, bPadded) && aBuf.length === bBuf.length;
}

/** Lit l'en-tête, quelle qu'en soit la casse. */
function extractInternalToken(req) {
  const headers = req?.headers || {};

  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "x-internal-token") {
      return String(headers[key] || "").trim();
    }
  }

  return "";
}

/**
 * Le token présenté correspond-il à l'un des tokens attendus ?
 *
 * Renvoie `false` si aucun token n'est attendu : une configuration absente ne
 * doit jamais valoir autorisation. C'est exactement la faute qui existait sur
 * le rate-limit — présence de l'en-tête prise pour preuve de légitimité.
 */
function matchesAnyToken(presented, expectedList = []) {
  const got = String(presented || "").trim();
  if (!got) return false;

  const expected = (Array.isArray(expectedList) ? expectedList : [expectedList])
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  if (!expected.length) return false;

  return expected.some((value) => timingSafeEqualStr(got, value));
}

module.exports = {
  timingSafeEqualStr,
  extractInternalToken,
  matchesAnyToken,
};
