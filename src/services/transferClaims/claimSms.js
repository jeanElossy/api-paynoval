"use strict";

/**
 * ============================================================================
 * SMS DE RÉCLAMATION — TX CORE DÉCIDE, LE PRINCIPAL ENVOIE (2026-11-04)
 * ============================================================================
 *
 * Même partage que `notifications/phoneOtpClient.js` : le backend principal
 * possède le lien Twilio, Tx-Core possède la décision et l'état. Ce module ne
 * fait que transporter deux messages FERMÉS — le lien, puis le code — vers une
 * route interne qui en compose elle-même le texte : aucun texte libre ne part
 * d'ici, la route ne peut pas servir à envoyer n'importe quel SMS.
 *
 * SIMULATION : aucun SMS n'est jamais envoyé. Le lien et le code s'affichent à
 * l'expéditeur dans « Transferts en attente » (et le code sur la page de
 * réclamation), comme le reste de la démonstration.
 *
 * Le jeton et le code transitent dans le CORPS, jamais dans une URL ni dans un
 * journal : ils valent autorisation.
 */

const { basePrincipal, jetonPrincipal } = require("../../utils/principalEndpoint");
const logger = require("../../utils/logger");
const { phoneLast4 } = require("./claimRules");

const DELAI_MS = Number(process.env.CLAIM_SMS_TIMEOUT_MS || 12000);

/**
 * Base du lien envoyé au destinataire, par exemple `https://paynoval.com/r`.
 * Sans elle, aucun lien ne peut être construit : un transfert vers un tiers
 * est alors refusé à l'initiation (fermeture), et le démarrage l'annonce.
 */
function claimLinkBase() {
  return String(process.env.CLAIM_LINK_BASE_URL || "").trim().replace(/\/+$/, "");
}

function buildClaimLink(token) {
  const base = claimLinkBase();
  if (!base) {
    throw Object.assign(new Error("CLAIM_LINK_BASE_URL_MISSING"), {
      code: "CLAIM_LINK_BASE_URL_MISSING",
      statusCode: 503,
    });
  }
  return `${base}/${token}`;
}

async function appeler(corps) {
  const base = basePrincipal();
  const jeton = jetonPrincipal();

  if (!base || !jeton) {
    throw Object.assign(new Error("CLAIM_SMS_UNCONFIGURED"), { code: "CLAIM_SMS_UNCONFIGURED", statusCode: 503 });
  }

  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), DELAI_MS);

  try {
    const reponse = await fetch(`${base}/api/v1/internal/transfer-claims/sms`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": jeton },
      body: JSON.stringify(corps),
      signal: controleur.signal,
    });
    const charge = await reponse.json().catch(() => null);

    if (!reponse.ok) {
      throw Object.assign(new Error(charge?.code || `CLAIM_SMS_HTTP_${reponse.status}`), {
        code: charge?.code || `CLAIM_SMS_HTTP_${reponse.status}`,
        statusCode: reponse.status === 422 ? 422 : 503,
      });
    }

    return charge?.data || { sent: true };
  } catch (err) {
    if (err?.code && err?.statusCode) throw err;
    const expire = err?.name === "AbortError";
    logger.error("[claim-sms] appel au principal impossible", {
      kind: corps?.kind,
      phone: phoneLast4(corps?.phoneE164),
      raison: expire ? "timeout" : err?.message,
    });
    throw Object.assign(new Error(expire ? "CLAIM_SMS_TIMEOUT" : "CLAIM_SMS_UNREACHABLE"), {
      code: expire ? "CLAIM_SMS_TIMEOUT" : "CLAIM_SMS_UNREACHABLE",
      statusCode: 503,
    });
  } finally {
    clearTimeout(minuteur);
  }
}

/**
 * Envoie le lien au destinataire. Simulation : rien ne part, `{ sent: false,
 * reason: "SANDBOX" }`.
 */
async function sendClaimLink({ mode, phoneE164, token, senderFirstName, amountLabel }) {
  if (mode === "sandbox") return { sent: false, reason: "SANDBOX" };
  return appeler({ kind: "link", phoneE164, link: buildClaimLink(token), senderFirstName, amountLabel });
}

/** Envoie le code à usage unique. Simulation : rien ne part. */
async function sendClaimCode({ mode, phoneE164, code }) {
  if (mode === "sandbox") return { sent: false, reason: "SANDBOX" };
  return appeler({ kind: "code", phoneE164, code });
}

module.exports = { claimLinkBase, buildClaimLink, sendClaimLink, sendClaimCode };
