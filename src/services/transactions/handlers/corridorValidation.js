"use strict";

const createError = require("http-errors");

/**
 * Validation centrale des corridors PayNoval.
 *
 * Règles :
 * - Le mobile ne doit jamais être la source de vérité finale.
 * - PayNoval interne : pays/devise verrouillés depuis les profils sender + receiver.
 * - Payout externe : pays/devise source depuis le sender PayNoval, destination depuis le rail externe.
 * - Collection externe : pays/devise source depuis le rail externe, destination depuis le receiver PayNoval.
 *
 * Compatible avec le modèle User principal PayNoval :
 * - country
 * - currency
 * - registrationCountry
 * - userType
 * - isBusiness
 * - role
 * - accountStatus
 * - isBlocked
 * - hiddenFromTransfers
 * - isLoginDisabled
 * - isSystem
 * - systemType
 * - kycStatus
 * - kybStatus
 */

const COUNTRY_RULES = {
  "cote d'ivoire": {
    aliases: [
      "cote d'ivoire",
      "cote d’ivoire",
      "cote divoire",
      "côte d'ivoire",
      "côte d’ivoire",
      "ci",
      "ivory coast",
    ],
    currency: "XOF",
    callingCodes: ["225"],
    ibanPrefixes: [],
    mobileOperators: [
      "orange",
      "orange_money",
      "orange_money_ci",
      "mtn",
      "mtn_momo",
      "mtn_money",
      "moov",
      "moov_money",
      "flooz",
      "wave",
    ],
  },

  canada: {
    aliases: ["canada", "ca"],
    currency: "CAD",
    callingCodes: ["1"],
    ibanPrefixes: [],
    mobileOperators: [],
  },

  france: {
    aliases: ["france", "fr"],
    currency: "EUR",
    callingCodes: ["33"],
    ibanPrefixes: ["FR"],
    mobileOperators: [],
  },

  belgique: {
    aliases: ["belgique", "belgium", "be"],
    currency: "EUR",
    callingCodes: ["32"],
    ibanPrefixes: ["BE"],
    mobileOperators: [],
  },

  allemagne: {
    aliases: ["allemagne", "germany", "de"],
    currency: "EUR",
    callingCodes: ["49"],
    ibanPrefixes: ["DE"],
    mobileOperators: [],
  },

  usa: {
    aliases: [
      "usa",
      "us",
      "united states",
      "united states of america",
      "etats unis",
      "états unis",
      "etats-unis",
      "états-unis",
    ],
    currency: "USD",
    callingCodes: ["1"],
    ibanPrefixes: [],
    mobileOperators: [],
  },

  "burkina faso": {
    aliases: ["burkina faso", "burkina-faso", "bf"],
    currency: "XOF",
    callingCodes: ["226"],
    ibanPrefixes: [],
    mobileOperators: [],
  },

  mali: {
    aliases: ["mali", "ml"],
    currency: "XOF",
    callingCodes: ["223"],
    ibanPrefixes: [],
    mobileOperators: [],
  },

  senegal: {
    aliases: ["senegal", "sénégal", "sn"],
    currency: "XOF",
    callingCodes: ["221"],
    ibanPrefixes: [],
    mobileOperators: [],
  },

  cameroun: {
    aliases: ["cameroun", "cameroon", "cm"],
    currency: "XAF",
    callingCodes: ["237"],
    ibanPrefixes: [],
    mobileOperators: [],
  },
};

function normalizeCountry(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘`´]/g, "'")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ");
}

function normalizeCurrency(v) {
  const s = String(v || "").trim().toUpperCase();

  if (!s) return "";
  if (s === "€" || s.includes("EUR") || s.includes("EURO")) return "EUR";
  if (s.includes("CAD") || s === "$CAD") return "CAD";
  if (s.includes("USD") || s === "$USD") return "USD";
  if (s.includes("GBP") || s === "£" || s === "£GBP") return "GBP";
  if (s.includes("XOF") || s.includes("FCFA") || s.includes("F CFA") || s.includes("CFA")) return "XOF";
  if (s.includes("XAF")) return "XAF";

  const letters = s.replace(/[^A-Z]/g, "");
  if (letters.length === 3) return letters;

  return s;
}

function normalizeProvider(v) {
  const s = String(v || "").trim().toLowerCase();

  if (!s) return "";
  if (s === "mobile_money" || s === "mobilemoney" || s === "momo") return "mobilemoney";
  if (s === "visa" || s === "stripe" || s === "visa_direct" || s === "card") return "card";
  if (s === "bank" || s === "banque" || s === "bank_account") return "bank";
  if (s === "paynoval" || s === "internal") return "paynoval";

  return s;
}

function normalizeOperator(v) {
  const s = String(v || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (!s) return "";

  if (s === "orange") return "orange";
  if (s === "orange_money") return "orange_money";
  if (s === "orange_money_ci") return "orange_money_ci";

  if (s === "mtn") return "mtn";
  if (s === "mtn_momo") return "mtn_momo";
  if (s === "mtn_money") return "mtn_money";

  if (s === "moov") return "moov";
  if (s === "moov_money") return "moov_money";
  if (s === "flooz") return "flooz";

  if (s === "wave") return "wave";

  return s;
}

function getCountryKey(country) {
  const c = normalizeCountry(country);
  if (!c) return "";

  for (const [key, rule] of Object.entries(COUNTRY_RULES)) {
    const aliases = rule.aliases.map(normalizeCountry);
    if (aliases.includes(c)) return key;
  }

  return c;
}

function getCountryRule(country) {
  const key = getCountryKey(country);
  return COUNTRY_RULES[key] || null;
}

function getCurrencyByCountry(country) {
  return getCountryRule(country)?.currency || "";
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }

  return "";
}

function fail(status, code, message, details = {}) {
  const err = createError(status, message);
  err.code = code;
  err.details = details;
  throw err;
}

function isSystemAccount(user = {}) {
  return (
    user?.isSystem === true ||
    String(user?.userType || "").trim().toLowerCase() === "system" ||
    !!user?.systemType
  );
}

function isBusinessUser(user = {}) {
  const userType = String(user?.userType || "").trim().toLowerCase();
  const role = String(user?.role || "").trim().toLowerCase();

  return user?.isBusiness === true || userType === "entreprise" || role === "business";
}

function isUserBlocked(user = {}) {
  const status = String(user?.status || "").trim().toLowerCase();
  const accountStatus = String(user?.accountStatus || "").trim().toLowerCase();
  const kybStatus = String(user?.kybStatus || "").trim().toLowerCase();
  const staffStatus = String(user?.staffStatus || "").trim().toLowerCase();

  return (
    user?.isBlocked === true ||
    user?.hiddenFromTransfers === true ||
    user?.isLoginDisabled === true ||
    status === "blocked" ||
    status === "suspended" ||
    status === "disabled" ||
    status === "deleted" ||
    status === "banned" ||
    accountStatus === "blocked" ||
    accountStatus === "frozen" ||
    kybStatus === "suspended" ||
    staffStatus === "suspended" ||
    staffStatus === "disabled"
  );
}

function assertActiveUser(
  user = {},
  { codePrefix = "USER", roleLabel = "utilisateur" } = {}
) {
  if (!user) {
    fail(404, `${codePrefix}_NOT_FOUND`, `${roleLabel} introuvable.`);
  }

  if (user?.isDeleted || user?.deletedAt) {
    fail(
      403,
      `${codePrefix}_DELETED`,
      `Le compte ${roleLabel} n’est plus disponible.`
    );
  }

  if (isSystemAccount(user)) {
    fail(
      403,
      `${codePrefix}_SYSTEM_ACCOUNT_FORBIDDEN`,
      `Ce compte ${roleLabel} est un compte système et ne peut pas être utilisé pour ce transfert.`
    );
  }

  if (isUserBlocked(user)) {
    fail(
      403,
      `${codePrefix}_NOT_ACTIVE`,
      `Le compte ${roleLabel} n’est pas autorisé à effectuer ou recevoir ce transfert.`
    );
  }

  const accountStatus = String(user?.accountStatus || "").trim().toLowerCase();

  if (accountStatus && accountStatus !== "active") {
    fail(
      403,
      `${codePrefix}_ACCOUNT_NOT_ACTIVE`,
      `Le compte ${roleLabel} n’est pas actif.`,
      { accountStatus }
    );
  }
}

function extractUserCountry(user = {}) {
  const business = isBusinessUser(user);

  return pickFirst(
    business ? user?.registrationCountry : "",
    user?.country,
    user?.registrationCountry,
    user?.profile?.country,
    user?.address?.country,
    user?.residenceCountry,
    user?.selectedCountry,
    user?.countryCode
  );
}

function extractUserCurrency(user = {}) {
  const managed =
    user?.managedCurrency && user.managedCurrency !== "MULTI"
      ? user.managedCurrency
      : "";

  return normalizeCurrency(
    pickFirst(
      user?.currency,
      user?.currencyCode,
      user?.defaultCurrency,
      user?.wallet?.currency,
      user?.wallet?.defaultCurrency,
      managed
    )
  );
}

function assertSupportedCountry(country, { code = "COUNTRY_NOT_SUPPORTED" } = {}) {
  const key = getCountryKey(country);
  const rule = getCountryRule(key);

  if (!key || !rule) {
    fail(
      422,
      code,
      "Ce pays n’est pas encore supporté par PayNoval pour ce corridor.",
      { country, normalizedCountry: key }
    );
  }

  return key;
}

function assertSameCountry({
  selectedCountry,
  detectedCountry,
  code = "COUNTRY_MISMATCH",
  message = "Le pays sélectionné ne correspond pas au pays réel.",
}) {
  const selected = getCountryKey(selectedCountry);
  const detected = getCountryKey(detectedCountry);

  if (!selected || !detected) return;

  if (selected !== detected) {
    fail(422, code, message, {
      selectedCountry,
      detectedCountry,
      selectedCountryKey: selected,
      detectedCountryKey: detected,
    });
  }
}

function assertCurrencyForCountry({
  country,
  currency,
  code = "CURRENCY_COUNTRY_MISMATCH",
}) {
  const countryKey = assertSupportedCountry(country, { code: "COUNTRY_NOT_SUPPORTED" });
  const expectedCurrency = getCurrencyByCountry(countryKey);
  const actualCurrency = normalizeCurrency(currency);

  if (expectedCurrency && !actualCurrency) return expectedCurrency;

  if (actualCurrency !== expectedCurrency) {
    fail(
      422,
      code,
      `La devise ${actualCurrency || "inconnue"} ne correspond pas au pays sélectionné. Devise attendue : ${expectedCurrency}.`,
      {
        country,
        countryKey,
        actualCurrency,
        expectedCurrency,
      }
    );
  }

  return expectedCurrency;
}

function buildCorridorSnapshot({
  flow,
  rail,
  lockedBy,
  sourceCountry,
  targetCountry,
  sourceCurrency,
  targetCurrency,
  extra = {},
}) {
  return {
    version: 1,
    flow,
    rail,
    lockedBy,
    sourceCountry: getCountryKey(sourceCountry) || sourceCountry || "",
    targetCountry: getCountryKey(targetCountry) || targetCountry || "",
    sourceCurrency: normalizeCurrency(sourceCurrency),
    targetCurrency: normalizeCurrency(targetCurrency),
    lockedAt: new Date().toISOString(),
    ...extra,
  };
}

function validatePaynovalUserProfile({
  user,
  requestedCountry,
  requestedCurrency,
  roleLabel = "utilisateur",
  codePrefix = "USER",
}) {
  assertActiveUser(user, { codePrefix, roleLabel });

  const profileCountry = extractUserCountry(user);
  const profileCurrency =
    extractUserCurrency(user) || getCurrencyByCountry(profileCountry);

  if (!profileCountry) {
    fail(
      422,
      `${codePrefix}_COUNTRY_MISSING`,
      `Le pays du compte ${roleLabel} est introuvable.`,
      {
        userId: String(user?._id || user?.id || ""),
        email: user?.email || null,
      }
    );
  }

  const profileCountryKey = assertSupportedCountry(profileCountry, {
    code: `${codePrefix}_COUNTRY_NOT_SUPPORTED`,
  });

  if (!profileCurrency) {
    fail(
      422,
      `${codePrefix}_CURRENCY_MISSING`,
      `La devise du compte ${roleLabel} est introuvable.`,
      {
        profileCountry,
        userId: String(user?._id || user?.id || ""),
        email: user?.email || null,
      }
    );
  }

  if (requestedCountry) {
    assertSameCountry({
      selectedCountry: requestedCountry,
      detectedCountry: profileCountryKey,
      code: `${codePrefix}_COUNTRY_MISMATCH`,
      message: `Le pays sélectionné ne correspond pas au pays réel du compte ${roleLabel}.`,
    });
  }

  const normalizedRequestedCurrency = normalizeCurrency(requestedCurrency);

  if (
    normalizedRequestedCurrency &&
    normalizedRequestedCurrency !== profileCurrency
  ) {
    fail(
      422,
      `${codePrefix}_CURRENCY_MISMATCH`,
      `Le compte ${roleLabel} utilise uniquement la devise ${profileCurrency}.`,
      {
        requestedCurrency: normalizedRequestedCurrency,
        profileCurrency,
        profileCountry: profileCountryKey,
      }
    );
  }

  const localCurrency = assertCurrencyForCountry({
    country: profileCountryKey,
    currency: profileCurrency,
    code: `${codePrefix}_LOCAL_CURRENCY_INVALID`,
  });

  return {
    country: profileCountryKey,
    currency: localCurrency || profileCurrency,
  };
}

function detectCountryFromPhone(phone, selectedCountry = "") {
  const digits = String(phone || "").replace(/[^\d]/g, "");
  const selected = getCountryKey(selectedCountry);

  if (!digits) return "";

  if (digits.startsWith("00225") || digits.startsWith("225")) return "cote d'ivoire";
  if (digits.startsWith("00226") || digits.startsWith("226")) return "burkina faso";
  if (digits.startsWith("00223") || digits.startsWith("223")) return "mali";
  if (digits.startsWith("00221") || digits.startsWith("221")) return "senegal";
  if (digits.startsWith("00237") || digits.startsWith("237")) return "cameroun";

  if (digits.startsWith("0033") || digits.startsWith("33")) return "france";
  if (digits.startsWith("0032") || digits.startsWith("32")) return "belgique";
  if (digits.startsWith("0049") || digits.startsWith("49")) return "allemagne";

  if (digits.startsWith("1")) return "north_america";

  if (selected === "cote d'ivoire" && digits.length === 10) return "cote d'ivoire";
  if (selected === "france" && digits.length === 10 && digits.startsWith("0")) return "france";
  if ((selected === "canada" || selected === "usa") && digits.length === 10) return "north_america";

  return "";
}

function phoneCountryMatchesSelectedCountry(selectedCountry, detectedPhoneCountry) {
  const selected = getCountryKey(selectedCountry);
  const detected = getCountryKey(detectedPhoneCountry);

  if (!selected || !detectedPhoneCountry) return false;

  if (detectedPhoneCountry === "north_america") {
    return selected === "canada" || selected === "usa";
  }

  return selected === detected;
}

function detectCountryFromIban(iban) {
  const clean = String(iban || "")
    .replace(/\s/g, "")
    .trim()
    .toUpperCase();

  if (!/^[A-Z]{2}/.test(clean)) return "";

  const prefix = clean.slice(0, 2);

  for (const [key, rule] of Object.entries(COUNTRY_RULES)) {
    if (rule.ibanPrefixes.includes(prefix)) return key;
  }

  return "";
}

function assertMobileOperatorAllowed({ country, operator }) {
  const countryKey = assertSupportedCountry(country, {
    code: "COUNTRY_NOT_SUPPORTED",
  });

  const rule = getCountryRule(countryKey);
  const op = normalizeOperator(operator);

  if (!rule.mobileOperators.length) {
    fail(
      422,
      "MOBILE_MONEY_NOT_AVAILABLE_FOR_COUNTRY",
      "Mobile Money n’est pas disponible pour ce pays.",
      { country: countryKey, operator }
    );
  }

  if (!op) {
    fail(
      400,
      "MOBILE_MONEY_OPERATOR_REQUIRED",
      "Opérateur Mobile Money requis.",
      { country: countryKey }
    );
  }

  if (!rule.mobileOperators.includes(op)) {
    fail(
      422,
      "OPERATOR_NOT_ALLOWED_FOR_COUNTRY",
      "Cet opérateur Mobile Money n’est pas disponible pour le pays sélectionné.",
      {
        country: countryKey,
        operator,
        normalizedOperator: op,
        allowedOperators: rule.mobileOperators,
      }
    );
  }
}

function pickPhone(body = {}, direction = "target") {
  if (direction === "source") {
    return pickFirst(
      body.fromPhone,
      body.phoneNumber,
      body.senderPhone,
      body.recipientPhone,
      body.recipientInfo?.phone,
      body.recipientInfo?.numero,
      body.beneficiary?.phoneNumber,
      body.beneficiary?.phone
    );
  }

  return pickFirst(
    body.toPhone,
    body.phoneNumber,
    body.recipientPhone,
    body.recipient,
    body.recipientInfo?.phone,
    body.recipientInfo?.numero,
    body.beneficiary?.phoneNumber,
    body.beneficiary?.phone
  );
}

function pickOperator(body = {}) {
  return pickFirst(
    body.operator,
    body.operatorName,
    body.recipientInfo?.operator,
    body.beneficiary?.operator,
    body.metadata?.provider,
    body.meta?.provider
  );
}

function validateMobileMoneyRail({
  body = {},
  selectedCountry,
  currency,
  direction = "target",
  flow,
}) {
  const phone = pickPhone(body, direction);
  const operator = pickOperator(body);

  if (!phone) {
    fail(
      400,
      direction === "source"
        ? "SOURCE_MOBILE_MONEY_PHONE_REQUIRED"
        : "MOBILE_MONEY_PHONE_REQUIRED",
      direction === "source"
        ? "Numéro Mobile Money source requis."
        : "Numéro Mobile Money destinataire requis."
    );
  }

  const detectedPhoneCountry = detectCountryFromPhone(phone, selectedCountry);

  let effectiveCountry = selectedCountry;

  if (!effectiveCountry && detectedPhoneCountry && detectedPhoneCountry !== "north_america") {
    effectiveCountry = detectedPhoneCountry;
  }

  if (!effectiveCountry) {
    fail(
      422,
      direction === "source"
        ? "SOURCE_COUNTRY_REQUIRED"
        : "DESTINATION_COUNTRY_REQUIRED",
      direction === "source"
        ? "Pays source requis pour vérifier le numéro Mobile Money."
        : "Pays destinataire requis pour vérifier le numéro Mobile Money."
    );
  }

  const effectiveCountryKey = assertSupportedCountry(effectiveCountry, {
    code: direction === "source"
      ? "SOURCE_COUNTRY_NOT_SUPPORTED"
      : "DESTINATION_COUNTRY_NOT_SUPPORTED",
  });

  if (!phoneCountryMatchesSelectedCountry(effectiveCountryKey, detectedPhoneCountry)) {
    fail(
      422,
      direction === "source"
        ? "SOURCE_PHONE_COUNTRY_MISMATCH"
        : "PHONE_COUNTRY_MISMATCH",
      direction === "source"
        ? "Le numéro Mobile Money source ne correspond pas au pays source sélectionné."
        : "Le numéro Mobile Money destinataire ne correspond pas au pays sélectionné.",
      {
        selectedCountry: effectiveCountryKey,
        detectedPhoneCountry,
      }
    );
  }

  assertMobileOperatorAllowed({
    country: effectiveCountryKey,
    operator,
  });

  const lockedCurrency = assertCurrencyForCountry({
    country: effectiveCountryKey,
    currency,
    code:
      direction === "source"
        ? "SOURCE_MOBILE_MONEY_CURRENCY_MISMATCH"
        : "MOBILE_MONEY_CURRENCY_MISMATCH",
  });

  return {
    country: effectiveCountryKey,
    currency: lockedCurrency || normalizeCurrency(currency),
    snapshot: buildCorridorSnapshot({
      flow,
      rail: direction === "source" ? "mobilemoney_source" : "mobilemoney",
      lockedBy: "phone_prefix_operator",
      sourceCountry:
        direction === "source"
          ? effectiveCountryKey
          : body.fromCountry || body.sourceCountry || body.country,
      targetCountry:
        direction === "source"
          ? body.toCountry || body.targetCountry || body.destinationCountry || body.country
          : effectiveCountryKey,
      sourceCurrency:
        direction === "source"
          ? lockedCurrency || currency
          : body.currencySource || body.senderCurrencyCode,
      targetCurrency:
        direction === "source"
          ? body.currencyTarget || body.localCurrencyCode
          : lockedCurrency || currency,
      extra: {
        phoneCountry: detectedPhoneCountry,
        operator,
        direction,
      },
    }),
  };
}

function validateBankRail({
  body = {},
  selectedCountry,
  currency,
  direction = "target",
  flow,
}) {
  const iban = pickFirst(
    body.iban,
    body.recipientInfo?.iban,
    body.beneficiary?.iban
  );

  const bankCountry = pickFirst(
    direction === "source" ? body.sourceBankCountry : body.bankCountry,
    body.bankCountry,
    body.recipientInfo?.bankCountry,
    body.beneficiary?.bankCountry,
    body.country
  );

  const detectedCountry = detectCountryFromIban(iban) || bankCountry;

  if (!detectedCountry) {
    fail(
      422,
      direction === "source"
        ? "SOURCE_BANK_COUNTRY_UNVERIFIED"
        : "BANK_COUNTRY_UNVERIFIED",
      direction === "source"
        ? "Impossible de vérifier le pays du compte bancaire source."
        : "Impossible de vérifier le pays du compte bancaire destinataire.",
      {
        hasIban: !!iban,
        bankCountry: bankCountry || null,
      }
    );
  }

  const detectedCountryKey = assertSupportedCountry(detectedCountry, {
    code: direction === "source"
      ? "SOURCE_BANK_COUNTRY_NOT_SUPPORTED"
      : "BANK_COUNTRY_NOT_SUPPORTED",
  });

  const effectiveCountry = selectedCountry || detectedCountryKey;

  assertSameCountry({
    selectedCountry: effectiveCountry,
    detectedCountry: detectedCountryKey,
    code:
      direction === "source"
        ? "SOURCE_BANK_COUNTRY_MISMATCH"
        : "BANK_COUNTRY_MISMATCH",
    message:
      direction === "source"
        ? "Le compte bancaire source ne correspond pas au pays source sélectionné."
        : "Le compte bancaire destinataire ne correspond pas au pays sélectionné.",
  });

  const lockedCurrency = assertCurrencyForCountry({
    country: detectedCountryKey,
    currency,
    code:
      direction === "source"
        ? "SOURCE_BANK_CURRENCY_MISMATCH"
        : "BANK_CURRENCY_MISMATCH",
  });

  return {
    country: detectedCountryKey,
    currency: lockedCurrency || normalizeCurrency(currency),
    snapshot: buildCorridorSnapshot({
      flow,
      rail: direction === "source" ? "bank_source" : "bank",
      lockedBy: iban ? "iban_country" : "bank_country",
      sourceCountry:
        direction === "source"
          ? detectedCountryKey
          : body.fromCountry || body.sourceCountry || body.country,
      targetCountry:
        direction === "source"
          ? body.toCountry || body.targetCountry || body.destinationCountry || body.country
          : detectedCountryKey,
      sourceCurrency:
        direction === "source"
          ? lockedCurrency || currency
          : body.currencySource || body.senderCurrencyCode,
      targetCurrency:
        direction === "source"
          ? body.currencyTarget || body.localCurrencyCode
          : lockedCurrency || currency,
      extra: {
        bankCountry: detectedCountryKey,
        hasIban: !!iban,
        direction,
      },
    }),
  };
}

function validateCardRail({
  body = {},
  selectedCountry,
  currency,
  direction = "target",
  flow,
}) {
  const cardCountry = pickFirst(
    direction === "source" ? body.sourceCardCountry : body.cardCountry,
    body.cardCountry,
    body.binCountry,
    body.recipientInfo?.cardCountry,
    body.beneficiary?.cardCountry,
    body.metadata?.cardCountry,
    body.meta?.cardCountry
  );

  if (!cardCountry) {
    fail(
      422,
      direction === "source"
        ? "SOURCE_CARD_COUNTRY_UNVERIFIED"
        : "CARD_COUNTRY_UNVERIFIED",
      direction === "source"
        ? "Impossible de vérifier le pays de la carte source."
        : "Impossible de vérifier le pays de la carte destinataire.",
      { selectedCountry }
    );
  }

  const cardCountryKey = assertSupportedCountry(cardCountry, {
    code: direction === "source"
      ? "SOURCE_CARD_COUNTRY_NOT_SUPPORTED"
      : "CARD_COUNTRY_NOT_SUPPORTED",
  });

  const effectiveCountry = selectedCountry || cardCountryKey;

  assertSameCountry({
    selectedCountry: effectiveCountry,
    detectedCountry: cardCountryKey,
    code:
      direction === "source"
        ? "SOURCE_CARD_COUNTRY_MISMATCH"
        : "CARD_COUNTRY_MISMATCH",
    message:
      direction === "source"
        ? "La carte source ne correspond pas au pays source sélectionné."
        : "La carte destinataire ne correspond pas au pays sélectionné.",
  });

  const lockedCurrency = assertCurrencyForCountry({
    country: cardCountryKey,
    currency,
    code:
      direction === "source"
        ? "SOURCE_CARD_CURRENCY_MISMATCH"
        : "CARD_CURRENCY_MISMATCH",
  });

  return {
    country: cardCountryKey,
    currency: lockedCurrency || normalizeCurrency(currency),
    snapshot: buildCorridorSnapshot({
      flow,
      rail: direction === "source" ? "card_source" : "card",
      lockedBy: "card_country",
      sourceCountry:
        direction === "source"
          ? cardCountryKey
          : body.fromCountry || body.sourceCountry || body.country,
      targetCountry:
        direction === "source"
          ? body.toCountry || body.targetCountry || body.destinationCountry || body.country
          : cardCountryKey,
      sourceCurrency:
        direction === "source"
          ? lockedCurrency || currency
          : body.currencySource || body.senderCurrencyCode,
      targetCurrency:
        direction === "source"
          ? body.currencyTarget || body.localCurrencyCode
          : lockedCurrency || currency,
      extra: {
        cardCountry: cardCountryKey,
        direction,
      },
    }),
  };
}

function validateInternalPaynovalCorridor({
  body = {},
  sender = null,
  receiver = null,
  sourceCountry,
  targetCountry,
  currencySource,
  currencyTarget,
}) {
  const senderLock = validatePaynovalUserProfile({
    user: sender,
    requestedCountry: sourceCountry,
    requestedCurrency: currencySource,
    roleLabel: "expéditeur",
    codePrefix: "SENDER",
  });

  const receiverLock = validatePaynovalUserProfile({
    user: receiver,
    requestedCountry: targetCountry,
    requestedCurrency: currencyTarget,
    roleLabel: "destinataire",
    codePrefix: "RECIPIENT",
  });

  const snapshot = buildCorridorSnapshot({
    flow: "PAYNOVAL_INTERNAL_TRANSFER",
    rail: "paynoval_internal",
    lockedBy: "sender_and_recipient_profiles",
    sourceCountry: senderLock.country,
    targetCountry: receiverLock.country,
    sourceCurrency: senderLock.currency,
    targetCurrency: receiverLock.currency,
    extra: {
      senderUserId: String(sender?._id || sender?.id || ""),
      receiverUserId: String(receiver?._id || receiver?.id || ""),
      senderEmail: sender?.email || "",
      receiverEmail: receiver?.email || "",
    },
  });

  return {
    ok: true,
    sourceCountry: senderLock.country,
    targetCountry: receiverLock.country,
    currencySource: senderLock.currency,
    currencyTarget: receiverLock.currency,
    senderCountry: senderLock.country,
    senderCurrency: senderLock.currency,
    recipientCountry: receiverLock.country,
    recipientCurrency: receiverLock.currency,
    snapshot,
  };
}

function validateOutboundExternalCorridor({
  flow,
  body = {},
  senderUser = null,
  fromCountry,
  toCountry,
  currencySource,
  currencyTarget,
}) {
  const senderLock = validatePaynovalUserProfile({
    user: senderUser,
    requestedCountry: fromCountry,
    requestedCurrency: currencySource,
    roleLabel: "expéditeur",
    codePrefix: "SENDER",
  });

  const destination = normalizeProvider(body.destination || body.destinationUi);
  let target;

  if (flow === "PAYNOVAL_TO_MOBILEMONEY_PAYOUT" || destination === "mobilemoney") {
    target = validateMobileMoneyRail({
      body,
      selectedCountry: toCountry,
      currency: currencyTarget,
      direction: "target",
      flow,
    });
  } else if (flow === "PAYNOVAL_TO_BANK_PAYOUT" || destination === "bank") {
    target = validateBankRail({
      body,
      selectedCountry: toCountry,
      currency: currencyTarget,
      direction: "target",
      flow,
    });
  } else if (flow === "PAYNOVAL_TO_CARD_PAYOUT" || destination === "card") {
    target = validateCardRail({
      body,
      selectedCountry: toCountry,
      currency: currencyTarget,
      direction: "target",
      flow,
    });
  } else {
    fail(
      400,
      "UNSUPPORTED_OUTBOUND_CORRIDOR",
      "Corridor externe sortant non supporté.",
      { flow, destination }
    );
  }

  const snapshot = buildCorridorSnapshot({
    flow,
    rail: target.snapshot?.rail || "external_payout",
    lockedBy: "sender_profile_and_destination_rail",
    sourceCountry: senderLock.country,
    targetCountry: target.country,
    sourceCurrency: senderLock.currency,
    targetCurrency: target.currency,
    extra: {
      senderUserId: String(senderUser?._id || senderUser?.id || ""),
      senderEmail: senderUser?.email || "",
      destinationRailSnapshot: target.snapshot,
    },
  });

  return {
    ok: true,
    lockedSourceCountry: senderLock.country,
    lockedTargetCountry: target.country,
    lockedSourceCurrency: senderLock.currency,
    lockedTargetCurrency: target.currency,
    snapshot,
  };
}

function validateInboundExternalCorridor({
  flow,
  body = {},
  receiverUser = null,
  fromCountry,
  toCountry,
  currencySource,
  currencyTarget,
}) {
  const receiverLock = validatePaynovalUserProfile({
    user: receiverUser,
    requestedCountry: toCountry,
    requestedCurrency: currencyTarget,
    roleLabel: "récepteur PayNoval",
    codePrefix: "RECEIVER",
  });

  let source;

  if (flow === "MOBILEMONEY_COLLECTION_TO_PAYNOVAL") {
    source = validateMobileMoneyRail({
      body,
      selectedCountry: fromCountry,
      currency: currencySource,
      direction: "source",
      flow,
    });
  } else if (flow === "BANK_TRANSFER_TO_PAYNOVAL") {
    source = validateBankRail({
      body,
      selectedCountry: fromCountry,
      currency: currencySource,
      direction: "source",
      flow,
    });
  } else if (flow === "CARD_TOPUP_TO_PAYNOVAL") {
    source = validateCardRail({
      body,
      selectedCountry: fromCountry,
      currency: currencySource,
      direction: "source",
      flow,
    });
  } else {
    fail(
      400,
      "UNSUPPORTED_INBOUND_CORRIDOR",
      "Corridor externe entrant non supporté.",
      { flow }
    );
  }

  const snapshot = buildCorridorSnapshot({
    flow,
    rail: "external_to_paynoval",
    lockedBy: "source_rail_and_receiver_profile",
    sourceCountry: source.country,
    targetCountry: receiverLock.country,
    sourceCurrency: source.currency,
    targetCurrency: receiverLock.currency,
    extra: {
      receiverUserId: String(receiverUser?._id || receiverUser?.id || ""),
      receiverEmail: receiverUser?.email || "",
      sourceRailSnapshot: source.snapshot,
    },
  });

  return {
    ok: true,
    lockedSourceCountry: source.country,
    lockedTargetCountry: receiverLock.country,
    lockedSourceCurrency: source.currency,
    lockedTargetCurrency: receiverLock.currency,
    snapshot,
  };
}

module.exports = {
  normalizeCountry,
  normalizeCurrency,
  normalizeProvider,
  normalizeOperator,
  getCountryKey,
  getCurrencyByCountry,
  validatePaynovalUserProfile,
  validateInternalPaynovalCorridor,
  validateOutboundExternalCorridor,
  validateInboundExternalCorridor,
};