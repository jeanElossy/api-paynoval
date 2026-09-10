"use strict";

/**
 * ============================================================================
 * CLIENT OTP TÉLÉPHONE — TX CORE DÉCIDE, LE PRINCIPAL ENVOIE
 * ============================================================================
 *
 * ── Le partage ──────────────────────────────────────────────────────────────
 *
 *   · le backend principal possède Email/Push/SMS : il détient le lien Twilio ;
 *   · TX Core possède la DÉCISION et l'ÉTAT (`trusted_deposit_numbers`) : quota
 *     d'envois, délai de renvoi, blocage, horodatage de la preuve.
 *
 * Ce module est le seul point de passage entre les deux. Il n'écrit rien et ne
 * décide rien — il transporte.
 *
 * ── Pourquoi pas Twilio en direct depuis ici ────────────────────────────────
 *
 * Le bord le faisait (`api-gateway/src/services/twilioVerify.js`, 67 l.), avec
 * un SECOND jeu d'identifiants Twilio. Deux services envoyant des SMS, ce sont
 * deux quotas, deux factures, deux comportements en cas d'erreur — et le jour
 * où l'on change de fournisseur, deux endroits à trouver. Un canal, un
 * propriétaire.
 *
 * ── Ce que ce module NE fait pas : réessayer ────────────────────────────────
 *
 * Un utilisateur attend devant son écran. Un réessai automatique enverrait
 * potentiellement DEUX SMS pour un seul appui, dont l'un porte un code périmé
 * dès sa réception — l'utilisateur saisit alors le mauvais des deux et se voit
 * refuser. Le rejeu appartient à l'utilisateur, protégé par le délai de renvoi.
 */

const {
  basePrincipal,
  jetonPrincipal,
} = require("../../utils/principalEndpoint");

const logger = require("../../utils/logger");
const { last4 } = require("../../utils/phone");

/**
 * 12 s. Twilio répond en moins d'une seconde en régime normal ; au-delà de
 * cette borne, mieux vaut rendre « réessaie » que laisser la requête HTTP de
 * l'utilisateur mourir sur le délai du client mobile (30 s), qui ne lui dirait
 * rien d'exploitable.
 */
const DELAI_MS = Number(process.env.PHONE_OTP_TIMEOUT_MS || 12000);

function exigerConfiguration() {
  const base = basePrincipal();
  const jeton = jetonPrincipal();

  /**
   * ⚠️ ÉCHEC EN FERMETURE, ET NOMMÉ.
   *
   * Sans cible ni jeton, aucun SMS ne peut partir. Rendre « non vérifié » sans
   * le dire ferait apparaître un refus de dépôt comme une décision métier
   * (« ton numéro n'est pas de confiance ») alors que c'est une panne de
   * configuration. Le code d'erreur permet à l'appelant de rendre 503 plutôt
   * que 403 — la différence entre « réessaie » et « tu n'as pas le droit ».
   */
  if (!base) {
    throw Object.assign(new Error("PRINCIPAL_URL_MISSING"), {
      code: "PRINCIPAL_URL_MISSING",
      statut: 503,
    });
  }

  if (!jeton) {
    throw Object.assign(new Error("PRINCIPAL_INTERNAL_TOKEN_MISSING"), {
      code: "PRINCIPAL_INTERNAL_TOKEN_MISSING",
      statut: 503,
    });
  }

  return { base, jeton };
}

async function appeler(chemin, corps) {
  const { base, jeton } = exigerConfiguration();

  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), DELAI_MS);

  let reponse;
  let charge = null;

  try {
    reponse = await fetch(`${base}/api/v1/internal/verification/phone/${chemin}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-token": jeton,
      },
      body: JSON.stringify(corps),
      signal: controleur.signal,
    });

    charge = await reponse.json().catch(() => null);
  } catch (err) {
    const expire = err?.name === "AbortError";

    logger.error("[otp] appel au principal impossible", {
      chemin,
      phone: last4(corps?.phoneE164),
      raison: expire ? "timeout" : err?.message,
    });

    throw Object.assign(
      new Error(expire ? "OTP_UPSTREAM_TIMEOUT" : "OTP_UPSTREAM_UNREACHABLE"),
      { code: expire ? "OTP_UPSTREAM_TIMEOUT" : "OTP_UPSTREAM_UNREACHABLE", statut: 503 }
    );
  } finally {
    clearTimeout(minuteur);
  }

  if (!reponse.ok) {
    /**
     * On RELAIE le statut du principal au lieu de l'aplatir. 422 dit « ce
     * numéro ne recevra jamais de SMS » et 503 dit « réessaie » : les deux
     * appellent des actions opposées côté application, et un 500 uniforme
     * ferait boucler l'utilisateur sur un numéro définitivement injoignable.
     */
    throw Object.assign(new Error(charge?.code || `OTP_HTTP_${reponse.status}`), {
      code: charge?.code || `OTP_HTTP_${reponse.status}`,
      statut: reponse.status,
      message: charge?.error || "",
    });
  }

  return charge?.data || {};
}

/** Demande l'envoi d'un code. Rend `{ sent, channel, phoneE164 }`. */
async function envoyerCode({ phoneE164, channel = "sms" }) {
  return appeler("start", { phoneE164, channel });
}

/**
 * Vérifie un code. Rend `{ approved, status, phoneE164 }`.
 *
 * ⚠️ `approved` EST LE SEUL VERDICT. Un appel qui réussit avec
 * `approved: false` signifie « code faux » : la requête HTTP a fonctionné, la
 * vérification non. Confondre les deux laisserait un code erroné établir la
 * confiance sur un numéro.
 */
async function verifierCode({ phoneE164, code }) {
  return appeler("check", { phoneE164, code });
}

module.exports = { envoyerCode, verifierCode, DELAI_MS };
