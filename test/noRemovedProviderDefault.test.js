"use strict";

/**
 * AUCUN DÉFAUT NE POINTE VERS UN PRESTATAIRE RETIRÉ.
 *
 * Régression réelle, introduite et corrigée le 2026-09-08 : la suppression de
 * `providers/card/stripeAdapter.js` a laissé DERRIÈRE elle quatre valeurs de
 * repli qui désignaient encore « stripe » —
 *
 *   providerExecutorRegistry.js  fallbackProvider du dépôt par carte
 *   cardExecutor.js              deux fois, `tx.provider || "stripe"`
 *   flowHelpers.js               le prestataire des deux flux carte
 *   initiateExternalTransactions.js  le repli de `fundsValue`
 *
 * — de sorte que toute alimentation par carte allait chercher un adapter qui
 * n'existait plus. Le symptôme aurait été une exception au moment d'exécuter,
 * pas à la validation : la transaction aurait été créée, les fonds réservés,
 * et le règlement impossible.
 *
 * La leçon est générale : supprimer un prestataire ne consiste pas à supprimer
 * son fichier, mais à s'assurer que plus rien ne le NOMME comme repli.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");

/** Prestataires et rails retirés du produit. */
const RETIRES = ["stripe", "stripe2momo", "flutterwave", "bank_generic"];

/** Fichiers où un repli décide réellement du routage de l'argent. */
const CHEMINS_DE_ROUTAGE = [
  "providers/providerSelector.js",
  "providers/providerConfigReport.js",
  "services/transactions/providers/providerExecutorRegistry.js",
  "services/transactions/providers/cardExecutor.js",
  "services/transactions/handlers/flowHelpers.js",
  "services/transactions/handlers/initiateExternalTransactions.js",
];

/** Retire commentaires de bloc et de ligne : seul le code exécuté compte. */
function codeSeul(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

for (const relatif of CHEMINS_DE_ROUTAGE) {
  test(`${relatif} : aucun repli vers un prestataire retiré`, () => {
    const complet = path.join(SRC, relatif);
    assert.ok(fs.existsSync(complet), `${relatif} a disparu — test à revoir`);

    const code = codeSeul(fs.readFileSync(complet, "utf8"));

    for (const retire of RETIRES) {
      /**
       * On vise les REPLIS, pas les mentions : `x || "stripe"`, `? "stripe" :`,
       * `: "stripe"`, `return "stripe"`. Un `case "stripe": throw …` — le refus
       * explicite qu'on veut CONSERVER — n'est pas capturé.
       */
      const replis = new RegExp(
        `(\\|\\||\\?\\?|\\?|:|return)\\s*["']${retire}["']`,
        "g"
      );

      const trouves = code.match(replis) || [];

      assert.deepEqual(
        trouves,
        [],
        `${relatif} garde un repli vers « ${retire} » : ${trouves.join(", ")}`
      );
    }
  });
}

test("l'adapter Stripe a bien disparu du disque", () => {
  assert.ok(
    !fs.existsSync(path.join(SRC, "providers", "card", "stripeAdapter.js")),
    "le fichier est revenu"
  );
});

test("providerSelector REFUSE explicitement stripe au lieu de l'ignorer", () => {
  /**
   * Un `default: throw` générique aurait suffi à ne pas router. Mais une
   * transaction héritée portant `provider: "stripe"` mérite un message qui dit
   * CE QUI s'est passé, pas « rail non supporté ». C'est la même forme que le
   * refus posé pour le rail bancaire en août.
   */
  const src = fs.readFileSync(
    path.join(SRC, "providers", "providerSelector.js"),
    "utf8"
  );

  const bloc = src.slice(src.indexOf("function getCardAdapter"));

  assert.match(bloc, /case "stripe":/);
  assert.match(bloc, /throw new Error\(/);
  assert.match(bloc, /retiré de PayNoval/);
});
