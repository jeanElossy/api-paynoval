"use strict";

/**
 * ============================================================================
 * VÉRIFICATION D'INTÉGRATION — « 100 ÉVÉNEMENTS, 1 SEUL CRÉDIT » (§23, §24)
 * ============================================================================
 *
 * POURQUOI CE SCRIPT EXISTE À CÔTÉ DE LA SUITE DE TESTS
 * -----------------------------------------------------
 * `test/referralIdempotency.test.js` vérifie l'ALGORITHME sans base : c'est la
 * contrainte de la suite (logique pure, ni `.env` ni MongoDB). Or la garantie
 * réelle repose sur un INDEX UNIQUE MongoDB et sur le comportement des
 * transactions Mongo en concurrence. Ces deux choses ne se simulent pas
 * honnêtement — elles se mesurent.
 *
 * Ce script les mesure, contre une vraie base.
 *
 * CE QU'IL FAIT
 * -------------
 *   1. crée un versement fictif identifié par un `rewardId` unique ;
 *   2. lance N tentatives EN PARALLÈLE sur le registre `ReferralPayout` ;
 *   3. vérifie qu'exactement UNE a réussi et que N-1 ont été refusées ;
 *   4. nettoie derrière lui.
 *
 * CE QU'IL NE FAIT PAS
 * --------------------
 * Il ne déplace aucun argent réel : il exerce le VERROU, qui est le point
 * unique dont dépend la garantie. Pour un essai bout en bout avec mouvements
 * financiers, utiliser un environnement de préproduction et le parcours normal.
 *
 *   node scripts/verifyReferralIdempotency.js
 *   node scripts/verifyReferralIdempotency.js --attempts=500
 *
 * Sortie 0 si la garantie tient, 1 sinon.
 */

require("dotenv").config();

const mongoose = require("mongoose");
const crypto = require("crypto");

const { connectTransactionsDB, getTxConn } = require("../src/config/db");
const ReferralPayoutModel = require("../src/models/ReferralPayout");
const {
  buildPayoutIdempotencyKey,
  computeRequestFingerprint,
} = require("../src/services/referral/referralKeys");

function readArg(name, fallback) {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!found) return fallback;

  const value = Number(found.split("=")[1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

(async () => {
  const attempts = readArg("attempts", 100);

  const rewardId = `verify-${crypto.randomBytes(6).toString("hex")}`;
  const beneficiaryId = `beneficiary-${crypto.randomBytes(4).toString("hex")}`;

  let exitCode = 0;

  try {
    await connectTransactionsDB();

    const ReferralPayout = ReferralPayoutModel(getTxConn());

    /**
     * Indispensable : sans cette synchronisation, l'index unique peut ne pas
     * exister encore sur une base neuve, et le test passerait pour de mauvaises
     * raisons — c'est-à-dire qu'il ne testerait rien.
     */
    await ReferralPayout.syncIndexes();

    const key = buildPayoutIdempotencyKey(rewardId, beneficiaryId);

    const fingerprint = computeRequestFingerprint({
      rewardId,
      treasuryUserId: "verify-treasury",
      treasurySystemType: "REFERRAL_TREASURY",
      treasuryCurrency: "CAD",
      bonusInputCurrency: "XOF",
      beneficiaries: [
        { userId: beneficiaryId, role: "sponsor", amount: 2000, payoutCurrency: "XOF" },
      ],
    });

    const baseDoc = {
      idempotencyKey: key,
      requestFingerprint: fingerprint,
      rewardId,
      beneficiaryId,
      beneficiaryRole: "sponsor",
      treasuryUserId: "verify-treasury",
      treasurySystemType: "REFERRAL_TREASURY",
      creditedAmount: 2000,
      creditedCurrency: "XOF",
      treasuryDebitedAmount: 5,
      treasuryCurrency: "CAD",
      status: "succeeded",
      correlationId: `VERIFY-${rewardId}`,
    };

    let succeeded = 0;
    let rejected = 0;
    let unexpected = 0;

    // Toutes les tentatives partent ENSEMBLE : c'est la concurrence réelle qui
    // est éprouvée, pas une séquence déguisée en parallélisme.
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, () => ReferralPayout.create({ ...baseDoc }))
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        succeeded += 1;
      } else if (result.reason?.code === 11000) {
        rejected += 1;
      } else {
        unexpected += 1;
        console.error("  erreur inattendue :", result.reason?.message);
      }
    }

    const stored = await ReferralPayout.countDocuments({ idempotencyKey: key });

    const ok = succeeded === 1 && rejected === attempts - 1 && stored === 1;

    console.log("");
    console.log("  Vérification d'idempotence du versement de parrainage");
    console.log("  ────────────────────────────────────────────────────");
    console.log(`  tentatives simultanées   : ${attempts}`);
    console.log(`  versements acceptés      : ${succeeded}   (attendu : 1)`);
    console.log(`  refusés en doublon       : ${rejected}   (attendu : ${attempts - 1})`);
    console.log(`  erreurs inattendues      : ${unexpected}   (attendu : 0)`);
    console.log(`  documents en base        : ${stored}   (attendu : 1)`);
    console.log("");
    console.log(ok ? "  ✅ GARANTIE VÉRIFIÉE" : "  ❌ GARANTIE NON TENUE");
    console.log("");

    exitCode = ok ? 0 : 1;

    // Nettoyage : ce script ne doit rien laisser derrière lui.
    await ReferralPayout.deleteMany({ rewardId });
  } catch (err) {
    console.error("[verifyReferralIdempotency] echec", err?.message || err);
    exitCode = 2;
  } finally {
    await mongoose.disconnect().catch(() => {});
    process.exit(exitCode);
  }
})();
