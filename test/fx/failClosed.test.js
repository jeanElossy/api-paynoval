"use strict";

/**
 * ── Déplacé depuis l'API Gateway le 2026-09-10 ──────────────────────────────
 *
 * Il suit le service qu'il protège. Le laisser dans la passerelle en aurait
 * fait un test de code MORT : il aurait continué à passer en donnant
 * l'impression de couvrir le repli du change, pendant que le vrai service —
 * celui de Tx-Core — n'aurait été couvert par rien.
 */

/**
 * ============================================================================
 * LE CHANGE ÉCHOUE EN FERMETURE — RÈGLE B.2
 * ============================================================================
 *
 * ── Défaut n° 1 : un taux de 1 pour 1 sur devise illisible ──────────────────
 * `getExchangeRate` rendait `{ rate: 1, source: "invalid" }` quand une devise
 * n'était pas lisible. C'est la pire valeur de repli imaginable sur une
 * frontière de change : elle est **plausible** (beaucoup de paires valent à peu
 * près 1), elle ne lève aucune alerte, et elle convertit un montant en le
 * laissant tel quel. Une tarification en sortait avec un prix faux et l'air
 * parfaitement normal.
 *
 * `source: "invalid"` était censé le dire — mais aucun appelant ne lit ce
 * champ : `controllers/pricingController.js:148-151` ne regarde que `out.rate`,
 * et 1 est un nombre fini parfaitement acceptable.
 *
 * ── Défaut n° 2 : un instantané d'âge non borné sur panne du fournisseur ────
 * Le repli sur ERREUR appliquait l'instantané de base avec un simple
 * `if (snap)`, sans contrôle de fraîcheur — alors que la branche de
 * refroidissement, vingt lignes plus haut, appelait bien
 * `isSnapshotFreshEnough`. Un taux vieux de trois semaines s'appliquait donc
 * comme un taux frais. Et c'est le pire moment pour être laxiste : le
 * fournisseur est en panne, donc l'instantané est par construction le plus
 * vieux qu'il puisse être.
 *
 * ── Comment ces tests tombent ───────────────────────────────────────────────
 * · Rétablir `return { rate: 1, … }` → le premier échoue.
 * · Remettre `if (snap)` sans `isSnapshotFreshEnough` → le second échoue.
 *
 * Tests **purs** : le premier lève avant toute lecture de base ; le second lit
 * la source. Aucune connexion, aucun serveur.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SOURCE = path.resolve(__dirname, "../../src/services/pricing/exchangeRateService.js");

test("une devise illisible ARRÊTE la conversion, elle ne vaut pas 1 pour 1", async () => {
  const { getExchangeRate } = require("../../src/services/pricing/exchangeRateService");

  for (const [from, to] of [["", "CAD"], ["CAD", ""], ["??", "CAD"], [null, null]]) {
    await assert.rejects(
      () => getExchangeRate(from, to),
      (err) => {
        assert.equal(
          err.code,
          "FX_INVALID_CURRENCY",
          `from="${from}" to="${to}" n'a pas fermé : un repli à 1 pour 1 produirait ` +
            "un prix faux sans que rien ne le signale (règle B.2)."
        );
        return true;
      },
      `getExchangeRate("${from}", "${to}") aurait dû lever`
    );
  }
});

/**
 * ⚠️ Contrôle de SOURCE, faute de mieux : exercer la branche demanderait une
 * base et un fournisseur en panne, donc de sortir de `npm test`, qui doit
 * rester sans base. On vérifie donc que **chaque** repli sur instantané est
 * gardé par un contrôle de fraîcheur — la propriété est structurelle, elle se
 * lit dans le texte.
 */
test("tout repli sur instantané de base contrôle la fraîcheur", () => {
  const source = fs.readFileSync(SOURCE, "utf8");
  const lignes = source.split("\n");

  const nonGardes = [];

  for (let i = 0; i < lignes.length; i++) {
    if (!/getSnapshotFromDb\s*\(/.test(lignes[i])) continue;

    // Le test regarde la ligne suivante utile : c'est là que vit la garde.
    const suite = lignes.slice(i + 1, i + 4).join(" ");
    if (!/if\s*\(\s*snap\b/.test(suite)) continue;
    if (/isSnapshotFreshEnough/.test(suite)) continue;

    nonGardes.push(`${i + 1}: ${lignes[i].trim()} → ${suite.trim().slice(0, 80)}`);
  }

  assert.deepEqual(
    nonGardes,
    [],
    "Un repli sur instantané applique un taux SANS contrôler sa fraîcheur. Sur " +
      "panne du fournisseur, un taux d'âge non borné serait appliqué à une " +
      "tarification (règle B.2).\n\n  " + nonGardes.join("\n  ")
  );
});
