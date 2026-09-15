"use strict";

/**
 * ============================================================================
 * LE MODULE CAGNOTTE PEUT-IL RÉGLER ? — ANNONCÉ AU DÉMARRAGE
 * ============================================================================
 *
 * Depuis le 2026-09-10, frais et marge de change des cagnottes sont crédités
 * à deux trésoreries. Si leur identifiant manque, le règlement REFUSE
 * (`TREASURY_UNCONFIGURED`) — en fermeture, c'est voulu. Mais un service qui
 * démarre sans les avoir et ne le dit pas ne se découvre qu'à la première
 * participation, en 500 (règle B.6).
 *
 * Module pur : il rend un diagnostic ; `announceCagnotteReadiness` le
 * journalise avec sa conséquence.
 */

const REQUIRED = Object.freeze([
  {
    env: "CAGNOTTE_FEES_TREASURY_USER_ID",
    consequence: "toute participation ou clôture avec frais sera refusée (TREASURY_UNCONFIGURED)",
  },
  {
    env: "FX_MARGIN_TREASURY_USER_ID",
    consequence: "toute participation convertie avec marge de change sera refusée (TREASURY_UNCONFIGURED)",
  },
]);

const OBJECT_ID = /^[a-f0-9]{24}$/i;

function diagnoseCagnotteReadiness(env = process.env) {
  const problems = [];

  for (const r of REQUIRED) {
    const v = String(env?.[r.env] || "").trim();
    if (!v) problems.push({ env: r.env, issue: "absente", consequence: r.consequence });
    else if (!OBJECT_ID.test(v)) problems.push({ env: r.env, issue: "illisible (ObjectId attendu)", consequence: r.consequence });
  }

  const currencies = String(env?.CAGNOTTE_SUPPORTED_CURRENCIES || "").trim();
  if (currencies && currencies.split(",").some((c) => !/^[A-Z]{3}$/.test(c.trim().toUpperCase()))) {
    problems.push({
      env: "CAGNOTTE_SUPPORTED_CURRENCIES",
      issue: "illisible",
      consequence: "toute opération de cagnotte échouera (CAGNOTTE_CURRENCIES_MISCONFIGURED)",
    });
  }

  return { ready: problems.length === 0, problems };
}

function announceCagnotteReadiness(env = process.env, logger = console) {
  const d = diagnoseCagnotteReadiness(env);

  if (d.ready) {
    logger.info("✅ [cagnottes] trésoreries des frais et de la marge de change configurées");
  } else {
    for (const p of d.problems) {
      logger.warn(`⚠️ [cagnottes] ${p.env} ${p.issue} — conséquence : ${p.consequence}.`);
    }
  }

  return d;
}

module.exports = { diagnoseCagnotteReadiness, announceCagnotteReadiness, REQUIRED };
