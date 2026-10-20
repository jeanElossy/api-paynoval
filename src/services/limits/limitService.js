"use strict";

/**
 * ============================================================================
 * PLAFONDS — POINT D'ENTRÉE UNIQUE (2026-10-17)
 * ============================================================================
 *
 * Deux questions, une seule source de vérité :
 *
 *   checkLimit       l'opération passe-t-elle ? (appelé par `middleware/aml.js`
 *                    à l'initiation — c'est lui qui REFUSE) ;
 *   describeLimits   que voit le client ? (`GET /api/v1/limits`, écran « Mes
 *                    plafonds » et montant disponible avant confirmation).
 *
 * Les deux lisent la MÊME politique et le MÊME cumul : ce que l'écran annonce
 * est exactement ce que le serveur appliquera. Chez Wise, l'écran « Limits »
 * et le refus disent le même chiffre — c'est la condition pour qu'un client
 * comprenne un refus.
 */

const { RAILS_BY_OPERATION, OPERATIONS, catalogOperation, catalogRail } = require("./limitCatalog");
const { LIMIT_CODES, LimitError, describeUsage, evaluateLimit, resolveLimit } = require("./limitPolicy");
const { computeUsage, loadUsageRows } = require("./limitUsage");
const { getLimitPolicyService } = require("./limitPolicyService");
const { readAccountLimits, applyAccountLimits } = require("./accountLimits");

/**
 * The account override, read in the Users database (written by the backend).
 * Native read with a projection: only `limits` and `currency` leave the
 * database. Unreadable ⇒ throws: the caller refuses (fail closed, B.2).
 */
async function defaultLoadAccount(userId) {
  const { getUsersConn } = require("../../config/db");
  const mongoose = require("mongoose");
  if (!mongoose.isValidObjectId(String(userId))) return null;
  const doc = await getUsersConn()
    .collection("users")
    .findOne({ _id: new mongoose.Types.ObjectId(String(userId)) }, { projection: { limits: 1, currency: 1 } });
  return doc ? readAccountLimits(doc.limits, doc.currency) : null;
}

function defaultModels() {
  const { getTxConn } = require("../../config/db");
  const conn = getTxConn();
  return {
    Transaction: conn.models.Transaction || require("../../models/Transaction")(conn),
    CagnotteSettlement: conn.models.CagnotteSettlement || require("../../models/CagnotteSettlement")(conn),
  };
}

function createLimitService({ policyService = null, models = null, now = () => Date.now(), loadAccount = defaultLoadAccount } = {}) {
  const policy = () => policyService || getLimitPolicyService();
  const resolveModels = () => models || defaultModels();

  /**
   * L'opération d'un appel. Un transfert PayNoval → PayNoval est le seul
   * mouvement possible sur le rail interne : `TRANSFER` n'y est pas une
   * supposition. Sur un rail externe, un type absent est REFUSÉ.
   */
  function resolveOperation(declared, rail) {
    const op = catalogOperation(declared);
    if (op) return op;
    if (catalogRail(rail) === "paynoval") return "TRANSFER";
    return null;
  }

  async function checkLimit({ userId, operation, rail, currency, amount }) {
    const active = await policy().getActivePolicy();
    const op = resolveOperation(operation, rail);
    const policyLimit = resolveLimit(active.limits, { operation: op, rail, currency });
    const limit = applyAccountLimits(policyLimit, await loadAccount(userId));

    const { Transaction, CagnotteSettlement } = resolveModels();
    const at = now();
    const rows = await loadUsageRows({ userId, now: at, Transaction, CagnotteSettlement });
    const usage = computeUsage(rows, { operation: limit.operation, rail: limit.rail, currency: limit.currency, now: at });

    return {
      ...evaluateLimit(limit, usage, amount),
      policyVersion: active.version,
      policySource: active.source,
      limitSources: limit.sources,
    };
  }

  /**
   * Plafonds et consommation du compte pour une devise : une entrée par
   * (opération, rail) que la politique couvre dans cette devise. Le cumul est
   * lu UNE fois pour toutes les entrées.
   */
  async function describeLimits({ userId, currency }) {
    const iso = String(currency || "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(iso)) {
      throw new LimitError(LIMIT_CODES.UNDEFINED, "Devise requise (ISO 4217).", { currency: currency || null });
    }

    const active = await policy().getActivePolicy();
    const { Transaction, CagnotteSettlement } = resolveModels();
    const at = now();
    const rows = await loadUsageRows({ userId, now: at, Transaction, CagnotteSettlement });
    const account = await loadAccount(userId);

    const limits = [];
    for (const operation of OPERATIONS) {
      for (const rail of RAILS_BY_OPERATION[operation]) {
        if (!active.limits?.[operation]?.[rail]?.[iso]) continue;
        const limit = applyAccountLimits(resolveLimit(active.limits, { operation, rail, currency: iso }), account);
        const usage = computeUsage(rows, { operation, rail, currency: iso, now: at });
        // The screen says WHERE each ceiling comes from ("set for your account").
        limits.push({ ...describeUsage(limit, usage), sources: limit.sources });
      }
    }

    return { currency: iso, policyVersion: active.version, policySource: active.source, limits };
  }

  return { checkLimit, describeLimits, resolveOperation };
}

let shared = null;
const getLimitService = () => {
  if (!shared) shared = createLimitService();
  return shared;
};

module.exports = { createLimitService, getLimitService };
