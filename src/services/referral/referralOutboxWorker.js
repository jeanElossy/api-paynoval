"use strict";

/**
 * ============================================================================
 * WORKER DE LIVRAISON DES ÉVÉNEMENTS DE PARRAINAGE
 * ============================================================================
 *
 * Consomme la file écrite par `referralEventOutbox` et notifie le backend
 * principal, qui décidera de l'éligibilité et déclenchera le versement.
 *
 * CE QUE CE WORKER NE FAIT PAS, ET NE DOIT JAMAIS FAIRE
 * -----------------------------------------------------
 * Il n'évalue aucune condition, ne calcule aucun montant, ne déplace aucun
 * argent. Il transporte un signal : « cet utilisateur vient de faire une
 * transaction qualifiante ». Toute intelligence ajoutée ici créerait un second
 * moteur de décision, à côté de celui du principal — et deux moteurs de
 * décision finissent toujours par diverger.
 *
 * SÉMANTIQUE DE LIVRAISON
 * -----------------------
 * Au moins une fois. Le principal peut donc recevoir le même événement
 * plusieurs fois, et c'est prévu : sa chaîne est idempotente de bout en bout
 * (machine à états sur la récompense, puis registre de versements côté
 * Tx-Core). Un doublon de signal ne produit pas un doublon d'argent.
 */

let logger = console;
try {
  logger = require("../../logger");
} catch {}

const {
  SERVICE,
  EVENT_ACTIVITY_CONFIRMED,
  buildWorkerId,
  claimBatch,
  reapExpiredLocks,
  settleSuccess,
  settleFailure,
} = require("./referralEventOutbox");

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

function getPrincipalBaseUrl() {
  return normalizeBaseUrl(
    pickFirstEnv(
      "PRINCIPAL_REFERRAL_BASE_URL",
      "PRINCIPAL_API_BASE_URL",
      "PRINCIPAL_BASE_URL",
      "MAIN_BACKEND_BASE_URL"
    )
  );
}

function getPrincipalInternalToken() {
  return pickFirstEnv(
    "PRINCIPAL_INTERNAL_TOKEN",
    "INTERNAL_REFERRAL_TOKEN",
    "INTERNAL_TOKEN"
  );
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

/**
 * Traite un lot d'événements en attente.
 *
 * @returns {Promise<{claimed:number, delivered:number, retried:number, failed:number}>}
 */
async function processPendingReferralEvents({ limit = 50, workerId } = {}) {
  const wid = workerId || buildWorkerId();

  const items = await claimBatch({ workerId: wid, limit });

  let delivered = 0;
  let retried = 0;
  let failed = 0;

  for (const item of items) {
    if (item.event !== EVENT_ACTIVITY_CONFIRMED) {
      // Événement inconnu : on le sort de la file plutôt que de le rejouer
      // indéfiniment, et on le dit.
      logger.warn?.("[REFERRAL][WORKER] evenement inconnu ecarte", {
        outboxId: String(item._id),
        event: item.event,
      });

      await settleSuccess(item._id);
      continue;
    }

    try {
      await deliverItem(item);
      await settleSuccess(item._id);
      delivered += 1;
    } catch (err) {
      if (err?.permanent) {
        /* Échec définitif : on épuise les tentatives d'un coup. */
        await settleFailure(
          { ...item, attempts: Number(item.maxAttempts || 0) },
          err
        );
        failed += 1;
        continue;
      }

      const outcome = await settleFailure(item, err);
      if (outcome === "failed") failed += 1;
      else retried += 1;
    }
  }

  return { claimed: items.length, delivered, retried, failed };
}

/**
 * Démarre le worker périodique. Même forme que
 * `startTransactionAutoCancelWorker`, pour ne pas introduire un second modèle
 * de worker dans le dépôt.
 */
function startReferralOutboxWorker({
  intervalMs = Number(process.env.REFERRAL_OUTBOX_INTERVAL_MS || 5000),
  reapIntervalMs = Number(process.env.REFERRAL_OUTBOX_REAP_INTERVAL_MS || 60_000),
  batchSize = Number(process.env.REFERRAL_OUTBOX_BATCH_SIZE || 50),
  workerId,
} = {}) {
  if (String(process.env.REFERRAL_OUTBOX_WORKER_ENABLED || "true") === "false") {
    logger.warn?.("[REFERRAL][WORKER] desactive par configuration");
    return { workerId: workerId || "", stop() {} };
  }

  const wid = workerId || buildWorkerId();

  logger.info?.("[REFERRAL][WORKER] demarre", {
    workerId: wid,
    intervalMs,
    batchSize,
    service: SERVICE,
  });

  /**
   * Verrou de ré-entrance. Sans lui, un tour lent verrait le tour suivant
   * démarrer par-dessus, et deux passes concurrentes se disputeraient les mêmes
   * items — exactement le défaut qui avait été corrigé sur la file de
   * notifications du backend principal.
   */
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;

    try {
      const result = await processPendingReferralEvents({
        limit: batchSize,
        workerId: wid,
      });

      if (result.claimed) {
        logger.info?.("[REFERRAL][WORKER] lot traite", result);
      }
    } catch (err) {
      logger.error?.("[REFERRAL][WORKER] tour echoue", {
        workerId: wid,
        err: err?.message || err,
      });
    } finally {
      running = false;
    }
  };

  const reapTick = async () => {
    try {
      await reapExpiredLocks();
    } catch (err) {
      logger.error?.("[REFERRAL][WORKER] ramassage des verrous echoue", {
        err: err?.message || err,
      });
    }
  };

  tick();

  const timer = setInterval(tick, Math.max(1000, Number(intervalMs)));
  const reaper = setInterval(
    reapTick,
    Math.max(10_000, Number(reapIntervalMs))
  );

  if (typeof timer.unref === "function") timer.unref();
  if (typeof reaper.unref === "function") reaper.unref();

  return {
    workerId: wid,

    stop() {
      clearInterval(timer);
      clearInterval(reaper);
      logger.info?.("[REFERRAL][WORKER] arrete", { workerId: wid });
    },
  };
}

module.exports = {
  processPendingReferralEvents,
  startReferralOutboxWorker,
  deliverItem,
};
