"use strict";

/**
 * ============================================================================
 * UNE DEVISE DE COMPTE ILLISIBLE ARRÊTE L'OPÉRATION — ET UNE SEULE SOURCE
 * ============================================================================
 *
 * ── Défaut n° 1 : un repli sur « CAD » ──────────────────────────────────────
 * `TxWalletBalance.normCurrency` rendait `"CAD"` sur devise vide. Elle est
 * appelée **en tête de chaque opération de portefeuille** — réserver, capturer,
 * libérer, créditer, débiter. Une devise vide faisait donc porter l'opération
 * **sur le portefeuille CAD**, sans erreur et sans trace. Ce n'est pas un défaut
 * d'affichage : c'est un mouvement d'argent sur le mauvais compte.
 *
 * ── Défaut n° 2 : trois normalisations qui ne s'accordaient pas ─────────────
 * `TxWalletBalance.normCurrency` traduisait `FCFA` → `XOF` ;
 * `ledgerService.normalizeCurrency` se contentait de majusculer. Un appel en
 * `FCFA` créait donc un portefeuille en **XOF** et des écritures sur
 * `user_wallet:<id>:**FCFA**` — deux comptes pour un seul argent, dont un que
 * plus aucun contrôle ne réconcilie.
 *
 * L'invariant 2 dit que le grand livre fait foi et que le solde en est une
 * projection. **Une projection qui ne porte pas le même nom de compte que sa
 * source n'est pas une projection.**
 *
 * Les deux convergent désormais sur `utils/currency.normalizeAccountCurrency`.
 *
 * ── Ce que ce fichier a appris en chemin ────────────────────────────────────
 * Sa première version lisait la SOURCE de `normCurrency` et y cherchait un
 * `throw` et les alias en toutes lettres. Elle est tombée dès que la fonction a
 * délégué — alors que le comportement était devenu meilleur. *Un test qui
 * inspecte du texte casse sur un refactoring correct ; il teste la rédaction,
 * pas la propriété.* Il teste maintenant le COMPORTEMENT, et ne garde de
 * l'inspection de source que ce qui ne peut pas s'observer autrement : le fait
 * que personne n'ait réintroduit une normalisation locale.
 *
 * Test **pur** : aucune connexion, aucun serveur.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { normalizeAccountCurrency } = require("../src/utils/currency");

const SRC = path.join(__dirname, "..", "src");

test("une devise absente LÈVE, elle ne retombe sur aucune valeur par défaut", () => {
  for (const vide of ["", "   ", null, undefined]) {
    assert.throws(
      () => normalizeAccountCurrency(vide),
      /Devise absente/,
      `normalizeAccountCurrency(${JSON.stringify(vide)}) n'a pas fermé. Un repli ` +
        "sur une devise par défaut ferait porter l'opération au MAUVAIS compte, " +
        "sans erreur et sans trace (règle B.2)."
    );
  }
});

test("une devise inexploitable LÈVE plutôt que d'être écrite telle quelle", () => {
  for (const mauvais of ["X1", "12", "€", "TROP-LONGUE-DEVISE"]) {
    assert.throws(
      () => normalizeAccountCurrency(mauvais),
      /Devise de compte invalide/,
      `« ${mauvais} » a été accepté comme devise de compte : il désignerait un ` +
        "compte que rien ne réconcilie."
    );
  }
});

/**
 * Les alias ne sont PAS des replis : ce sont des écritures différentes d'une
 * devise **connue**. C'est leur absence côté grand livre qui a créé le second
 * défaut.
 */
test("les alias rendent le MÊME code des deux côtés", () => {
  assert.equal(normalizeAccountCurrency("FCFA"), "XOF");
  assert.equal(normalizeAccountCurrency("CFA"), "XOF");
  assert.equal(normalizeAccountCurrency("$CAD"), "CAD");
  assert.equal(normalizeAccountCurrency("$USD"), "USD");
  assert.equal(normalizeAccountCurrency("xof"), "XOF");
});

/**
 * ⚠️ LE CONTRÔLE QUI COMPTE VRAIMENT.
 *
 * Les tests ci-dessus valident la source unique. Ils resteraient au vert si
 * quelqu'un réintroduisait une normalisation locale dans l'un des deux
 * modules — c'est-à-dire s'il recréait exactement le défaut.
 */
test("portefeuille et grand livre ne réintroduisent aucune normalisation locale", () => {
  const cibles = [
    ["models/TxWalletBalance.js", "normCurrency"],
    ["services/ledgerService.js", "normalizeCurrency"],
  ];

  for (const [fichier, fonction] of cibles) {
    const source = fs.readFileSync(path.join(SRC, fichier), "utf8");

    assert.match(
      source,
      /normalizeAccountCurrency/,
      `${fichier} n'utilise plus la source unique \`normalizeAccountCurrency\`. ` +
        "Deux normalisations qui divergent font écrire le portefeuille et le " +
        "grand livre sur des comptes différents pour le même argent."
    );

    /**
     * Extraction volontairement littérale — pas d'expression régulière
     * construite dynamiquement : la première version en portait une, dont
     * l'échappement s'est perdu au passage et qui ne trouvait plus rien.
     * Un test qui ne trouve pas sa cible échoue pour la mauvaise raison, et
     * on croit avoir détecté un défaut qui n'existe pas.
     */
    const debut = source.indexOf(`function ${fonction}(`);
    assert.notEqual(debut, -1, `${fonction} est introuvable dans ${fichier}`);

    const fin = source.indexOf("\n}", debut);
    const corps = source.slice(debut, fin === -1 ? undefined : fin + 2);

    assert.ok(
      !/["']FCFA["']|["']CFA["']|toUpperCase\(\)/.test(corps),
      `${fichier} a réintroduit une normalisation locale dans \`${fonction}\` : ` +
        "table d'alias ou mise en majuscules. C'est exactement ce qui a produit " +
        "le défaut — un portefeuille XOF face à des écritures FCFA."
    );
  }
});
