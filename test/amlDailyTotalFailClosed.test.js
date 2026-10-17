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

/**
 * Depuis le 2026-10-17, le plafond se lit par `services/limits/limitService`
 * (par opération, 24 h et 30 jours). Les garanties de ce fichier valent pour
 * le nouveau bloc : un cumul illisible REFUSE (503), avant toute décision.
 */
function limitSection() {
  const start = CODE.indexOf("getLimitService().checkLimit(");
  const end = CODE.indexOf("if (!limitCheck.allowed)", start);
  assert.ok(start > 0 && end > start, "le contrôle des plafonds est introuvable dans le bloc actif");
  return CODE.slice(start, end);
}

function velocitySection() {
  const start = CODE.indexOf("getUserTransactionsStats(");
  const end = CODE.indexOf("const userQuestions", start);
  assert.ok(start > 0 && end > start, "la lecture des statistiques de vélocité est introuvable");
  return CODE.slice(start, end);
}

test("un cumul illisible ne retombe jamais à zéro", () => {
  for (const section of [limitSection(), velocitySection()]) {
    assert.doesNotMatch(section, /(?:\?\?|\|\|)\s*0\b/, "un repli à zéro est revenu : un cumul illisible passerait les plafonds");
  }
  // Et le calcul lui-même lève sur un montant illisible (voir test/limits/limitUsage.test.js).
  const usage = fs.readFileSync(path.join(__dirname, "..", "src", "services", "limits", "limitUsage.js"), "utf8");
  assert.match(usage, /LIMIT_USAGE_UNREADABLE/);
});

test("stats indisponibles ⇒ 503 AML_STATS_UNAVAILABLE, AVANT le contrôle du plafond", () => {
  const section = limitSection();
  const catchAt = section.indexOf("catch (limitErr)");
  assert.ok(catchAt > 0, "l'échec de lecture du cumul n'est pas intercepté");
  const refusal = section.indexOf("AML_STATS_UNAVAILABLE", catchAt);
  assert.ok(refusal > 0, "aucun refus nommé quand le cumul est illisible");
  assert.match(section.slice(catchAt), /res\.status\(503\)/, "le refus doit être un 503 réessayable");

  const velocity = velocitySection();
  assert.match(velocity, /statsError\s*\|\|\s*!stats/, "les statistiques de vélocité illisibles doivent refuser");
  assert.match(velocity, /AML_STATS_UNAVAILABLE/);
});

test("le catch des statistiques ne laisse plus le contrôle continuer", () => {
  for (const section of [limitSection(), velocitySection()]) {
    assert.doesNotMatch(section, /SAUTÉS/, "le journal « contrôles SAUTÉS » signale le retour du repli ouvert");
  }
  // Dans le catch du cumul, chaque branche se termine par un `return res.status(...)`.
  const section = limitSection();
  const body = section.slice(section.indexOf("catch (limitErr)"));
  assert.equal((body.match(/return res\.status\(/g) || []).length, 2, "une branche du catch laisse passer l'opération");
});
