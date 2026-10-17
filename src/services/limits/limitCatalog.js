"use strict";

/**
 * ============================================================================
 * PLAFONDS — CATALOGUE ET VALEURS DE DÉPART (2026-10-08)
 * ============================================================================
 *
 * Ce que font PayPal, Wise, Revolut, N26 et Wave, et ce que fait désormais
 * PayNoval :
 *
 *   - trois plafonds par OPÉRATION (dépôt, retrait, transfert) et par RAIL :
 *     par opération, sur 24 h GLISSANTES, sur 30 jours GLISSANTS ;
 *   - le client voit ce qu'il a utilisé, ce qui lui reste et quand ça se
 *     libère (`GET /api/v1/limits`), AVANT de confirmer ;
 *   - un refus dit QUEL plafond, combien il reste, et quand il se libère ;
 *   - les montants sont réglés par la conformité au back-office, par versions
 *     immuables approuvées par une SECONDE personne (`limitPolicyService`).
 *
 * Les valeurs de départ reprennent la table AML historique
 * (`tools/amlLimits.js`) : par opération = plafond par envoi, 24 h = plafond
 * journalier. Le plafond sur 30 jours n'existait pas : il vaut ici CINQ fois le
 * journalier, valeur PROVISOIRE à confirmer par la conformité (c'est dit dans
 * `DEFAULT_POLICY_PROVENANCE`, exporté et testé).
 *
 * Module PUR : aucune base.
 */

const { AML_SINGLE_TX_LIMITS, AML_DAILY_LIMITS } = require("../../tools/amlLimits");

const OPERATIONS = Object.freeze(["DEPOSIT", "WITHDRAW", "TRANSFER"]);

/** Les rails qu'une opération emprunte (périmètre V1). */
const RAILS_BY_OPERATION = Object.freeze({
  DEPOSIT: Object.freeze(["mobilemoney", "card"]),
  WITHDRAW: Object.freeze(["mobilemoney", "card"]),
  TRANSFER: Object.freeze(["paynoval", "mobilemoney", "card"]),
});

const WINDOWS = Object.freeze({
  rolling24h: 24 * 60 * 60 * 1000,
  rolling30d: 30 * 24 * 60 * 60 * 1000,
});

const MONTHLY_FACTOR = 5;

/** Ramène un rail d'appel au rail du catalogue ; inconnu ⇒ `null`. */
function catalogRail(value) {
  const s = String(value || "").trim().toLowerCase();
  if (["paynoval", "internal", "wallet"].includes(s)) return "paynoval";
  if (["mobilemoney", "mobile_money", "mobile-money", "momo"].includes(s)) return "mobilemoney";
  if (["card", "visa", "visa_direct", "visadirect", "visa-direct", "mastercard"].includes(s)) return "card";
  return null;
}

/** Ramène un type déclaré à une opération du catalogue ; inconnu ⇒ `null`. */
function catalogOperation(value) {
  const s = String(value || "").trim().toLowerCase();
  if (["deposit", "depot", "topup", "collection"].includes(s)) return "DEPOSIT";
  if (["withdraw", "withdrawal", "retrait"].includes(s)) return "WITHDRAW";
  if (["transfer", "send", "transfert"].includes(s)) return "TRANSFER";
  return null;
}

function buildDefaultLimits() {
  const limits = {};

  for (const operation of OPERATIONS) {
    limits[operation] = {};
    for (const rail of RAILS_BY_OPERATION[operation]) {
      limits[operation][rail] = {};
      const single = AML_SINGLE_TX_LIMITS[rail] || {};
      const daily = AML_DAILY_LIMITS[rail] || {};
      for (const currency of Object.keys(single)) {
        if (!(currency in daily)) continue;
        limits[operation][rail][currency] = {
          perTransaction: single[currency],
          rolling24h: daily[currency],
          rolling30d: daily[currency] * MONTHLY_FACTOR,
        };
      }
    }
  }

  return limits;
}

const DEFAULT_LIMITS = Object.freeze(buildDefaultLimits());

const DEFAULT_POLICY_PROVENANCE = Object.freeze({
  perTransaction: "tools/amlLimits AML_SINGLE_TX_LIMITS",
  rolling24h: "tools/amlLimits AML_DAILY_LIMITS",
  rolling30d: `PROVISIONAL: ${MONTHLY_FACTOR} x rolling24h — to be confirmed by compliance`,
});

module.exports = {
  OPERATIONS,
  RAILS_BY_OPERATION,
  WINDOWS,
  MONTHLY_FACTOR,
  DEFAULT_LIMITS,
  DEFAULT_POLICY_PROVENANCE,
  catalogRail,
  catalogOperation,
};
