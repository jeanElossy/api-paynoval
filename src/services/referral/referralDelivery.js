"use strict";

const {
  basePrincipal,
  jetonPrincipal,
} = require("../../utils/principalEndpoint");

/**
 * ============================================================================
 * LIVRAISON D'UN ÉVÉNEMENT DE PARRAINAGE — UNE SEULE IMPLÉMENTATION
 * ============================================================================
 *
 * ── Pourquoi ce fichier existe ──────────────────────────────────────────────
 *
 * La livraison vivait dans `referralOutboxWorker.js`. Le 2026-09-10, le
 * parrainage a migré vers le bus d'événements partagé — et pendant la
 * transition DEUX transports coexistent : l'ancien worker draine le reliquat de
 * l'outbox, le nouveau consommateur lit le flux.
 *
 * Recopier la livraison aurait produit deux façons d'appeler
 * `/api/v1/internal/referral/award-bonus`, avec deux politiques de délai, deux
 * traitements du 4xx et deux corps de requête. Ce dépôt sait ce que ça donne :
 * deux `aml.js` de même souche, 1 234 lignes d'écart, chacun recevant la moitié
 * des correctifs.
 *
 * Les deux transports appellent donc CETTE fonction, et elle seule.
 *
 * ── Ce que la charge utile ne contient PAS, délibérément ────────────────────
 *
 * Ni le montant, ni la devise, ni le bonus à verser. Le principal RÉÉVALUE le
 * filleul à partir de ses propres données. C'est la traduction concrète du
 * zero-trust : même si ce transport était détourné, l'attaquant ne pourrait
 * rien demander d'autre que « réévalue ce filleul » — ce que le principal fait
 * de toute façon.
 */

function normalizeBaseUrl(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

function pickFirstEnv(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (String(value || "").trim()) return String(value).trim();
  }
  return "";
}

/**
 * ⚠️ DÉLÉGUÉ À `utils/principalEndpoint` DEPUIS LE 2026-09-10.
 *
 * Cette fonction lisait quatre noms de variable — dont AUCUN n'était posé.
 * Résultat mesuré : le worker de parrainage tournait, réclamait ses lots, et
 * échouait à chaque tour sur `PRINCIPAL_BASE_URL_MISSING`. Aucun bonus n'était
 * livrable, et rien ne le disait au démarrage.
 *
 * Sept noms coexistaient dans le service pour désigner la même chose, chaque
 * appelant lisant sa propre sous-liste. C'est le même défaut que les trois
 * chaînes de jeton interne, refermé le même jour.
 */
function getPrincipalBaseUrl() {
  return basePrincipal();
}

function getPrincipalInternalToken() {
  return jetonPrincipal();
}

function getRequestTimeoutMs() {
  const raw = Number(
    pickFirstEnv("REFERRAL_OUTBOX_HTTP_TIMEOUT_MS", "INTERNAL_HTTP_TIMEOUT_MS") ||
      15000
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 15000;
}

function buildUrl(baseUrl, path) {
  const base = normalizeBaseUrl(baseUrl);

  if (/\/api\/v1$/i.test(base) && /^\/api\/v1\//i.test(path)) {
    return `${base.replace(/\/api\/v1$/i, "")}${path}`;
  }

  return `${base}${path}`;
}

async function readJsonSafe(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 2000) };
  }
}

/**
 * Livre un événement au backend principal.
 *
 * LE CORPS NE CONTIENT NI MONTANT NI STATISTIQUE. Uniquement l'identité du
 * filleul, la transaction déclenchante et l'identifiant de corrélation. C'est la
 * traduction concrète du zero-trust : même si ce transport était détourné,
 * l'attaquant ne pourrait rien choisir d'autre que « réévalue ce filleul » — ce
 * que le principal fait de toute façon à partir de ses propres données.
 */
async function deliverItem(item) {
  const baseUrl = getPrincipalBaseUrl();
  const token = getPrincipalInternalToken();

  if (!baseUrl) {
    throw Object.assign(new Error("PRINCIPAL_BASE_URL_MISSING"), {
      code: "PRINCIPAL_BASE_URL_MISSING",
    });
  }

  if (!token) {
    throw Object.assign(new Error("PRINCIPAL_INTERNAL_TOKEN_MISSING"), {
      code: "PRINCIPAL_INTERNAL_TOKEN_MISSING",
    });
  }

  const payload = item?.payload || {};
  const correlationId = String(payload.correlationId || "");

  const url = buildUrl(baseUrl, "/api/v1/internal/referral/award-bonus");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getRequestTimeoutMs());

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-token": token,
        "x-correlation-id": correlationId,
      },
      body: JSON.stringify({
        refereeId: String(payload.refereeId || ""),
        triggerTxId: String(payload.triggerTxId || ""),
        correlationId,
      }),
      signal: controller.signal,
    });

    const data = await readJsonSafe(response);

    if (!response.ok) {
      /**
       * Un 4xx ne se rejoue pas : la demande est malformée ou refusée sur le
       * fond, la répéter à l'identique donnerait le même résultat. On abandonne
       * immédiatement plutôt que d'épuiser dix tentatives pour rien.
       */
      const permanent = response.status >= 400 && response.status < 500;

      throw Object.assign(
        new Error(
          `PRINCIPAL_HTTP_${response.status}:${
            data?.code || data?.error || "UNKNOWN"
          }`
        ),
        { code: `PRINCIPAL_HTTP_${response.status}`, permanent }
      );
    }

    return { ok: true, data };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  deliverItem,
  getPrincipalBaseUrl,
  getPrincipalInternalToken,
  getRequestTimeoutMs,
  buildUrl,
};
