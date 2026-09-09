"use strict";

/**
 * LE DEVIS N'A PAS DE REPLI
 * ============================================================================
 *
 * `getGatewayBase()` retombait sur `https://api-gateway-8cgy.onrender.com` —
 * l'URL de la passerelle de PRODUCTION — quand `GATEWAY_URL` était absente.
 * Un poste de développement, un banc de charge ou un environnement mal
 * configuré demandaient donc leurs devis à la production, en silence.
 *
 * Ce n'est pas une question de secret : cette URL est en clair dans les bundles
 * clients. C'est la règle B.2 — le chemin de l'argent échoue en FERMETURE. Le
 * prix payé par l'utilisateur dépend de ce devis ; une valeur par défaut y
 * transforme une panne de configuration en tarification silencieusement fausse.
 *
 * Ces tests échouent si le repli revient, sous quelque forme que ce soit.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { getGatewayBase } = require("../src/services/transactions/shared/helpers");

/* -- la fermeture -------------------------------------------------------- */

test("lève quand GATEWAY_URL est absente — aucun repli", () => {
  const sauvegarde = process.env.GATEWAY_URL;
  delete process.env.GATEWAY_URL;
  try {
    assert.throws(
      () => getGatewayBase(undefined),
      (err) => {
        assert.equal(err.status, 503, "un défaut de configuration est un 503");
        assert.equal(err.code, "GATEWAY_URL_MISSING");
        return true;
      }
    );
  } finally {
    if (sauvegarde === undefined) delete process.env.GATEWAY_URL;
    else process.env.GATEWAY_URL = sauvegarde;
  }
});

test("lève sur une chaîne vide et sur des espaces — pas seulement sur undefined", () => {
  const sauvegarde = process.env.GATEWAY_URL;
  delete process.env.GATEWAY_URL;
  try {
    for (const valeur of ["", "   ", null]) {
      assert.throws(() => getGatewayBase(valeur), /GATEWAY_URL absente/);
    }
  } finally {
    if (sauvegarde === undefined) delete process.env.GATEWAY_URL;
    else process.env.GATEWAY_URL = sauvegarde;
  }
});

/**
 * Le test qui attrape la régression la plus probable : quelqu'un qui remet un
 * repli « juste pour le développement ». Aucune URL ne doit sortir de la
 * fonction quand rien n'est configuré — surtout pas celle de la production.
 */
test("ne rend JAMAIS l'URL de la passerelle de production par défaut", () => {
  const sauvegarde = process.env.GATEWAY_URL;
  delete process.env.GATEWAY_URL;
  try {
    let rendu = null;
    try {
      rendu = getGatewayBase(undefined);
    } catch {
      rendu = null;
    }
    assert.equal(
      rendu,
      null,
      "getGatewayBase a rendu une URL sans configuration : le repli est revenu"
    );
  } finally {
    if (sauvegarde === undefined) delete process.env.GATEWAY_URL;
    else process.env.GATEWAY_URL = sauvegarde;
  }
});

/* -- le chemin nominal, inchangé ----------------------------------------- */

test("ajoute /api/v1 quand le suffixe manque", () => {
  assert.equal(
    getGatewayBase("https://passerelle.example"),
    "https://passerelle.example/api/v1"
  );
});

test("ne double pas /api/v1 quand il est déjà là", () => {
  assert.equal(
    getGatewayBase("https://passerelle.example/api/v1"),
    "https://passerelle.example/api/v1"
  );
});

test("retire les barres obliques finales avant d'ajouter le suffixe", () => {
  assert.equal(
    getGatewayBase("https://passerelle.example///"),
    "https://passerelle.example/api/v1"
  );
});

test("prend process.env.GATEWAY_URL en second recours", () => {
  const sauvegarde = process.env.GATEWAY_URL;
  process.env.GATEWAY_URL = "https://depuis-env.example";
  try {
    assert.equal(
      getGatewayBase(undefined),
      "https://depuis-env.example/api/v1"
    );
  } finally {
    if (sauvegarde === undefined) delete process.env.GATEWAY_URL;
    else process.env.GATEWAY_URL = sauvegarde;
  }
});
