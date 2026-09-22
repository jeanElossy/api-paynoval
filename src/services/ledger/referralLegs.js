"use strict";

/**
 * ============================================================================
 * PARTIE DOUBLE DU PARRAINAGE — MODULE PUR
 * ============================================================================
 *
 * Jusqu'au 2026-09-17, le versement d'un bonus écrivait deux lignes en partie
 * SIMPLE (un DEBIT trésorerie, un CREDIT portefeuille, potentiellement dans deux
 * devises) : elles ne s'équilibraient pas, ne portaient pas `ledgerVersion`, et
 * la balance de vérification ignorait donc tout le parrainage — une sortie
 * d'argent entière hors du filet de l'invariant 4.
 *
 * La raison invoquée était le rejeu partiel (« une jambe écrite, l'autre non »).
 * Elle ne tient plus : le versement s'exécute dans UNE transaction Mongo, clé
 * du registre comprise. Il n'existe pas d'état où une seule jambe survit.
 *
 * Même modèle de comptes que les cagnottes (`cagnotteLegs.js`) : une conversion
 * transite par `system_clearing:FX_CONVERSION:<devise>`, dont le déséquilibre
 * inter-devises EST la position de change.
 *
 *   même devise      DEBIT treasury:REFERRAL_TREASURY:<id>:CAD   CREDIT user_wallet:<u>:CAD
 *
 *   devises ≠        DEBIT treasury:…:CAD        CREDIT fx:CAD         (montant trésorerie)
 *                    DEBIT fx:XOF                CREDIT user_wallet:XOF (montant crédité)
 *
 * La reprise (clawback) est l'image miroir exacte, en `REVERSAL`.
 */

const {
  userWalletAccountId,
  fxConversionClearingAccountId,
  treasuryAccountId,
  transferLegs,
  assertBalanced,
} = require("./doubleEntry");

const { roundMoney } = require("../pricing/pricingEngine");

function upper(v) {
  return String(v ?? "").trim().toUpperCase();
}

function legsError(code, message) {
  const err = new Error(message);
  err.code = code;
  err.status = 500;
  return err;
}

function positive(value, currency, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw legsError("REFERRAL_LEGS_INVALID", `${name} illisible (${value}).`);
  }
  const r = roundMoney(n, currency);
  if (!(r > 0)) {
    throw legsError(
      "REFERRAL_LEGS_INVALID",
      `${name} doit être strictement positif (reçu ${value} ${currency}).`
    );
  }
  return r;
}

function required(value, name) {
  const s = String(value ?? "").trim();
  if (!s) throw legsError("REFERRAL_LEGS_INVALID", `${name} absent.`);
  return s;
}

function treasuryAccount({ userId, systemType, currency }) {
  return {
    accountType: "TREASURY",
    accountId: treasuryAccountId({
      treasuryUserId: userId,
      treasurySystemType: systemType,
      currency,
    }),
    userId,
  };
}

function walletAccount(userId, currency) {
  return {
    accountType: "USER_WALLET",
    accountId: userWalletAccountId(userId, currency),
    userId,
  };
}

function fxAccount(currency) {
  return {
    accountType: "SYSTEM_CLEARING",
    accountId: fxConversionClearingAccountId(currency),
    userId: null,
  };
}

function normalizeInput(p) {
  const T = upper(p.treasuryCurrency);
  const B = upper(p.beneficiaryCurrency);

  if (!T || !B) {
    throw legsError("REFERRAL_LEGS_INVALID", "Devise trésorerie ou bénéficiaire absente.");
  }

  const treasuryAmount = positive(p.treasuryAmount, T, "montant trésorerie");
  const beneficiaryAmount = positive(p.beneficiaryAmount, B, "montant bénéficiaire");

  if (T === B && Math.abs(treasuryAmount - beneficiaryAmount) > 0.5 / 100) {
    throw legsError(
      "REFERRAL_LEGS_INCONSISTENT",
      `Même devise ${T} : la trésorerie (${treasuryAmount}) et le bénéficiaire ` +
        `(${beneficiaryAmount}) doivent porter le même montant — un écart ici est ` +
        "de l'argent créé ou perdu."
    );
  }

  return {
    T,
    B,
    treasuryAmount,
    beneficiaryAmount,
    treasury: {
      userId: required(p.treasuryUserId, "treasuryUserId"),
      systemType: upper(required(p.treasurySystemType, "treasurySystemType")),
      currency: T,
    },
    beneficiaryId: required(p.beneficiaryId, "beneficiaryId"),
  };
}

/**
 * Lots du VERSEMENT d'un bonus à un bénéficiaire.
 *
 * @returns {Array<{scope: string, entryType: string, legs: object[]}>}
 */
function buildReferralPayoutLots(p) {
  const n = normalizeInput(p);
  const lots = [];

  if (n.T === n.B) {
    lots.push({
      scope: "referral.payout",
      entryType: "REFERRAL_PAYOUT",
      legs: transferLegs({
        from: treasuryAccount(n.treasury),
        to: walletAccount(n.beneficiaryId, n.B),
        amount: n.beneficiaryAmount,
        currency: n.B,
      }),
    });
  } else {
    lots.push({
      scope: "referral.payout.fx-source",
      entryType: "REFERRAL_PAYOUT",
      legs: transferLegs({
        from: treasuryAccount(n.treasury),
        to: fxAccount(n.T),
        amount: n.treasuryAmount,
        currency: n.T,
      }),
    });

    lots.push({
      scope: "referral.payout.fx-target",
      entryType: "FX_CONVERSION",
      legs: transferLegs({
        from: fxAccount(n.B),
        to: walletAccount(n.beneficiaryId, n.B),
        amount: n.beneficiaryAmount,
        currency: n.B,
      }),
    });
  }

  for (const lot of lots) assertBalanced(lot.legs, lot.scope);
  return lots;
}

/**
 * Lots de la REPRISE d'un bonus : image miroir exacte du versement.
 *
 * Les montants sont ceux du versement d'origine — pas de nouveau taux. La
 * trésorerie retrouve exactement ce qu'elle a déboursé.
 */
function buildReferralClawbackLots(p) {
  const n = normalizeInput(p);
  const lots = [];

  if (n.T === n.B) {
    lots.push({
      scope: "referral.clawback",
      entryType: "REVERSAL",
      legs: transferLegs({
        from: walletAccount(n.beneficiaryId, n.B),
        to: treasuryAccount(n.treasury),
        amount: n.beneficiaryAmount,
        currency: n.B,
      }),
    });
  } else {
    lots.push({
      scope: "referral.clawback.fx-source",
      entryType: "REVERSAL",
      legs: transferLegs({
        from: walletAccount(n.beneficiaryId, n.B),
        to: fxAccount(n.B),
        amount: n.beneficiaryAmount,
        currency: n.B,
      }),
    });

    lots.push({
      scope: "referral.clawback.fx-target",
      entryType: "REVERSAL",
      legs: transferLegs({
        from: fxAccount(n.T),
        to: treasuryAccount(n.treasury),
        amount: n.treasuryAmount,
        currency: n.T,
      }),
    });
  }

  for (const lot of lots) assertBalanced(lot.legs, lot.scope);
  return lots;
}

module.exports = {
  buildReferralPayoutLots,
  buildReferralClawbackLots,
};
