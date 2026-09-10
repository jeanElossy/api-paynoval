"use strict";

/**
 * ============================================================================
 * CONFIANCE D'UN NUMÉRO DE DÉPÔT — LA DÉCISION, CÔTÉ MOTEUR
 * ============================================================================
 *
 * ── La règle ────────────────────────────────────────────────────────────────
 *
 * Un encaissement mobile money vers PayNoval part d'un numéro. Ce numéro doit
 * être soit CELUI DE L'UTILISATEUR, soit un numéro qu'il a prouvé contrôler par
 * SMS. Sinon l'opération est refusée, avec un chemin explicite pour la
 * débloquer.
 *
 * ── Ce qui a changé en descendant du bord ───────────────────────────────────
 *
 * La version du bord (`transactions/phoneSecurity.js`) faisait un APPEL HTTP
 * pour connaître l'état de vérification — vers une route qui, elle, lisait la
 * base du bord. Un aller-retour réseau au milieu du chemin de l'argent pour
 * consulter une collection qu'on possédait déjà.
 *
 * Pire : cet appel visait `/api/v1/phone-verification/status`, que le bord ne
 * montait NULLE PART. Il rendait donc 404 à chaque fois, le `catch` le
 * traduisait en « non vérifié », et le dépôt vers un numéro tiers était refusé
 * quoi qu'il arrive — sans qu'aucun journal ne distingue « numéro non vérifié »
 * de « route inexistante ».
 *
 * Ici, la lecture est locale : la collection appartient à ce service.
 *
 * ── Échec en FERMETURE, mais avec le BON motif ─────────────────────────────
 *
 * Trois refus différents, trois codes différents :
 *
 *   · `PHONE_INVALID`         — le numéro est illisible ;
 *   · `PHONE_NOT_TRUSTED`     — lisible, non prouvé : l'utilisateur peut agir ;
 *   · `TRUST_STORE_UNAVAILABLE` — la base ne répond pas : ce n'est PAS la faute
 *     de l'utilisateur, et lui dire « vérifie ton numéro » l'enverrait tourner
 *     en rond sur un OTP qui ne changerait rien.
 *
 * Le bord confondait les deux derniers : son `catch` rendait `trusted = false`.
 * Un incident d'infrastructure prenait l'apparence d'une décision de sécurité.
 */

const { getTxConn } = require("../../config/db");
const logger = require("../../utils/logger");
const {
  toE164,
  last4,
  pickUserPrimaryPhoneE164,
} = require("../../utils/phone");

let _Trusted = null;

/**
 * ⚠️ RÉSOLUTION PARESSEUSE. La connexion transactions n'existe pas au
 * chargement du module — seulement après `connectTransactionsDB()`. Résoudre le
 * modèle au `require` produirait un modèle attaché à la connexion globale, qui
 * lirait une AUTRE base : le registre paraîtrait vide et tout numéro serait
 * refusé.
 */
function modele() {
  if (!_Trusted) {
    _Trusted = require("../../models/TrustedDepositNumber")(getTxConn());
  }
  return _Trusted;
}

function refus(message, code, statut, extra = {}) {
  return Object.assign(new Error(message), { code, statut, ...extra });
}

/**
 * L'opération est-elle un encaissement mobile money vers PayNoval ?
 * Seul ce flux est concerné : un transfert interne ne désigne aucun numéro
 * externe, et un retrait envoie l'argent VERS un numéro sans en débiter le
 * titulaire.
 */

/**
 * ⚠️ LE CONTRÔLE NE DOIT PAS POUVOIR ÊTRE CONTOURNÉ PAR UNE ORTHOGRAPHE.
 *
 * Le rail « mobile money » s'écrit de six façons dans le dépôt : `mobilemoney`,
 * `mobile_money`, `mobile-money`, `momo`, et les quatre noms d'opérateurs
 * (`wave`, `orange`, `mtn`, `moov`) qui en sont des PRESTATAIRES. L'application
 * mobile envoie `mobile_money` avec un tiret bas (`montant.js:303`).
 *
 * Une comparaison stricte à `"mobilemoney"` ferait que `concerneCeControle`
 * rendrait `false` sur un vrai encaissement mobile money : le contrôle ne
 * s'appliquerait pas, et l'encaissement passerait SANS vérification du numéro.
 *
 * C'est la pire forme d'échec possible — le contrôle ne se plaint pas, il ne
 * s'exécute simplement jamais. On normalise donc ICI, au plus près de la
 * décision, plutôt que de faire confiance à ce qu'un appelant a normalisé en
 * amont.
 */
const ALIAS_MOBILEMONEY = Object.freeze([
  "mobilemoney",
  "mobile_money",
  "mobile-money",
  "momo",
  "wave",
  "orange",
  "mtn",
  "moov",
]);

const ALIAS_PAYNOVAL = Object.freeze(["paynoval", "wallet", "balance"]);

function railNormalise(v) {
  const s = String(v || "").toLowerCase().trim();
  if (ALIAS_MOBILEMONEY.includes(s)) return "mobilemoney";
  if (ALIAS_PAYNOVAL.includes(s)) return "paynoval";
  return s;
}

function concerneCeControle({ action, funds, destination }) {
  const a = String(action || "send").toLowerCase().trim();

  return (
    a === "deposit" &&
    railNormalise(funds) === "mobilemoney" &&
    railNormalise(destination) === "paynoval"
  );
}

/** Lit l'état de confiance. Lève en cas d'indisponibilité — jamais `false`. */
async function lireEtat({ userId, phoneE164 }) {
  try {
    const doc = await modele()
      .findOne({ userId: String(userId), phoneE164 })
      .lean();

    if (!doc) return { existe: false, status: "none", trusted: false };

    const status = String(doc.status || "pending").toLowerCase();

    return {
      existe: true,
      status,
      trusted: status === "trusted",
      verifiedAt: doc.verifiedAt || null,
      blockedUntil: doc.blockedUntil || null,
    };
  } catch (err) {
    logger.error("[deposit-trust] registre illisible", {
      phone: last4(phoneE164),
      message: err?.message,
    });

    throw refus(
      "Vérification du numéro momentanément indisponible.",
      "TRUST_STORE_UNAVAILABLE",
      503
    );
  }
}

/**
 * Applique le contrôle. Rend le numéro NORMALISÉ que l'appelant doit utiliser —
 * pas un booléen.
 *
 * ⚠️ RENDRE LE NUMÉRO EST DÉLIBÉRÉ. Le bord réécrivait `req.body.phoneNumber`
 * en E.164 après contrôle. Si l'appelant conservait la forme brute, on
 * vérifiait `+2250700000000` et on encaissait sur `0700000000` : le contrôle
 * portait sur un numéro, l'opération sur un autre.
 */
async function enforceDepositPhoneTrust({ userId, user, body }) {
  if (!userId) {
    throw refus("Non autorisé (utilisateur manquant).", "UNAUTHENTICATED", 401);
  }

  const charge = body || {};

  if (!concerneCeControle(charge)) {
    return { applique: false, phoneE164: "" };
  }

  const pays = charge.country || user?.country || user?.selectedCountry || "";
  const brut = charge.phoneNumber || charge.toPhone || charge.phone || "";

  const phoneE164 = toE164(brut, pays).e164;

  if (!phoneE164) {
    throw refus(
      "Numéro de dépôt invalide. Format attendu : international (ex. +2250700000000) " +
        "ou numéro local accompagné du pays.",
      "PHONE_INVALID",
      400
    );
  }

  /**
   * Son propre numéro est de confiance sans OTP : l'utilisateur a déjà prouvé
   * qu'il le contrôle à l'inscription (`users.phoneVerified`, côté principal).
   * Redemander un code ici ferait payer un SMS pour reprouver un fait acquis.
   */
  const sien = pickUserPrimaryPhoneE164(user, pays);
  if (sien && sien === phoneE164) {
    return { applique: true, phoneE164, motif: "numero-du-titulaire" };
  }

  const etat = await lireEtat({ userId, phoneE164 });

  if (etat.trusted) {
    return { applique: true, phoneE164, motif: "numero-verifie" };
  }

  const enAttente = etat.status === "pending";
  const bloque = etat.status === "blocked";

  throw refus(
    bloque
      ? "Vérification de ce numéro temporairement bloquée. Réessaie plus tard."
      : enAttente
      ? "Vérification déjà en cours pour ce numéro. Saisis le code reçu par SMS."
      : "Ce numéro n'est pas vérifié. Vérifie-le par SMS avant de déposer.",
    bloque ? "PHONE_VERIFICATION_BLOCKED" : enAttente
      ? "PHONE_VERIFICATION_PENDING"
      : "PHONE_NOT_TRUSTED",
    403,
    {
      /**
       * Le chemin de sortie fait partie du refus. Un 403 sans issue enferme
       * l'utilisateur — c'est exactement ce que faisait le bord, dont le
       * `nextStep` citait trois routes qui n'existaient pas.
       */
      payload: {
        otpStatus: { status: etat.status, skipStart: enAttente },
        nextStep: {
          status: "/api/v1/phone-verification/status",
          start: "/api/v1/phone-verification/start",
          verify: "/api/v1/phone-verification/verify",
          phoneNumber: phoneE164,
          country: pays,
          skipStart: enAttente,
        },
      },
    }
  );
}

module.exports = {
  ALIAS_MOBILEMONEY,
  railNormalise,
  concerneCeControle,
  lireEtat,
  enforceDepositPhoneTrust,
};
