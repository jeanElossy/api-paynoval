"use strict";

/**
 * Le cumul journalier AML échoue en FERMETURE — décision du 2026-09-15.
 *
 * Avant : quand `getUserTransactionsStats` levait (panne d'agrégation Mongo),
 * `stats` restait `null`, `dailyTotal` retombait à 0 et le plafond JOURNALIER
 * — avec les contrôles de volume et de fractionnement — était sauté en
 * silence. Un simple `catch` levait une frontière de conformité.
 *
 * Le middleware est trop couplé (profil, blacklist, sanctions, base) pour être
 * exercé sans serveur ; le test lit donc la SOURCE du bloc actif et échoue si
 * la faute revient : repli à 0, ou poursuite du contrôle sans cumul lisible.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "src", "middleware", "aml.js"), "utf8");

// Le bloc actif commence au module.exports : les versions commentées au-dessus ne comptent pas.
const ACTIVE = SOURCE.slice(SOURCE.indexOf("module.exports = async function amlMiddleware"));

const withoutComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const CODE = withoutComments(ACTIVE);

function dailyLimitSection() {
  const start = CODE.indexOf("getUserTransactionsStats(");
  const end = CODE.indexOf("AML_DAILY_LIMIT", start);
  assert.ok(start > 0 && end > start, "le calcul du cumul journalier est introuvable dans le bloc actif");
  return CODE.slice(start, end);
}

test("un cumul illisible ne retombe jamais à zéro", () => {
  const section = dailyLimitSection();

  assert.doesNotMatch(
    section,
    /dailyTotal\)\)\s*\?[\s\S]{0,80}:\s*0\s*;/,
    "le repli `dailyTotal … : 0` est revenu : un cumul illisible passerait tous les plafonds"
  );
  // Le cumul lui-même : `amount` est déjà validé en fermeture par `resolveAmlAmount`.
  assert.doesNotMatch(
    section,
    /dailyTotal\s*=[^;]*(?:\?\?|\|\|)\s*0\b/,
    "un repli à zéro sur le cumul journalier est revenu"
  );
});

test("stats indisponibles ⇒ 503 AML_STATS_UNAVAILABLE, AVANT le contrôle du plafond", () => {
  const section = dailyLimitSection();

  const refusal = section.indexOf("AML_STATS_UNAVAILABLE");
  assert.ok(refusal > 0, "aucun refus nommé quand les statistiques sont illisibles");
  assert.match(section, /res\.status\(503\)/, "le refus doit être un 503 réessayable, pas un 200 ni un 403");
  assert.match(section, /statsError\s*\|\|\s*!Number\.isFinite\(dailyTotal\)/, "l'erreur ET le cumul non numérique doivent refuser");

  // Le refus doit précéder la comparaison au plafond : sinon un cumul NaN ne
  // déclencherait jamais `futureTotal > dailyLimit` (NaN > x est faux).
  const comparison = section.indexOf("futureTotal > dailyLimit");
  assert.ok(comparison < 0 || refusal < comparison, "le refus arrive après la comparaison au plafond");
});

test("le catch des statistiques ne laisse plus le contrôle continuer", () => {
  const section = dailyLimitSection();
  assert.doesNotMatch(section, /SAUTÉS/, "le journal « contrôles SAUTÉS » signale le retour du repli ouvert");
});
