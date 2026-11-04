"use strict";

/**
 * ============================================================================
 * RETRAIT MOBILE MONEY : VERS LE NUMÉRO DU COMPTE, ET LUI SEUL (2026-11-04)
 * ============================================================================
 *
 * Décision de l'utilisateur : un DÉPÔT peut venir du numéro du titulaire ou
 * d'un autre numéro ; un RETRAIT ne part que vers le numéro du compte — celui
 * de l'inscription.
 *
 * ⚠️ Défaut fermé ce jour-là : rien ne l'empêchait côté serveur. Un retrait
 * n'a ni question de sécurité ni lien SMS (il va « vers soi ») : une session
 * volée pouvait vider le solde vers le numéro du voleur en l'appelant
 * « retrait ». L'application ne décide pas : seul ce contrôle fait foi.
 *
 * Échec en FERMETURE : numéro du compte inconnu ou illisible, numéro de
 * retrait illisible ⇒ refus, jamais un retrait « au mieux ».
 *
 * Seul le numéro PRINCIPAL du compte compte : jamais les numéros mobile money
 * enregistrés (`user.mobiles`), qu'on ajoute en quelques gestes.
 *
 * Module PUR. Testé dans `test/withdrawOwnership.test.js`.
 */

const { toE164 } = require("../../utils/phone");
const { getCountryKey } = require("./handlers/corridorValidation");

/** Clé pays du corridor → ISO, pour lire un numéro local. */
const ISO_BY_COUNTRY_KEY = Object.freeze({
  "cote d'ivoire": "CI",
  mali: "ML",
  "burkina faso": "BF",
  senegal: "SN",
  cameroun: "CM",
  cameroon: "CM",
  benin: "BJ",
  togo: "TG",
});

function isoOf(country) {
  const raw = String(country || "").trim();
  if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();
  return ISO_BY_COUNTRY_KEY[getCountryKey(raw)] || "";
}

/** Numéro d'INSCRIPTION du compte, en E.164, ou "". */
function registeredPhoneE164(user = {}) {
  const raw = user.phoneE164 || user.phoneNumber || user.phone || "";
  return toE164(raw, isoOf(user.country)).e164;
}

function refuse(status, code, message) {
  return Object.assign(new Error(message), { status, statusCode: status, code });
}

/**
 * Lève si un RETRAIT mobile money ne va pas vers le numéro du compte. Ne fait
 * rien pour un transfert vers un tiers, un dépôt, ou un retrait carte (la
 * carte d'un retrait est une carte ENREGISTRÉE du compte, référencée par
 * son identifiant).
 */
function assertWithdrawalToOwnPhone({ operationType, isMobileMoneyPayout, recipientPhone, payoutCountry, user }) {
  if (String(operationType || "").toUpperCase() !== "WITHDRAW") return;
  if (!isMobileMoneyPayout) return;

  const own = registeredPhoneE164(user);
  if (!own) {
    throw refuse(
      403,
      "WITHDRAW_OWN_PHONE_UNKNOWN",
      "Le numéro de votre compte est introuvable : un retrait n'est possible que vers lui."
    );
  }

  const target = toE164(recipientPhone, isoOf(payoutCountry) || isoOf(user.country)).e164;
  if (!target) {
    throw refuse(400, "WITHDRAW_PHONE_INVALID", "Numéro de retrait illisible.");
  }

  if (target !== own) {
    throw refuse(
      403,
      "WITHDRAW_PHONE_NOT_OWNER",
      "Un retrait ne peut aller que vers le numéro de votre compte. Pour envoyer à un autre numéro, faites un transfert."
    );
  }
}

module.exports = { assertWithdrawalToOwnPhone, registeredPhoneE164, isoOf };
