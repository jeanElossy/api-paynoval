"use strict";

/**
 * ============================================================================
 * MOTEUR DE CALCUL DE TARIFICATION — DÉPLACÉ DEPUIS L'API GATEWAY LE 2026-09-10
 * ============================================================================
 *
 * ── Pourquoi ce fichier a changé de dépôt ───────────────────────────────────
 *
 * Le domaine des prix vivait dans la passerelle, et Tx-Core — le moteur
 * d'argent — lui demandait ses devis EN HTTP
 * (`services/transactions/shared/pricing.js` → `${GATEWAY_URL}/pricing/quote`).
 *
 * La dépendance remontait donc du cœur vers le bord. Tx-Core l'annonçait
 * lui-même au démarrage : « GATEWAY_URL absente ⇒ toute transaction nécessitant
 * un devis échouera en 503 ». Une panne de la passerelle arrêtait les virements
 * **depuis l'intérieur du moteur**, et la passerelle ne pouvait plus être
 * déployée ni redémarrée seule.
 *
 * Stripe, PayPal et Adyen tiennent la même règle : les dépendances DESCENDENT.
 * Le bord route et authentifie ; il ne possède aucun domaine et ne détient
 * aucune base. Le devis est désormais un appel de fonction dans le processus
 * qui en a besoin.
 *
 * ── Ce module est PUR ───────────────────────────────────────────────────────
 *
 * Aucun `require`, aucune entrée-sortie, aucun accès base. C'est ce qui le rend
 * testable sans connexion et ce qui doit le rester : la sélection du barème et
 * le calcul du prix ne doivent jamais dépendre de l'ordre dans lequel une base
 * répond.
 *
 * ── Résolution PARESSEUSE du modèle ─────────────────────────────────────────
 *
 * Le fichier d'origine faisait `require("../models/X")` au chargement, ce qui
 * fonctionnait parce que la passerelle liait ses modèles à la connexion
 * Mongoose GLOBALE, déjà ouverte. Tx-Core ouvre des connexions NOMMÉES, et
 * aucune n'existe au moment où ce module est requis.
 *
 * Le modèle est donc résolu à l'APPEL, par `getPricingModel`, qui LÈVE une
 * erreur nommée si la base n'est pas là. Un `require` au chargement aurait
 * échoué au démarrage ; un accès optionnel aurait rendu `undefined`, puis un
 * devis vide, puis un prix de zéro (règle B.2).
 */
function normStr(v) {
  const s = String(v ?? "").trim();
  return s ? s : "";
}

function upper(v) {
  return normStr(v).toUpperCase();
}

function lower(v) {
  return normStr(v).toLowerCase();
}

function stripAccents(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * ✅ Normalisation txType robuste
 */
function normalizeTxType(v) {
  const raw = upper(v);
  if (!raw) return "";

  if (raw === "TRANSFER" || raw === "DEPOSIT" || raw === "WITHDRAW") return raw;

  const low = lower(v);
  if (low === "send" || low === "p2p" || low === "transfer" || low === "transfert") {
    return "TRANSFER";
  }
  if (low === "deposit" || low === "topup" || low === "cashin") {
    return "DEPOSIT";
  }
  if (low === "withdraw" || low === "withdrawal" || low === "cashout" || low === "retrait") {
    return "WITHDRAW";
  }

  return raw;
}

/**
 * ✅ Normalisation method robuste
 */
function normalizeMethod(v) {
  const raw = upper(v);
  if (!raw) return "";

  if (["MOBILEMONEY", "BANK", "CARD", "INTERNAL"].includes(raw)) return raw;

  const low = lower(v);
  if (["mobilemoney", "mobile_money", "mm"].includes(low)) return "MOBILEMONEY";
  if (["bank", "wire", "virement", "transfer_bank"].includes(low)) return "BANK";
  if (["card", "visa", "mastercard"].includes(low)) return "CARD";
  if (["internal", "wallet", "paynoval"].includes(low)) return "INTERNAL";

  return raw;
}

/**
 * ✅ Country normalization (ISO2 preferred)
 */
const COUNTRY_ALIASES_TO_ISO2 = {
  FRANCE: "FR",
  FRENCH: "FR",
  FR: "FR",

  "COTE D'IVOIRE": "CI",
  "COTE D IVOIRE": "CI",
  "CÔTE D'IVOIRE": "CI",
  "CÔTE D IVOIRE": "CI",
  "IVORY COAST": "CI",
  CIV: "CI",
  CI: "CI",

  "BURKINA FASO": "BF",
  BF: "BF",

  MALI: "ML",
  ML: "ML",

  SENEGAL: "SN",
  "SÉNÉGAL": "SN",
  SN: "SN",

  CAMEROUN: "CM",
  CAMEROON: "CM",
  CM: "CM",

  CANADA: "CA",
  CA: "CA",

  USA: "US",
  "UNITED STATES": "US",
  "ETATS UNIS": "US",
  "ÉTATS UNIS": "US",
  US: "US",

  BELGIQUE: "BE",
  BELGIUM: "BE",
  BE: "BE",

  ALLEMAGNE: "DE",
  GERMANY: "DE",
  DE: "DE",
};

function normalizeCountryISO2(v) {
  const raw0 = stripAccents(v);
  const raw = upper(raw0);
  if (!raw) return null;

  if (/^[A-Z]{2}$/.test(raw)) return raw;
  if (raw === "CIV") return "CI";

  const mapped = COUNTRY_ALIASES_TO_ISO2[raw];
  if (mapped) return mapped;

  const cleaned = raw.replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim();
  return COUNTRY_ALIASES_TO_ISO2[cleaned] || null;
}

function countryTokens(v) {
  const rawUp = upper(stripAccents(v));
  const iso2 = normalizeCountryISO2(v);

  const tokens = [];
  if (iso2) tokens.push(iso2);
  if (rawUp) tokens.push(rawUp);

  return Array.from(new Set(tokens.filter(Boolean)));
}

/**
 * ⚠️ L'ARRONDI VIENT D'UN SEUL ENDROIT DEPUIS LE 2026-09-16.
 *
 * Cette fonction connaissait trois devises sans décimale (XOF, XAF, JPY) là où
 * la validation du devis en connaissait sept et les helpers de transaction dix.
 * Un montant en franc guinéen était donc arrondi au centime par le moteur —
 * une sous-unité qui n'existe pas — puis contrôlé à l'unité ailleurs.
 *
 * La méthode retenue est celle qui était déjà appliquée ici, parce que c'est
 * elle qui FACTURE : l'aligner sur l'autre aurait changé des prix sans décision.
 */
const {
  decimalsForCurrency,
  roundMoney,
} = require("../../utils/money");

const { appliedRateFor } = require("./fxModes");

function inRange(amount, range) {
  const a = Number(amount);
  const min = Number(range?.min ?? 0);
  const max = range?.max == null ? null : Number(range.max);

  if (!Number.isFinite(a)) return false;
  if (a < min) return false;
  if (max != null && a > max) return false;
  return true;
}

function isWildcardUpper(v) {
  const s = upper(v);
  return !s || s === "ALL" || s === "*";
}

function isWildcardLower(v) {
  const s = lower(v);
  return !s || s === "all" || s === "*";
}

function matchesOptionalList(value, list) {
  if (!Array.isArray(list) || list.length === 0) return true;
  if (!value) return false;

  const v = upper(stripAccents(value));
  return list.some((x) => upper(stripAccents(x)) === v);
}

function matchesCountries(reqCountry, ruleCountries) {
  if (!Array.isArray(ruleCountries) || ruleCountries.length === 0) return true;

  const tokens = countryTokens(reqCountry);
  if (!tokens.length) return false;

  return tokens.some((t) => matchesOptionalList(t, ruleCountries));
}

function matchScopeUpper(reqVal, ruleVal) {
  if (isWildcardUpper(ruleVal)) return true;
  return upper(reqVal) === upper(ruleVal);
}

function matchScopeLower(reqVal, ruleVal) {
  if (isWildcardLower(ruleVal)) return true;
  return lower(reqVal) === lower(ruleVal);
}

function matchScopeCountry(reqVal, ruleVal) {
  if (isWildcardUpper(ruleVal) || isWildcardLower(ruleVal)) return true;

  const reqIso = normalizeCountryISO2(reqVal);
  const ruleIso = normalizeCountryISO2(ruleVal);

  if (reqIso && ruleIso) return reqIso === ruleIso;

  return upper(stripAccents(reqVal)) === upper(stripAccents(ruleVal));
}

/**
 * Fenêtre de validité d'une règle.
 *
 * `startsAt`/`endsAt` existaient dans le modèle mais n'étaient lus nulle part :
 * une règle programmée s'appliquait immédiatement, une règle expirée
 * s'appliquait pour toujours. L'évaluation se fait à chaque devis, ce qui
 * évite toute tâche planifiée.
 */
function isWithinWindow(rule, nowMs) {
  const startsAt = rule?.startsAt ? new Date(rule.startsAt).getTime() : null;
  const endsAt = rule?.endsAt ? new Date(rule.endsAt).getTime() : null;

  if (Number.isFinite(startsAt) && nowMs < startsAt) return false;
  if (Number.isFinite(endsAt) && nowMs > endsAt) return false;

  return true;
}

function computeSpecificity(rule) {
  let score = 0;
  const sc = rule?.scope || {};

  if (!isWildcardUpper(sc.txType)) score += 60;
  if (!isWildcardUpper(sc.method)) score += 50;
  if (!isWildcardLower(sc.provider)) score += 45;

  if (!isWildcardUpper(sc.country)) score += 20;
  if (!isWildcardUpper(sc.fromCountry)) score += 35;
  if (!isWildcardUpper(sc.toCountry)) score += 35;

  if (!isWildcardUpper(sc.fromCurrency)) score += 25;
  if (!isWildcardUpper(sc.toCurrency)) score += 25;

  if (Array.isArray(rule?.countries) && rule.countries.length) score += 15;
  if (Array.isArray(rule?.operators) && rule.operators.length) score += 10;

  if (rule?.amountRange?.min != null) score += 5;
  if (rule?.amountRange?.max != null) score += 5;

  return score;
}

/**
 * ✅ Sélectionne la meilleure règle
 */
function pickBestRule(rules, req) {
  const txType = normalizeTxType(req.txType);
  const method = normalizeMethod(req.method);
  const fromCurrency = upper(req.fromCurrency);
  const toCurrency = upper(req.toCurrency);

  const reqCountryRaw = req.country ? String(req.country) : null;
  const reqFromCountryRaw = req.fromCountry ? String(req.fromCountry) : null;
  const reqToCountryRaw = req.toCountry ? String(req.toCountry) : null;

  const provider = req.provider ? lower(req.provider) : "";
  const operator =
    req.operator != null && String(req.operator).trim()
      ? lower(stripAccents(req.operator))
      : null;

  const amount = Number(req.amount);
  const nowMs = Number.isFinite(Number(req.now)) ? Number(req.now) : Date.now();

  const candidates = (rules || []).filter((r) => {
    if (!r?.active) return false;
    if (!isWithinWindow(r, nowMs)) return false;

    const sc = r?.scope || {};

    if (!matchScopeUpper(txType, sc.txType)) return false;
    if (!matchScopeUpper(method, sc.method)) return false;
    if (!matchScopeLower(provider, sc.provider)) return false;
    if (!matchScopeUpper(fromCurrency, sc.fromCurrency)) return false;
    if (!matchScopeUpper(toCurrency, sc.toCurrency)) return false;

    const hasFromCountryRule = !isWildcardUpper(sc.fromCountry) && !isWildcardLower(sc.fromCountry);
    const hasToCountryRule = !isWildcardUpper(sc.toCountry) && !isWildcardLower(sc.toCountry);
    const hasExplicitCorridor = hasFromCountryRule || hasToCountryRule;

    if (hasExplicitCorridor) {
      if (!matchScopeCountry(reqFromCountryRaw, sc.fromCountry)) return false;
      if (!matchScopeCountry(reqToCountryRaw, sc.toCountry)) return false;
    } else {
      if (!matchScopeCountry(reqCountryRaw, sc.country)) return false;
    }

    if (!inRange(amount, r?.amountRange)) return false;
    if (!matchesCountries(reqCountryRaw, r?.countries)) return false;
    if (!matchesOptionalList(operator, r?.operators)) return false;

    return true;
  });

  candidates.sort((a, b) => {
    const sa = computeSpecificity(a);
    const sb = computeSpecificity(b);
    if (sb !== sa) return sb - sa;

    const pa = Number(a?.priority ?? 0);
    const pb = Number(b?.priority ?? 0);
    if (pb !== pa) return pb - pa;

    const raMin = Number(a?.amountRange?.min ?? 0);
    const rbMin = Number(b?.amountRange?.min ?? 0);
    if (rbMin !== raMin) return rbMin - raMin;

    const ua = new Date(a?.updatedAt || 0).getTime();
    const ub = new Date(b?.updatedAt || 0).getTime();
    return ub - ua;
  });

  return candidates[0] || null;
}

function computeFee(amount, feeCfg, fromCurrency) {
  const mode = upper(feeCfg?.mode || "NONE");
  const percent = Number(feeCfg?.percent ?? 0);
  const fixed = Number(feeCfg?.fixed ?? 0);

  let feeRaw = 0;

  if (mode === "PERCENT") {
    feeRaw = (Number(amount) * percent) / 100;
  } else if (mode === "FIXED") {
    feeRaw = fixed;
  } else if (mode === "MIXED") {
    feeRaw = (Number(amount) * percent) / 100 + fixed;
  }

  let fee = feeRaw;

  const minFee = feeCfg?.minFee == null ? null : Number(feeCfg.minFee);
  const maxFee = feeCfg?.maxFee == null ? null : Number(feeCfg.maxFee);

  if (minFee != null && fee < minFee) fee = minFee;
  if (maxFee != null && fee > maxFee) fee = maxFee;

  fee = roundMoney(fee, fromCurrency);

  return {
    fee,
    breakdown: {
      mode,
      percent,
      fixed,
      minFee,
      maxFee,
      feeRaw: roundMoney(feeRaw, fromCurrency),
    },
  };
}

/**
 * ✅ fallback peg XOF/EUR
 */
function pegRate(from, to) {
  const PEG_XOF_PER_EUR = Number(process.env.PEG_XOF_PER_EUR || 655.957);

  const f = upper(from);
  const t = upper(to);

  if (!Number.isFinite(PEG_XOF_PER_EUR) || PEG_XOF_PER_EUR <= 0) return null;

  if (f === "XOF" && t === "EUR") return 1 / PEG_XOF_PER_EUR;
  if (f === "EUR" && t === "XOF") return PEG_XOF_PER_EUR;

  return null;
}

/**
 * Revenu de change, en devise de réception.
 *
 *   idéal   = netFrom × marketRate
 *   réel    = netFrom × appliedRate
 *   signé   = idéal − réel          (négatif : le client a reçu PLUS que le marché)
 *   amount  = max(0, signé)         (seul un gain se crédite à la trésorerie)
 *
 * ⚠️ JUSQU'AU 2026-09-16, SEUL LE PLANCHER EXISTAIT. Une marge négative
 * devenait `amount: 0`, exactement comme une absence de marge : la perte ne
 * figurait ni au devis, ni sur la transaction, ni à la réconciliation. On garde
 * le plancher pour le CRÉDIT (on ne crédite pas une trésorerie d'un montant
 * négatif), mais la valeur signée et le sens de l'écart voyagent désormais avec
 * le devis — une perte se voit, elle ne se confond plus avec un zéro.
 */
function computeFxRevenue({ netFrom, marketRate, appliedRate, toCurrency }) {
  const safeNetFrom = Number(netFrom || 0);
  const safeMarket = Number(marketRate || 0);
  const safeApplied = Number(appliedRate || 0);

  const idealNetTo = safeNetFrom * safeMarket;
  const actualNetTo = safeNetFrom * safeApplied;
  const signedRaw = idealNetTo - actualNetTo;
  const rawAmount = Math.max(0, signedRaw);
  const signedAmount = roundMoney(signedRaw, toCurrency);

  return {
    toCurrency: upper(toCurrency),
    measured: true,
    rawAmount,
    amount: roundMoney(rawAmount, toCurrency),
    signedAmount,
    favorsCustomer: signedAmount < 0,
    idealNetTo: roundMoney(idealNetTo, toCurrency),
    actualNetTo: roundMoney(actualNetTo, toCurrency),
  };
}

/**
 * @param {object} params
 * @param {object} params.req
 * @param {Array} params.rules
 * @param {function} params.getMarketRate
 */
async function computeQuote({ req, rules, getMarketRate }) {
  const amount = Number(req.amount);
  const fromCurrency = upper(req.fromCurrency);
  const toCurrency = upper(req.toCurrency);

  const txType = normalizeTxType(req.txType);
  const method = normalizeMethod(req.method);

  const countryISO2 = req.country ? normalizeCountryISO2(req.country) : null;
  const fromCountryISO2 = req.fromCountry ? normalizeCountryISO2(req.fromCountry) : null;
  const toCountryISO2 = req.toCountry ? normalizeCountryISO2(req.toCountry) : null;

  const operator =
    req.operator != null && String(req.operator).trim()
      ? lower(stripAccents(req.operator))
      : null;

  const provider =
    req.provider != null && String(req.provider).trim()
      ? lower(stripAccents(req.provider))
      : null;

  if (!Number.isFinite(amount) || amount <= 0) {
    const err = new Error("Invalid amount");
    err.status = 400;
    throw err;
  }

  if (!fromCurrency || !toCurrency) {
    const err = new Error("Missing currency");
    err.status = 400;
    throw err;
  }

  if (!txType) {
    const err = new Error("Missing txType");
    err.status = 400;
    throw err;
  }

  const rule = pickBestRule(rules, {
    ...req,
    txType,
    method,
    provider,
    country: countryISO2 || req.country,
    fromCountry: fromCountryISO2 || req.fromCountry,
    toCountry: toCountryISO2 || req.toCountry,
    operator,
  });

  if (!rule) {
    const err = new Error("No pricing rule matched");
    err.status = 404;
    err.details = {
      normalizedRequest: {
        txType,
        method,
        amount,
        fromCurrency,
        toCurrency,
        country: countryISO2 || (req.country ? upper(stripAccents(req.country)) : null),
        fromCountry:
          fromCountryISO2 || (req.fromCountry ? upper(stripAccents(req.fromCountry)) : null),
        toCountry: toCountryISO2 || (req.toCountry ? upper(stripAccents(req.toCountry)) : null),
        provider: provider || null,
        operator: operator || null,
      },
      rulesLoaded: Array.isArray(rules) ? rules.length : 0,
      hint:
        "Crée une PricingRule ACTIVE avec scope adapté (txType, method, fromCurrency, toCurrency, corridor/provider) + range.",
    };
    throw err;
  }

  const { fee, breakdown } = computeFee(amount, rule.fee, fromCurrency);
  const grossFrom = roundMoney(amount, fromCurrency);
  const netFrom = roundMoney(grossFrom - fee, fromCurrency);

  if (netFrom < 0) {
    const err = new Error("Fee exceeds amount");
    err.status = 400;
    throw err;
  }

  const fxMode = upper(rule?.fx?.mode || "PASS_THROUGH");
  let marketRate = null;
  let appliedRate = null;

  /**
   * ══════════════════════════════════════════════════════════════════════════
   * PAS DE CHANGE ⇒ PAS DE MARGE DE CHANGE (2026-09-16)
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ── Le défaut fermé ici ─────────────────────────────────────────────────
   *
   * Sur un corridor en devise IDENTIQUE, le taux de marché vaut 1 — et une
   * règle en `MARKUP_PERCENT` l'appliquait quand même : `1 × (1 − 1,5/100)`,
   * soit **0,985**. L'expéditeur envoyait 10 000 XOF, le bénéficiaire en
   * recevait 9 850, sans qu'aucune conversion n'ait eu lieu. Une « marge de
   * change » sans change n'est pas une marge : c'est un frais caché, qui
   * n'apparaît sur aucune ligne de frais.
   *
   * Les six règles en base évitaient le piège par CONVENTION — CI→CI et CA→CA
   * sont en `PASS_THROUGH`. Une convention n'est pas une garantie : la
   * première règle « toutes devises » avec marge aurait raboté chaque virement
   * en devise identique, et rien ne l'aurait signalé.
   *
   * C'est déjà la règle explicite du module Cagnotte (« même devise ⇒ aucun
   * taux, même si une règle en déclare un »). Elle vaut pour tout le moteur.
   *
   * ⚠️ `OVERRIDE` est concerné aussi : imposer un taux ≠ 1 entre deux comptes
   * de la même devise ferait apparaître ou disparaître de l'argent.
   */
  if (fromCurrency === toCurrency) {
    marketRate = 1;
    appliedRate = 1;
  } else if (fxMode === "OVERRIDE") {
    appliedRate = appliedRateFor({ mode: fxMode, fx: rule?.fx });

    if (appliedRate === null) {
      const err = new Error("Invalid overrideRate");
      err.status = 500;
      throw err;
    }

    /**
     * Le taux du marché est CITÉ même quand une règle impose le taux
     * (2026-09-16). Sans lui, la marge contenue dans un taux imposé n'était
     * jamais mesurée — donc jamais créditée à la trésorerie de marge — et un
     * taux imposé au-dessus du marché perdait de l'argent sans que rien ne le
     * montre. Son absence n'arrête PAS la cotation : le taux client est connu,
     * seule la mesure de la marge manque, et le devis le dit (`measured: false`).
     */
    try {
      marketRate = await getMarketRate(fromCurrency, toCurrency);
    } catch {
      marketRate = null;
    }

    if (!Number.isFinite(marketRate) || marketRate <= 0) {
      const peg = pegRate(fromCurrency, toCurrency);
      marketRate = Number.isFinite(peg) && peg > 0 ? peg : null;
    }
  } else {
    marketRate = await getMarketRate(fromCurrency, toCurrency);

    if (!Number.isFinite(marketRate) || marketRate <= 0) {
      const peg = pegRate(fromCurrency, toCurrency);
      if (Number.isFinite(peg) && peg > 0) marketRate = peg;
    }

    if (!Number.isFinite(marketRate) || marketRate <= 0) {
      const err = new Error("FX rate unavailable");
      err.status = 503;
      err.details = { fromCurrency, toCurrency, fxMode };
      throw err;
    }

    // Une seule formule pour le moteur et pour les contrôles de gouvernance.
    appliedRate = appliedRateFor({ mode: fxMode, fx: rule?.fx, marketRate });
  }

  if (!Number.isFinite(appliedRate) || appliedRate <= 0) {
    const err = new Error("Invalid appliedRate");
    err.status = 500;
    throw err;
  }

  const netToRaw = netFrom * appliedRate;
  const netTo = roundMoney(netToRaw, toCurrency);

  const fxRevenue =
    Number.isFinite(marketRate) && marketRate > 0
      ? computeFxRevenue({ netFrom, marketRate, appliedRate, toCurrency })
      : {
          toCurrency,
          measured: false,
          rawAmount: 0,
          amount: 0,
          signedAmount: null,
          favorsCustomer: null,
          idealNetTo: null,
          actualNetTo: netTo,
        };

  return {
    request: {
      txType,
      method,
      amount: grossFrom,
      fromCurrency,
      toCurrency,
      country: countryISO2 || (req.country ? upper(stripAccents(req.country)) : null),
      fromCountry:
        fromCountryISO2 || (req.fromCountry ? upper(stripAccents(req.fromCountry)) : null),
      toCountry: toCountryISO2 || (req.toCountry ? upper(stripAccents(req.toCountry)) : null),
      provider: provider || null,
      operator: operator || null,
    },
    result: {
      marketRate: marketRate == null ? null : Number(marketRate),
      appliedRate: Number(appliedRate),
      fee,
      feeBreakdown: breakdown,
      grossFrom,
      netFrom,
      netTo,
      fxRevenue,
    },
    ruleApplied: {
      ruleId: rule._id,

      /**
       * ⚠️ LA VERSION VIENT DE `currentVersion`, PAS DE `version`.
       *
       * Ce champ lisait `rule.version`, que le workflow de gouvernance N'ÉCRIT
       * PLUS depuis qu'il versionne par `currentVersion` (le modèle le dit
       * lui-même : « conservé pour compatibilité de lecture »). Chaque
       * transaction citait donc la version 1, quelle que soit la version
       * réellement appliquée.
       *
       * Conséquence, mesurée le 2026-09-16 : tout l'appareil de versionnage —
       * `PricingRuleVersion`, snapshots immuables, circuit à quatre yeux —
       * était inexploitable en litige, puisque la transaction ne désignait pas
       * la version qui l'avait tarifée.
       *
       * `version` est conservé sous son ancien nom pour les lecteurs existants,
       * mais alimenté par la bonne source.
       */
      version: Number(rule.currentVersion ?? rule.version ?? 1),
      currentVersion: Number(rule.currentVersion ?? rule.version ?? 1),
      priority: Number(rule.priority ?? 0),
    },
  };
}

module.exports = {
  computeQuote,
  computeFee,
  computeFxRevenue,
  roundMoney,
  decimalsForCurrency,
  normalizeTxType,
  normalizeMethod,
  normalizeCountryISO2,
  // Exportés pour les tests et pour la détection de couverture.
  pickBestRule,
  isWithinWindow,
};