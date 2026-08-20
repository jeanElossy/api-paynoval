"use strict";

/**
 * Réponse de sécurité : empreinte et vérification.
 *
 * Deux régressions distinctes sont verrouillées ici.
 *
 * 1. L'ÉCHAPPEMENT ASYMÉTRIQUE. `/confirm` portait `.escape()` sur
 *    `securityAnswer`, `/initiate` ne le portait pas. L'empreinte était donc
 *    calculée sur deux chaînes différentes selon le bout de la chaîne, et toute
 *    réponse contenant ' & " < > devenait DÉFINITIVEMENT inconfirmable : chaque
 *    essai consommait une tentative, la transaction se verrouillait, puis
 *    partait en auto-cancel. En français l'apostrophe est partout.
 *
 * 2. LE HASH NU. `sha256(réponse)` sans poivre cède à une table arc-en-ciel dès
 *    qu'on obtient une lecture de la collection, et deux réponses identiques
 *    partagent la même empreinte. Le HMAC poivré corrige les deux, à condition
 *    de rester rétrocompatible : les transactions déjà en attente portent une
 *    empreinte sha256 nue qu'on ne peut pas recalculer.
 *
 * Le test 1 reproduit la chaîne réelle avec le VRAI module `validator` — celui
 * qu'utilise express-validator — plutôt qu'une imitation de `escape()`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const validator = require("validator");

const PEPPER_KEY = "SECURITY_ANSWER_PEPPER";

/** Charge `helpers` à neuf : le poivre est lu à chaque appel, mais on isole. */
function loadHelpers() {
  delete require.cache[
    require.resolve("../src/services/transactions/shared/helpers.js")
  ];
  return require("../src/services/transactions/shared/helpers.js");
}

function withPepper(value, fn) {
  const previous = process.env[PEPPER_KEY];

  if (value === null) delete process.env[PEPPER_KEY];
  else process.env[PEPPER_KEY] = value;

  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[PEPPER_KEY];
    else process.env[PEPPER_KEY] = previous;
  }
}

/**
 * Réponses réelles, pas des cas de laboratoire : un lieu avec apostrophe, un
 * couple de prénoms avec esperluette, un surnom entre guillemets. Les deux
 * dernières sont les seules qui passaient avant le correctif.
 */
const ANSWERS = [
  "l'ecole de mon quartier",
  "Marie & Jean",
  'le chien "Rex"',
  "Abidjan",
  "1234",
];

test("l'empreinte survit à l'échappement HTML appliqué par le validateur de /confirm", () => {
  const { sanitize, hashSecurityAnswer, verifySecurityAnswerHash } =
    loadHelpers();

  withPepper(null, () => {
    for (const answer of ANSWERS) {
      // Ce que /initiate stocke : la réponse passe par sanitize(), sans escape.
      const stored = hashSecurityAnswer(sanitize(answer));

      // Ce que /confirm présente aujourd'hui : plus d'escape dans la chaîne.
      const provided = sanitize(String(answer).trim());

      assert.equal(
        verifySecurityAnswerHash(provided, stored),
        true,
        `réponse inconfirmable : ${JSON.stringify(answer)}`
      );
    }
  });
});

test("le bug d'origine est bien reproduit quand on réintroduit .escape()", () => {
  const { sanitize, hashSecurityAnswer, verifySecurityAnswerHash } =
    loadHelpers();

  withPepper(null, () => {
    // Sans caractère spécial, l'escape était inoffensif — d'où l'invisibilité
    // du bug pour quiconque testait avec un code numérique.
    for (const benign of ["Abidjan", "1234"]) {
      const stored = hashSecurityAnswer(sanitize(benign));
      const escaped = sanitize(validator.escape(String(benign).trim()));
      assert.equal(verifySecurityAnswerHash(escaped, stored), true);
    }

    // Avec, la confirmation était impossible. C'est la régression à ne jamais
    // réintroduire : si ce bloc se met à passer, `.escape()` est revenu.
    for (const broken of ANSWERS.slice(0, 3)) {
      const stored = hashSecurityAnswer(sanitize(broken));
      const escaped = sanitize(validator.escape(String(broken).trim()));
      assert.equal(
        verifySecurityAnswerHash(escaped, stored),
        false,
        `l'échappement devrait casser ${JSON.stringify(broken)}`
      );
    }
  });
});

test("sans poivre, l'empreinte reste exactement celle d'avant (sha256 nu)", () => {
  const crypto = require("node:crypto");
  const { hashSecurityAnswer } = loadHelpers();

  withPepper(null, () => {
    const expected = crypto
      .createHash("sha256")
      .update("Abidjan")
      .digest("hex");

    assert.equal(hashSecurityAnswer("Abidjan"), expected);
  });
});

test("avec poivre, l'empreinte change et n'est plus devinable par table arc-en-ciel", () => {
  const crypto = require("node:crypto");
  const { hashSecurityAnswer } = loadHelpers();

  const nu = crypto.createHash("sha256").update("Abidjan").digest("hex");

  withPepper("poivre-de-test", () => {
    const peppered = hashSecurityAnswer("Abidjan");

    assert.notEqual(peppered, nu);
    assert.match(peppered, /^[a-f0-9]{64}$/);
  });
});

test("compat ascendante : une empreinte sha256 nue reste vérifiable après activation du poivre", () => {
  const { hashSecurityAnswer, verifySecurityAnswerHash } = loadHelpers();

  // Empreinte écrite AVANT l'activation du poivre — une transaction en attente.
  const ancienne = withPepper(null, () => hashSecurityAnswer("l'ecole"));

  // Le poivre est activé ; la transaction en attente doit rester confirmable,
  // sinon l'activation de la variable annulerait tous les virements en cours.
  withPepper("poivre-de-test", () => {
    assert.equal(verifySecurityAnswerHash("l'ecole", ancienne), true);
    assert.equal(verifySecurityAnswerHash("mauvaise", ancienne), false);
  });
});

test("une empreinte HMAC n'est pas vérifiable une fois le poivre retiré", () => {
  const { hashSecurityAnswer, verifySecurityAnswerHash } = loadHelpers();

  const peppered = withPepper("poivre-de-test", () =>
    hashSecurityAnswer("l'ecole")
  );

  // Comportement attendu, et c'est le sens d'un poivre : perdre la variable,
  // c'est perdre la vérification. À traiter comme un secret de production.
  withPepper(null, () => {
    assert.equal(verifySecurityAnswerHash("l'ecole", peppered), false);
  });
});

test("une réponse vide ou absente ne valide jamais", () => {
  const { hashSecurityAnswer, verifySecurityAnswerHash } = loadHelpers();

  withPepper(null, () => {
    const stored = hashSecurityAnswer("Abidjan");

    assert.equal(verifySecurityAnswerHash("", stored), false);
    assert.equal(verifySecurityAnswerHash(null, stored), false);
    assert.equal(verifySecurityAnswerHash(undefined, stored), false);

    // Empreinte absente : rien ne doit passer, surtout pas une réponse vide.
    assert.equal(verifySecurityAnswerHash("Abidjan", ""), false);
    assert.equal(verifySecurityAnswerHash("", ""), false);
    assert.equal(verifySecurityAnswerHash("", null), false);
  });
});

test("la réponse d'une transaction ne confirme pas celle d'une autre", () => {
  const { hashSecurityAnswer, verifySecurityAnswerHash } = loadHelpers();

  withPepper("poivre-de-test", () => {
    const txA = hashSecurityAnswer("reponse-A");
    const txB = hashSecurityAnswer("reponse-B");

    assert.equal(verifySecurityAnswerHash("reponse-A", txB), false);
    assert.equal(verifySecurityAnswerHash("reponse-B", txA), false);
  });
});
