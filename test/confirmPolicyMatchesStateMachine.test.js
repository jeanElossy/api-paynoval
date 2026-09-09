"use strict";

/**
 * LA POLITIQUE DE CONFIRMATION NE PEUT PLUS DIVERGER DE LA MACHINE À ÉTATS
 * ============================================================================
 *
 * `confirmTransaction.js` portait, pour les payouts sortants, une liste de
 * statuts confirmables ÉCRITE EN DUR, sans appel à `assertTransition`. Le
 * document d'architecture affirmait que « les deux listes sont cohérentes
 * aujourd'hui ». Elles ne l'étaient pas, et divergeaient dans les DEUX sens :
 *
 *   • `relaunch → confirmed` : autorisé par la liste, INTERDIT par `ALLOWED`.
 *     Une transaction relancée doit repasser par `pending`. Sauter cette étape
 *     contourne la reconstitution de réserve — `relaunch` est exactement le
 *     statut au cœur du défaut de re-capture traité en `confirmTransaction.js`.
 *
 *   • `processing → confirmed` : permis par `ALLOWED`, refusé par la liste.
 *     Refus conservé volontairement : un payout remis au prestataire se
 *     confirme sur son rappel authentifié, pas à la main.
 *
 * Ce test lit la liste dans le SOURCE plutôt que d'importer le module : charger
 * `confirmTransaction.js` charge `runtime`, qui résout `getTxConn()` au
 * chargement — donc une connexion Mongo. Les tests de ce dépôt n'en ouvrent
 * aucune, et c'est ce qui les rend rapides.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { canTransition, ALLOWED, STATES } = require("../src/services/transactionStateMachine");

const CHEMIN = path.join(
  __dirname,
  "..",
  "src",
  "services",
  "transactions",
  "handlers",
  "confirmTransaction.js"
);
const SOURCE = fs.readFileSync(CHEMIN, "utf8");

/** Extrait la liste déclarée, sans charger le module. */
function listeDeclaree() {
  const m = SOURCE.match(
    /const\s+PAYOUT_CONFIRMABLE_DEPUIS\s*=\s*Object\.freeze\(\s*\[([^\]]*)\]\s*\)/
  );
  assert.ok(m, "PAYOUT_CONFIRMABLE_DEPUIS introuvable ou n'est plus un Object.freeze([...])");
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

test("la liste n'est pas vide — sinon plus aucun payout ne serait confirmable", () => {
  assert.ok(listeDeclaree().length > 0);
});

test("chaque statut de la politique est AUSSI permis par la machine à états", () => {
  for (const statut of listeDeclaree()) {
    assert.ok(
      canTransition(statut, "confirmed"),
      `« ${statut} » est déclaré confirmable par la route, mais ALLOWED[${statut}] ` +
        `= [${(ALLOWED[statut] || []).join(", ")}] ne contient pas « confirmed ». ` +
        "La politique de route peut être plus STRICTE que la machine, jamais plus permissive."
    );
  }
});

test("`relaunch` ne revient pas dans la politique", () => {
  assert.ok(
    !listeDeclaree().includes(STATES.RELAUNCH),
    "confirmer directement depuis `relaunch` saute le retour en `pending`, " +
      "étape où la réserve est reconstituée"
  );
  // Et la machine doit continuer de l'interdire.
  assert.ok(!canTransition(STATES.RELAUNCH, STATES.CONFIRMED));
});

test("`processing` reste refusé sur la route utilisateur", () => {
  assert.ok(
    !listeDeclaree().includes(STATES.PROCESSING),
    "un payout déjà remis au prestataire se confirme sur son rappel signé, " +
      "pas à la main : dériver mécaniquement de ALLOWED ouvrirait ce chemin"
  );
  // La machine, elle, l'autorise : c'est bien la route qui restreint.
  assert.ok(canTransition(STATES.PROCESSING, STATES.CONFIRMED));
});

test("la branche payout appelle assertTransition", () => {
  assert.match(
    SOURCE,
    /assertTransition\(\s*statutActuel\s*,\s*"confirmed"\s*\)/,
    "sans cet appel, la liste en dur déciderait seule — c'est le défaut d'origine"
  );

  // La liste doit être un filtre AVANT la machine, pas à la place.
  const posListe = SOURCE.indexOf("PAYOUT_CONFIRMABLE_DEPUIS.includes(statutActuel)");
  const posMachine = SOURCE.indexOf('assertTransition(statutActuel, "confirmed")');
  assert.ok(posListe > -1 && posMachine > -1);
  assert.ok(posListe < posMachine, "le filtre de route s'applique d'abord, la machine tranche ensuite");
});

test("la branche transfert interne consulte toujours la machine", () => {
  assert.match(
    SOURCE,
    /assertTransition\(tx\.status,\s*"confirmed"\)/,
    "le chemin interne s'appuyait déjà sur la machine : ne pas le perdre"
  );
});
