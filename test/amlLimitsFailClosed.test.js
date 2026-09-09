"use strict";

/**
 * Les plafonds AML échouent en FERMETURE.
 *
 * Ce fichier existe à cause d'un défaut mesuré le 2026-09-08 : la résolution
 * des plafonds se terminait par `?? limits["$"] ?? 1_000_000`, de sorte qu'un
 * rail inconnu — ou simplement absent de la table — recevait un plafond de
 * 1 000 000 au lieu des 5 000 € du rail interne. Deux cents fois l'écart, et le
 * rail venait du CORPS DE LA REQUÊTE côté Tx Core.
 *
 * Chaque test ci-dessous échoue si l'on réintroduit la faute qu'il vise.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getSingleTxLimit,
  getDailyLimit,
  AmlLimitUnavailableError,
  AML_SINGLE_TX_LIMITS,
  AML_DAILY_LIMITS,
  LIMIT_PROVENANCE,
  KNOWN_RAILS,
  RAIL_ALIASES,
  resolveAmlAmount,
  normalizeRail,
} = require("../src/tools/amlLimits");

/* ── Le défaut d'origine ─────────────────────────────────────────────────── */

test("un rail inconnu ne reçoit AUCUN plafond — il est refusé", () => {
  for (const inventé of ["nimportequoi", "xyz", "../../etc", "PAYNOVAL_"]) {
    assert.throws(
      () => getSingleTxLimit(inventé, "EUR"),
      (e) => e instanceof AmlLimitUnavailableError && e.code === "AML_UNKNOWN_RAIL",
      `le rail « ${inventé} » aurait dû être refusé`
    );

    assert.throws(
      () => getDailyLimit(inventé, "EUR"),
      (e) => e instanceof AmlLimitUnavailableError && e.code === "AML_UNKNOWN_RAIL"
    );
  }
});

test("aucun plafond résolu n'atteint jamais les anciennes valeurs de repli", () => {
  // 1 000 000 et 5 000 000 étaient les deux constantes de repli. Aucune devise
  // du rail interne ne doit plus les produire par accident en EUR/USD.
  for (const rail of KNOWN_RAILS) {
    for (const devise of ["EUR", "USD", "CAD", "GBP"]) {
      assert.ok(
        getSingleTxLimit(rail, devise) < 1_000_000,
        `${rail}/${devise} rend un plafond de niveau « repli »`
      );
    }
  }
});

test("un rail retiré du produit est refusé comme un rail inconnu", () => {
  for (const retiré of ["stripe", "bank", "stripe2momo", "flutterwave"]) {
    assert.throws(
      () => getSingleTxLimit(retiré, "EUR"),
      (e) => e.code === "AML_UNKNOWN_RAIL",
      `« ${retiré} » ne doit plus porter de plafond`
    );
  }
});

test("un opérateur mobile money n'est PAS un rail", () => {
  // Orange ou MTN se servent DERRIÈRE le rail `mobilemoney`. Leur donner un
  // plafond propre ouvrirait un second chemin vers le même argent.
  for (const opérateur of ["orange", "mtn", "moov", "wave"]) {
    assert.throws(
      () => getSingleTxLimit(opérateur, "XOF"),
      (e) => e.code === "AML_UNKNOWN_RAIL"
    );
  }
});

/* ── La confusion de devise ──────────────────────────────────────────────── */

test("une devise non couverte ne prend PAS le plafond d'une autre devise", () => {
  assert.throws(
    () => getSingleTxLimit("paynoval", "ZZZ"),
    (e) => e.code === "AML_UNSUPPORTED_CURRENCY"
  );
});

test("CNY et JPY ont des plafonds DISTINCTS malgré le symbole ¥ partagé", () => {
  const cny = getSingleTxLimit("paynoval", "CNY");
  const jpy = getSingleTxLimit("paynoval", "JPY");

  assert.notEqual(
    cny,
    jpy,
    "la table est retombée sur une clé par symbole : « ¥ » vaut à la fois CNY " +
      "et JPY, et le même nombre y couvrait deux devises d'ordre très différent"
  );
});

test("XOF et XAF sont deux entrées, pas un « F CFA » commun", () => {
  assert.ok(Number.isFinite(getSingleTxLimit("paynoval", "XOF")));
  assert.ok(Number.isFinite(getSingleTxLimit("paynoval", "XAF")));
});

/* ── Le rail carte est générique ─────────────────────────────────────────── */

test("les réseaux carte se ramènent tous au rail `card`", () => {
  const attendu = getSingleTxLimit("card", "EUR");

  for (const alias of ["visa_direct", "visa-direct", "visadirect", "VISA_DIRECT", "visa", "mastercard"]) {
    assert.equal(
      getSingleTxLimit(alias, "EUR"),
      attendu,
      `« ${alias} » doit relever du rail carte — le partenaire changera, pas la politique`
    );
  }
});

test("normalizeRail ne FABRIQUE pas de correspondance", () => {
  // Élargir la reconnaissance ne doit jamais élargir l'autorisation.
  assert.equal(normalizeRail("carte_bleue"), "carte_bleue");
  assert.equal(normalizeRail("stripe"), "stripe");
});

/* ── Le montant ──────────────────────────────────────────────────────────── */

test("un montant illisible arrête le contrôle au lieu de valoir zéro", () => {
  // Zéro passe TOUS les plafonds : c'était un contournement complet.
  for (const illisible of ["abc", "", null, undefined, NaN]) {
    assert.throws(
      () => resolveAmlAmount({ amount: illisible }),
      (e) => e instanceof AmlLimitUnavailableError,
      `le montant « ${String(illisible)} » aurait dû interrompre le contrôle`
    );
  }

  assert.equal(resolveAmlAmount({ amount: "1 234,50" }), 1234.5);
});

/* ── Cohérence de la table elle-même ─────────────────────────────────────── */

test("tout rail porte les deux plafonds, sur les mêmes devises", () => {
  assert.deepEqual(
    Object.keys(AML_SINGLE_TX_LIMITS).sort(),
    Object.keys(AML_DAILY_LIMITS).sort()
  );

  for (const rail of KNOWN_RAILS) {
    assert.deepEqual(
      Object.keys(AML_SINGLE_TX_LIMITS[rail]).sort(),
      Object.keys(AML_DAILY_LIMITS[rail]).sort(),
      `rail ${rail} : devises désaccordées entre les deux tables`
    );
  }
});

test("aucun plafond journalier n'est inférieur au plafond par envoi", () => {
  for (const rail of KNOWN_RAILS) {
    for (const [iso, envoi] of Object.entries(AML_SINGLE_TX_LIMITS[rail])) {
      assert.ok(
        AML_DAILY_LIMITS[rail][iso] >= envoi,
        `${rail}/${iso} : journalier < par envoi, aucun envoi ne passerait`
      );
    }
  }
});

test("tout plafond déclare sa provenance", () => {
  for (const rail of KNOWN_RAILS) {
    assert.ok(
      LIMIT_PROVENANCE[rail],
      `le rail ${rail} n'indique pas si ses chiffres sont décidés ou hérités`
    );
  }
});

test("tout alias de rail pointe vers un rail réellement couvert", () => {
  for (const [alias, canonique] of Object.entries(RAIL_ALIASES)) {
    assert.ok(
      KNOWN_RAILS.includes(canonique),
      `l'alias « ${alias} » désigne « ${canonique} », absent de la table`
    );
  }
});

test("le périmètre produit est exactement de trois rails", () => {
  assert.deepEqual(KNOWN_RAILS.slice().sort(), ["card", "mobilemoney", "paynoval"]);
});
