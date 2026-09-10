"use strict";

/**
 * ============================================================================
 * LE CONTRAT D'ÉVÉNEMENT — CE QUI SORT DU MOTEUR
 * ============================================================================
 *
 * Ces tests portent sur la seule chose qui protège les consommateurs et les
 * données personnelles : la liste des champs autorisés.
 *
 * ⚠️ Ce qui est vérifié n'est pas « le contrat fonctionne » mais « le contrat
 * REFUSE ». Un test qui ne montre que le cas nominal laisserait passer la
 * régression qui compte : le jour où quelqu'un publie le document interne.
 *
 * Test **pur** : logique seule, aucune connexion.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CONTRATS,
  BANNIS,
  buildPayload,
  aggregateTypeOf,
  nomsConnus,
} = require("../src/services/events/contract");

const BASE = Object.freeze({
  transactionId: "t-1",
  amount: 1000,
  currency: "XOF",
  senderId: "u-1",
});

test("tout nom d'événement porte sa version", () => {
  /**
   * La version est dans le NOM parce qu'une évolution se fait en publiant
   * `.v2` À CÔTÉ de `.v1`. Un champ `version` séparé obligerait chaque
   * consommateur à traiter toutes les versions dans le même gestionnaire.
   */
  for (const nom of nomsConnus()) {
    assert.match(
      nom,
      /\.v\d+$/,
      `« ${nom} » n'est pas versionné : une évolution casserait ses consommateurs`
    );
  }
});

test("la charge utile est RÉDUITE aux champs du contrat", () => {
  const sortie = buildPayload("transaction.initiated.v1", {
    ...BASE,
    reference: "PNV1",
  });

  assert.deepEqual(Object.keys(sortie).sort(), [
    "amount",
    "currency",
    "reference",
    "senderId",
    "transactionId",
  ]);
});

test("un champ hors contrat est REFUSÉ, pas retiré en silence", () => {
  /**
   * Le retirer en silence ferait croire à l'appelant que son champ est publié.
   * C'est l'inverse du problème, et il coûte aussi cher : on découvre l'absence
   * chez le consommateur, longtemps après.
   */
  assert.throws(
    () => buildPayload("transaction.initiated.v1", { ...BASE, nouveau: 1 }),
    (err) => err.code === "EVENT_FIELD_UNDECLARED"
  );
});

test("un champ requis manquant REFUSE la publication", () => {
  assert.throws(
    () => buildPayload("transaction.initiated.v1", { transactionId: "t-1" }),
    (err) => err.code === "EVENT_FIELD_MISSING"
  );
});

test("un événement inconnu REFUSE la publication", () => {
  assert.throws(
    () => buildPayload("transaction.teleported.v1", BASE),
    (err) => err.code === "EVENT_UNKNOWN"
  );

  assert.throws(() => aggregateTypeOf("inexistant.v1"));
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* LA PROTECTION DES DONNÉES — règle B.4                                     */
/* ══════════════════════════════════════════════════════════════════════════ */

test("aucune donnée sensible ne peut être publiée, même déclarée", () => {
  /**
   * ⚠️ Ce test vise l'ERREUR HUMAINE dans le contrat lui-même. La liste des
   * autorisés protège des appelants distraits ; ce second filet protège de
   * celui qui éditerait le contrat pour « juste ajouter le téléphone ».
   */
  const sensibles = [
    "phoneNumber",
    "email",
    "pan",
    "cvv",
    "otp",
    "token",
    "iban",
    "password",
  ];

  for (const champ of sensibles) {
    assert.throws(
      () => buildPayload("transaction.initiated.v1", { ...BASE, [champ]: "x" }),
      (err) => err.code === "EVENT_FIELD_FORBIDDEN",
      `« ${champ} » a pu être publié sur le bus`
    );
  }
});

test("aucun contrat ne déclare un champ banni", () => {
  /**
   * L'autre moitié : le filet ci-dessus lève À L'EXÉCUTION. Ce test-ci
   * l'attrape À LA REVUE, avant qu'un seul événement soit publié.
   */
  const fautes = [];

  for (const [nom, contrat] of Object.entries(CONTRATS)) {
    for (const champ of contrat.champs) {
      const normalise = champ.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (BANNIS.includes(normalise)) fautes.push(`${nom} → ${champ}`);
    }
  }

  assert.deepEqual(fautes, [], "champs sensibles déclarés :\n  " + fautes.join("\n  "));
});

test("l'encaissement public ne publie que les 4 derniers chiffres du payeur", () => {
  /**
   * Le contributeur d'une cagnotte n'a PAS de compte : son numéro est la seule
   * donnée d'identification qu'on détienne de lui, et un bus est lu par
   * plusieurs consommateurs.
   */
  const contrat = CONTRATS["collection.succeeded.v1"];

  assert.ok(contrat.champs.includes("payerPhoneLast4"));
  assert.ok(!contrat.champs.includes("payerPhone"));
  assert.ok(!contrat.champs.includes("phoneNumber"));
});

test("tout champ requis figure dans les champs autorisés", () => {
  /**
   * Sans cette cohérence, un contrat pourrait exiger un champ que la
   * normalisation retire — et lever systématiquement `EVENT_FIELD_MISSING`
   * sur un appel pourtant correct. L'événement serait alors impubliable, et la
   * cause introuvable.
   */
  for (const [nom, contrat] of Object.entries(CONTRATS)) {
    for (const requis of contrat.requis) {
      assert.ok(
        contrat.champs.includes(requis),
        `« ${nom} » exige « ${requis} », qui n'est pas dans ses champs autorisés`
      );
    }
  }
});
