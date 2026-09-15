"use strict";

/**
 * ============================================================================
 * ÉCRITURES D'UNE CAGNOTTE — CONSTRUCTION PURE DES LOTS
 * ============================================================================
 *
 * Ce module décide COMMENT se book un mouvement de cagnotte ; il n'écrit rien.
 * `ledgerService.postCagnotteLotEntries` pose les lots, dans la session de
 * l'appelant. La séparation a une raison : la forme des écritures est la
 * partie qui doit être prouvée, et elle se prouve sans base — `checkBalanced`
 * sur chaque lot, pour chaque corridor de la matrice des devises.
 *
 * ── La forme (S = devise source, T = devise de la cagnotte) ─────────────────
 *
 *   frais         DEBIT origine:S          f    → CREDIT treasury CAGNOTTE_FEES:S f
 *   S = T         DEBIT origine:S          n    → CREDIT CAGNOTTE_VAULT:T         n
 *   S ≠ T         DEBIT origine:S          n    → CREDIT FX_CONVERSION:S          n
 *                 DEBIT FX_CONVERSION:T  m+x    → CREDIT CAGNOTTE_VAULT:T         m
 *                                                 CREDIT treasury FX_MARGIN:T     x
 *
 * `origine` = portefeuille du payeur (application) ou entrée prestataire du
 * rail (invité). La règle qui structure tout : **`CAGNOTTE_VAULT` ne reçoit
 * jamais que la devise de la cagnotte.**
 *
 * Remboursement : contre-écriture exacte, au TAUX D'ORIGINE, au prorata.
 * Les frais et la marge de change ne sont pas remboursés (politique écrite
 * dans `docs/architecture/cagnotte-module.md`).
 */

const {
  userWalletAccountId,
  cagnotteVaultClearingAccountId,
  fxConversionClearingAccountId,
  providerInboundClearingAccountId,
  providerOutboundClearingAccountId,
  treasuryAccountId,
  transferLegs,
  assertBalanced,
} = require("./doubleEntry");

const { roundMoney, decimalsForCurrency } = require("../pricing/pricingEngine");

function upper(v) {
  return String(v ?? "").trim().toUpperCase();
}

function legsError(code, message, status = 500) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  err.statusCode = status;
  return err;
}

/** Demi-plus-petite unité de la devise : la tolérance d'un arrondi honnête. */
function epsilon(currency) {
  return 0.5 / 10 ** decimalsForCurrency(currency);
}

function money(value, currency, name, { allowZero = false } = {}) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    throw legsError("CAGNOTTE_LEGS_INVALID", `${name} illisible (${value}).`);
  }

  const r = roundMoney(n, currency);

  if (allowZero ? r < 0 : r <= 0) {
    throw legsError(
      "CAGNOTTE_LEGS_INVALID",
      `${name} doit être ${allowZero ? "positif ou nul" : "strictement positif"} (reçu ${value} ${currency}).`
    );
  }

  return r;
}

function originAccount(origin, currency) {
  const kind = upper(origin?.kind);

  if (kind === "USER_WALLET") {
    const userId = String(origin?.userId || "").trim();
    if (!userId) {
      throw legsError("CAGNOTTE_LEGS_INVALID", "origine USER_WALLET sans userId.");
    }
    return {
      accountType: "USER_WALLET",
      accountId: userWalletAccountId(userId, currency),
      userId,
    };
  }

  if (kind === "PROVIDER_INBOUND") {
    return {
      accountType: "SYSTEM_CLEARING",
      accountId: providerInboundClearingAccountId(origin?.rail, currency),
      userId: null,
    };
  }

  throw legsError(
    "CAGNOTTE_LEGS_INVALID",
    `origine inconnue : « ${origin?.kind} ». Attendu USER_WALLET ou PROVIDER_INBOUND.`
  );
}

function treasuryAccount(treasury, currency, label) {
  const userId = String(treasury?.userId || "").trim();
  const systemType = upper(treasury?.systemType);

  if (!userId || !systemType) {
    throw legsError(
      "TREASURY_UNCONFIGURED",
      `Trésorerie ${label} non configurée : des fonds sans compte de destination ` +
        "ne s'encaissent pas « quelque part »."
    );
  }

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

function vaultAccount(currency) {
  return {
    accountType: "SYSTEM_CLEARING",
    accountId: cagnotteVaultClearingAccountId(currency),
    userId: null,
  };
}

function fxAccount(currency) {
  return {
    accountType: "SYSTEM_CLEARING",
    accountId: fxConversionClearingAccountId(currency),
    userId: null,
  };
}

/**
 * Lots d'un CRÉDIT de coffre (participation application ou invité).
 *
 * @param {object} p
 * @param {{kind: "USER_WALLET"|"PROVIDER_INBOUND", userId?: string, rail?: string}} p.origin
 * @param {string} p.sourceCurrency  devise payée
 * @param {string} p.targetCurrency  devise de la cagnotte
 * @param {number} p.gross           montant payé (frais inclus), en S
 * @param {number} p.fee             frais, en S
 * @param {number} p.netSource       gross − fee, en S
 * @param {number} p.netTarget       ce que reçoit le coffre, en T
 * @param {number} [p.fxRevenue]     marge de change, en T
 * @param {{userId: string, systemType: string}} [p.feesTreasury]
 * @param {{userId: string, systemType: string}} [p.fxMarginTreasury]
 * @returns {Array<{scope: string, entryType: string, stage: string, legs: object[]}>}
 */
function buildCagnotteCreditLots({
  origin,
  sourceCurrency,
  targetCurrency,
  gross,
  fee,
  netSource,
  netTarget,
  fxRevenue = 0,
  feesTreasury = null,
  fxMarginTreasury = null,
}) {
  const S = upper(sourceCurrency);
  const T = upper(targetCurrency);

  if (!S || !T) {
    throw legsError("CAGNOTTE_LEGS_INVALID", "Devise source ou cible absente.");
  }

  const g = money(gross, S, "gross");
  const f = money(fee, S, "fee", { allowZero: true });
  const n = money(netSource, S, "netSource");
  const m = money(netTarget, T, "netTarget");
  const x = money(fxRevenue, T, "fxRevenue", { allowZero: true });

  if (Math.abs(g - f - n) > epsilon(S)) {
    throw legsError(
      "CAGNOTTE_LEGS_INCONSISTENT",
      `brut − frais ≠ net source (${g} − ${f} ≠ ${n} ${S}). Un écart ici est de ` +
        "l'argent créé ou perdu à l'arrondi."
    );
  }

  const sameCurrency = S === T;

  if (sameCurrency && (Math.abs(n - m) > epsilon(T) || x > 0)) {
    throw legsError(
      "CAGNOTTE_LEGS_INCONSISTENT",
      `Aucun taux ne s'applique à une même devise : net source ${n} ${S} doit ` +
        `valoir net cible ${m} ${T}, sans marge de change (reçu ${x}).`
    );
  }

  const entryOrigin =
    upper(origin?.kind) === "USER_WALLET" ? "USER_DEBIT" : "SYSTEM_TRANSFER";

  const lots = [];

  if (f > 0) {
    lots.push({
      scope: "cagnotte.credit.fee",
      entryType: "FEE_REVENUE",
      stage: "cagnotte-fee",
      legs: transferLegs({
        from: originAccount(origin, S),
        to: treasuryAccount(feesTreasury, S, "des frais de cagnotte"),
        amount: f,
        currency: S,
      }),
    });
  }

  if (sameCurrency) {
    lots.push({
      scope: "cagnotte.credit.vault",
      entryType: entryOrigin,
      stage: "cagnotte-credit",
      legs: transferLegs({
        from: originAccount(origin, S),
        to: vaultAccount(T),
        amount: m,
        currency: T,
      }),
    });
  } else {
    lots.push({
      scope: "cagnotte.credit.fx-source",
      entryType: entryOrigin,
      stage: "cagnotte-fx-source",
      legs: transferLegs({
        from: originAccount(origin, S),
        to: fxAccount(S),
        amount: n,
        currency: S,
      }),
    });

    const legsT = [
      { ...fxAccount(T), direction: "DEBIT", amount: roundMoney(m + x, T), currency: T },
      { ...vaultAccount(T), direction: "CREDIT", amount: m, currency: T },
    ];

    if (x > 0) {
      legsT.push({
        ...treasuryAccount(fxMarginTreasury, T, "de marge de change"),
        direction: "CREDIT",
        amount: x,
        currency: T,
        entryType: "FX_REVENUE",
      });
    }

    lots.push({
      scope: "cagnotte.credit.fx-target",
      entryType: "FX_CONVERSION",
      stage: "cagnotte-fx-target",
      legs: legsT,
    });
  }

  for (const lot of lots) assertBalanced(lot.legs, lot.scope);

  return lots;
}

/**
 * Montants d'un remboursement, au taux d'origine.
 *
 * Le dernier remboursement solde EXACTEMENT le restant source : le prorata
 * accumule des arrondis, et les solder à la fin empêche qu'un centime reste
 * bloqué — ou soit versé deux fois — sur une participation remboursée en
 * plusieurs fois.
 */
function computeRefundAmounts({
  sourceCurrency,
  targetCurrency,
  netSource,
  netTarget,
  refundedSource = 0,
  refundedTarget = 0,
  requestedTarget = null,
}) {
  const S = upper(sourceCurrency);
  const T = upper(targetCurrency);

  const nS = money(netSource, S, "netSource");
  const nT = money(netTarget, T, "netTarget");

  const remainingTarget = roundMoney(nT - Number(refundedTarget || 0), T);
  const remainingSource = roundMoney(nS - Number(refundedSource || 0), S);

  if (remainingTarget <= 0 || remainingSource <= 0) {
    throw legsError("NOTHING_TO_REFUND", "Cette participation est déjà entièrement remboursée.", 409);
  }

  const target =
    requestedTarget == null ? remainingTarget : roundMoney(Number(requestedTarget), T);

  if (!Number.isFinite(target) || target <= 0) {
    throw legsError("INVALID_REFUND_AMOUNT", "Montant de remboursement invalide.", 400);
  }

  if (target > remainingTarget + epsilon(T)) {
    throw legsError(
      "REFUND_EXCEEDS_REMAINING",
      `Remboursement de ${target} ${T} supérieur au restant remboursable (${remainingTarget} ${T}).`,
      409
    );
  }

  const isFinal = Math.abs(target - remainingTarget) <= epsilon(T);

  const source = isFinal
    ? remainingSource
    : S === T
    ? target
    : roundMoney((nS * target) / nT, S);

  if (!(source > 0)) {
    throw legsError(
      "REFUND_TOO_SMALL",
      `Montant trop faible : ${target} ${T} ne correspond à aucune unité en ${S}.`,
      400
    );
  }

  if (source > remainingSource + epsilon(S)) {
    throw legsError(
      "REFUND_EXCEEDS_REMAINING",
      `Le prorata source (${source} ${S}) dépasse le restant (${remainingSource} ${S}).`,
      409
    );
  }

  return { refundTarget: target, refundSource: source, isFinal };
}

/**
 * Lots d'un remboursement vers le portefeuille du payeur : contre-écriture de
 * la participation, au taux d'origine.
 */
function buildCagnotteRefundLots({
  payerUserId,
  sourceCurrency,
  targetCurrency,
  refundSource,
  refundTarget,
}) {
  const S = upper(sourceCurrency);
  const T = upper(targetCurrency);
  const s = money(refundSource, S, "refundSource");
  const t = money(refundTarget, T, "refundTarget");
  const payer = originAccount({ kind: "USER_WALLET", userId: payerUserId }, S);

  const lots = [];

  if (S === T) {
    if (Math.abs(s - t) > epsilon(T)) {
      throw legsError(
        "CAGNOTTE_LEGS_INCONSISTENT",
        `Remboursement en même devise : source ${s} ≠ cible ${t}.`
      );
    }

    lots.push({
      scope: "cagnotte.refund.credit",
      entryType: "REFUND",
      stage: "cagnotte-refund",
      legs: transferLegs({ from: vaultAccount(T), to: payer, amount: t, currency: T }),
    });
  } else {
    lots.push({
      scope: "cagnotte.refund.fx-target",
      entryType: "REVERSAL",
      stage: "cagnotte-refund-fx-target",
      legs: transferLegs({ from: vaultAccount(T), to: fxAccount(T), amount: t, currency: T }),
    });

    lots.push({
      scope: "cagnotte.refund.fx-source",
      entryType: "REFUND",
      stage: "cagnotte-refund-fx-source",
      legs: transferLegs({ from: fxAccount(S), to: payer, amount: s, currency: S }),
    });
  }

  for (const lot of lots) assertBalanced(lot.legs, lot.scope);

  return lots;
}

/**
 * Remboursement d'un INVITÉ (2026-09-15) : l'argent sort du coffre vers le
 * compte de SORTIE prestataire, dans la devise où l'invité a payé.
 *
 *   même devise :  CAGNOTTE_VAULT:T → PROVIDER_OUTBOUND:<RAIL>:T
 *   conversion  :  CAGNOTTE_VAULT:T → FX_CONVERSION:T
 *                  FX_CONVERSION:S  → PROVIDER_OUTBOUND:<RAIL>:S
 *
 * `reverse: true` rend la contre-écriture EXACTE (versement refusé par
 * l'opérateur) : mêmes montants, sens inversé, type REVERSAL. On n'efface
 * jamais le lot d'origine (invariant 4).
 */
function buildCagnotteGuestRefundLots({
  rail,
  sourceCurrency,
  targetCurrency,
  refundSource,
  refundTarget,
  reverse = false,
}) {
  const S = upper(sourceCurrency);
  const T = upper(targetCurrency);
  const s = money(refundSource, S, "refundSource");
  const t = money(refundTarget, T, "refundTarget");
  const outbound = {
    accountType: "SYSTEM_CLEARING",
    accountId: providerOutboundClearingAccountId(rail, S),
    userId: null,
  };
  const suffix = reverse ? ".reversal" : "";

  const legs = (from, to, amount, currency) =>
    reverse
      ? transferLegs({ from: to, to: from, amount, currency })
      : transferLegs({ from, to, amount, currency });

  const lots = [];

  if (S === T) {
    if (Math.abs(s - t) > epsilon(T)) {
      throw legsError(
        "CAGNOTTE_LEGS_INCONSISTENT",
        `Remboursement invité en même devise : source ${s} ≠ cible ${t}.`
      );
    }

    lots.push({
      scope: `cagnotte.guest-refund.payout${suffix}`,
      entryType: reverse ? "REVERSAL" : "REFUND",
      stage: "cagnotte-guest-refund",
      legs: legs(vaultAccount(T), outbound, t, T),
    });
  } else {
    lots.push({
      scope: `cagnotte.guest-refund.fx-target${suffix}`,
      entryType: "REVERSAL",
      stage: "cagnotte-guest-refund-fx-target",
      legs: legs(vaultAccount(T), fxAccount(T), t, T),
    });

    lots.push({
      scope: `cagnotte.guest-refund.fx-source${suffix}`,
      entryType: reverse ? "REVERSAL" : "REFUND",
      stage: "cagnotte-guest-refund-fx-source",
      legs: legs(fxAccount(S), outbound, s, S),
    });
  }

  for (const lot of lots) assertBalanced(lot.legs, lot.scope);

  return lots;
}

module.exports = {
  buildCagnotteCreditLots,
  buildCagnotteRefundLots,
  buildCagnotteGuestRefundLots,
  computeRefundAmounts,
  epsilon,
};
