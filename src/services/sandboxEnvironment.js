"use strict";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LA FRONTIÈRE ENTRE LES DEUX MONDES — PRODUCTION ET SIMULATION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ CE MODULE EST RÉPLIQUÉ OCTET POUR OCTET DANS LES TROIS SERVICES :
 *     api-paynoval/src/services/sandboxEnvironment.js
 *     paynoval-backend/services/sandboxEnvironment.js
 *     api-gateway/api-gateway/src/services/sandboxEnvironment.js
 * Un test d'empreinte (`api-paynoval/test/sandboxEnvironment.test.js`) échoue
 * à la divergence.
 *
 * ── LE MODÈLE RETENU ──────────────────────────────────────────────────────
 *
 * Celui de Wise, de PayPal et de Revolut, et des sandboxes de Stripe : la
 * simulation est un ENVIRONNEMENT SÉPARÉ, avec ses services, ses bases, ses
 * clés et ses hôtes. Le champ `mode` de chaque objet reste, comme seconde
 * barrière. Ce qui rend le passage d'un monde à l'autre impossible n'est donc
 * plus une condition dans le code, mais l'absence des clés de l'autre monde.
 *
 * Trois décisions vivent ici, sans base ni réseau :
 *
 *   1. `auditEnvironment` — au démarrage, la configuration est-elle cohérente ?
 *      La production refuse tout ce qui ouvrirait la simulation ; la simulation
 *      refuse toute clé d'un service réel. Une violation empêche de démarrer :
 *      un refus se voit tout de suite, une fuite parfois jamais.
 *   2. `evaluateTokenEnvironment` — un jeton n'est accepté que dans son monde.
 *      Les clés de signature diffèrent déjà ; ce contrôle tient même si un
 *      secret était partagé par erreur.
 *   3. `assertRealRailAllowed` — en simulation, aucun rail réel ne s'ouvre.
 *
 * On ne compare volontairement que « simulation ou non » : `staging` et
 * `production` se séparent par leurs clés, et comparer des libellés exacts
 * couperait toutes les sessions d'un service dont `APP_ENV` serait mal posée.
 */

const { ENVIRONMENTS, resolveEnvironment } = require("./appEnv");

/** Services réels dont aucune clé ne doit exister en simulation. */
const REAL_SERVICE_PREFIX =
  /^(TWILIO|SENDGRID|SUMSUB|WAVE|ORANGE|MTN|MOOV|VISA_DIRECT|FLUTTERWAVE|STRIPE)_/;

/** Réglages de ces services qui ne sont ni un secret, ni une adresse. */
const HARMLESS_SUFFIX = /_(MOCK|MODE|TIMEOUT_MS|WEBHOOK_TOLERANCE_SEC|COLLECT_ENABLED)$/;

function isOn(raw) {
  return ["true", "1", "yes", "on"].includes(String(raw ?? "").trim().toLowerCase());
}

function boundaryError(message, code, status) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  err.statusCode = status;
  return err;
}

/**
 * Noms des variables de services réels présentes. Les NOMS seulement : une
 * valeur est peut-être un secret, et ce rapport part dans les journaux.
 */
function realCredentialsIn(env) {
  return Object.keys(env)
    .filter((name) => REAL_SERVICE_PREFIX.test(name) && !HARMLESS_SUFFIX.test(name))
    .filter((name) => String(env[name] ?? "").trim() !== "")
    .sort();
}

/**
 * Fonction PURE : tout lui est fourni.
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {{appEnv: string, sandboxOpen: boolean, violations: Array<{code: string, message: string}>}}
 */
function auditEnvironment(env = process.env) {
  const { env: appEnv } = resolveEnvironment(env);
  const violations = [];
  const sandboxFlag = isOn(env.SANDBOX_MODE_ENABLED);

  if (appEnv === ENVIRONMENTS.PRODUCTION) {
    if (sandboxFlag) {
      violations.push({
        code: "SANDBOX_IN_PRODUCTION",
        message:
          "SANDBOX_MODE_ENABLED est posée en production. CONSÉQUENCE : des comptes fictifs " +
          "seraient servis à côté des vrais. La retirer, ou déclarer l'environnement réel " +
          "par APP_ENV (staging, sandbox).",
      });
    }

    if (isOn(env.ALLOW_PROVIDER_MOCK_IN_PRODUCTION)) {
      violations.push({
        code: "PROVIDER_MOCK_IN_PRODUCTION",
        message:
          "ALLOW_PROVIDER_MOCK_IN_PRODUCTION est posée en production. CONSÉQUENCE : un rail " +
          "accepterait des ordres de paiement sans les exécuter. La retirer.",
      });
    }
  }

  if (appEnv === ENVIRONMENTS.SANDBOX) {
    if (!sandboxFlag) {
      violations.push({
        code: "SANDBOX_SWITCH_OFF",
        message:
          "APP_ENV=sandbox sans SANDBOX_MODE_ENABLED=true. CONSÉQUENCE : aucun compte ne " +
          "serait servi.",
      });
    }

    if (!String(env.JWT_ISSUER ?? "").toLowerCase().includes("sandbox")) {
      violations.push({
        code: "SANDBOX_ISSUER_REQUIRED",
        message:
          "APP_ENV=sandbox exige un JWT_ISSUER propre contenant « sandbox ». CONSÉQUENCE : " +
          "rien ne distinguerait un jeton de simulation d'un jeton réel.",
      });
    }

    for (const name of realCredentialsIn(env)) {
      violations.push({
        code: "REAL_CREDENTIAL_IN_SANDBOX",
        message:
          `${name} est posée en simulation. CONSÉQUENCE : un service réel resterait ` +
          "joignable depuis l'argent fictif. La retirer.",
      });
    }
  }

  return {
    appEnv,
    sandboxOpen: sandboxFlag && appEnv !== ENVIRONMENTS.PRODUCTION,
    violations,
  };
}

/**
 * Applique l'audit au démarrage. Journalise toujours (règle B.6), lève sur une
 * violation : l'appelant arrête le processus.
 */
function assertEnvironmentBoundary({ env = process.env, logger = console } = {}) {
  const report = auditEnvironment(env);

  if (report.violations.length) {
    for (const v of report.violations) logger.error?.(`[env] ❌ ${v.code} — ${v.message}`);

    throw boundaryError(
      `Frontière d'environnement violée : ${report.violations.map((v) => v.code).join(", ")}.`,
      "ENVIRONMENT_BOUNDARY_VIOLATION",
      500
    );
  }

  if (report.appEnv === ENVIRONMENTS.SANDBOX) {
    logger.warn?.(
      "[env] 🧪 ENVIRONNEMENT DE SIMULATION — argent fictif, prestataires simulés, aucun " +
        "SMS, e-mail ni push. Aucun compte réel ni aucune clé réelle ne doit exister ici."
    );
  } else if (report.sandboxOpen) {
    logger.warn?.(
      `[env] ⚠️ Simulation ouverte sur l'environnement ${report.appEnv.toUpperCase()}. ` +
        "CONSÉQUENCE : comptes fictifs et comptes ordinaires partagent les mêmes bases et " +
        "les mêmes clés. Acceptable tant qu'aucune donnée réelle n'existe ici : voir " +
        "docs/ops/sandbox-environment.md §8 avant le premier client réel."
    );
  }

  return report;
}

/**
 * Un jeton n'est accepté que dans son monde. `appEnv` est passé par l'appelant.
 * Un jeton sans revendication `env` n'existe pas en simulation : il est refusé.
 */
function evaluateTokenEnvironment({ appEnv, claimedEnv }) {
  const here = appEnv === ENVIRONMENTS.SANDBOX;
  const there = claimedEnv === ENVIRONMENTS.SANDBOX;

  if (here === there) return { ok: true };

  return {
    ok: false,
    status: 401,
    code: "ENV_TOKEN_MISMATCH",
    message: "Session incohérente : reconnectez-vous.",
  };
}

/** En simulation, aucun rail réel ne s'ouvre — pas même pour un compte « live ». */
function assertRealRailAllowed({ appEnv, rail, provider }) {
  if (appEnv !== ENVIRONMENTS.SANDBOX) return;

  throw boundaryError(
    `Rail réel ${rail}/${provider} demandé dans l'environnement de simulation : refusé.`,
    "REAL_RAIL_FORBIDDEN_IN_SANDBOX",
    403
  );
}

module.exports = {
  auditEnvironment,
  assertEnvironmentBoundary,
  evaluateTokenEnvironment,
  assertRealRailAllowed,
  realCredentialsIn,
};
