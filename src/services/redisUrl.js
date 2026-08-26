"use strict";

/**
 * ============================================================================
 * RÉSOLUTION DE LA CONNEXION REDIS — DEUX FORMES, UNE SEULE VÉRITÉ
 * ============================================================================
 *
 * L'ÉTAT DES LIEUX QUI A MOTIVÉ CE MODULE
 * ---------------------------------------
 * Les `.env` des trois services déclarent SIX variables Redis :
 *
 *     REDIS_URL       ← la seule que le code lise réellement
 *     REDIS_HOST      ┐
 *     REDIS_PORT      │  lues par `src/config.js`, exposées en `config.redis`,
 *     REDIS_USERNAME  │  et `config.redis` n'a AUCUN consommateur.
 *     REDIS_PASSWORD  │  Les quatre dernières ne sont lues nulle part.
 *     REDIS_TLS       ┘
 *
 * Le chemin Redis vivant (`rateLimitStore.js`, `socketAdapter.js`) lit
 * `process.env.REDIS_URL` en direct : il court-circuite `config.js`, donc aussi
 * son `sanitizeRedisUrl()`.
 *
 * Aujourd'hui ce n'est pas un incident — `REDIS_URL` est correctement renseignée
 * et Redis fonctionne. C'est un PIÈGE : cinq variables qui ont l'air de
 * configurer quelque chose. Le jour où quelqu'un corrige l'hôte dans
 * `REDIS_HOST` sans toucher `REDIS_URL`, il croira avoir déplacé Redis et aura
 * changé une décoration. C'est la même famille de défaut que le mode simulé des
 * prestataires : une configuration qui ment.
 *
 * CE QUE CE MODULE FAIT
 * ---------------------
 *   1. `REDIS_URL` reste PRIORITAIRE — rien ne change pour un déploiement
 *      existant, et c'est la forme que Render et Upstash fournissent.
 *   2. À défaut, la connexion est CONSTRUITE depuis les variables discrètes.
 *      Elles cessent d'être décoratives.
 *   3. Le mot de passe est ENCODÉ EN POURCENTAGE lors de cette construction.
 *      C'est l'intérêt principal de la forme discrète : `.claude/context/redis.md`
 *      documente qu'un mot de passe contenant `@`, `/` ou `:` casse le découpage
 *      d'une URL écrite à la main. Construire l'URL supprime cette classe
 *      d'erreur au lieu d'en avertir.
 *   4. Une valeur invalide est signalée en `error` — pas seulement absente.
 *   5. Une divergence entre `REDIS_URL` et les variables discrètes est
 *      signalée, parce que c'est le scénario du piège ci-dessus.
 *
 * POURQUOI UNE URL INVALIDE N'ARRÊTE PAS LE SERVICE
 * -------------------------------------------------
 * Redis ne détient AUCUNE donnée dont la perte soit un problème ici. Une URL
 * fautive ne doit pas arrêter les paiements — elle doit être BRUYANTE. Même
 * comportement qu'une variable absente (repli mémoire), mais journalisé en
 * `error`, avec la raison exacte.
 *
 * Le contraste avec les rails de paiement est délibéré : là-bas
 * (`providers/providerMode.js` de tx-core), une configuration absente FAIT
 * ÉCHOUER, parce qu'un rail qui ne peut pas payer ne doit pas accepter d'ordre.
 * Ici, un compteur indisponible ne justifie pas de refuser un virement. C'est le
 * même raisonnement qui sépare déjà la limitation de débit de l'adaptateur
 * Socket.IO.
 */

/** Schémas acceptés par ioredis pour une connexion TCP. */
const VALID_PROTOCOLS = Object.freeze(["redis:", "rediss:"]);

/**
 * Extrait une URL Redis d'une chaîne qui peut la contenir au milieu d'autres
 * jetons.
 *
 * Reprend l'intention de `sanitizeRedisUrl()` de `src/config.js` : il arrive
 * qu'on colle une commande complète (`redis-cli --tls -u rediss://…`) au lieu
 * de la seule URL. Le motif est conservé ici parce que c'est le chemin vivant.
 */
function extractRedisUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";

  /**
   * ⚠️ ON ESSAIE LA CHAÎNE BRUTE D'ABORD, ET C'EST ESSENTIEL.
   *
   * La version précédente décodait systématiquement avant d'extraire. Or un mot
   * de passe pourcent-encodé est LÉGITIME — c'est même ce que produit
   * `buildRedisUrlFromParts()` pour les mots de passe contenant `@`, `:` ou `/`.
   * Décoder `redis://default:p%40ss@host` rend `redis://default:p@ss@host`, que
   * `new URL()` découpe au premier `@` : l'hôte devient `ss@host`.
   *
   * Le décodage ne sert qu'au cas du copier-coller (`%20rediss://…`). Il ne doit
   * donc s'appliquer QUE si la chaîne brute ne contient aucune URL Redis.
   */
  const direct = s.match(/(rediss?:\/\/[^\s'"]+)/i);
  if (direct) return direct[1];

  let decoded = s;
  try {
    decoded = decodeURIComponent(s);
  } catch {
    // Une séquence `%` invalide n'est pas une raison d'abandonner : on
    // travaille sur la chaîne brute.
  }

  const m = decoded.match(/(rediss?:\/\/[^\s'"]+)/i);
  return m ? m[1] : s;
}

/**
 * Analyse une URL Redis.
 *
 * Fonction **pure**. @returns {{ok, url, tls, reason, detail}}
 */
function parseRedisUrl(raw) {
  const candidate = extractRedisUrl(raw);

  if (!candidate) {
    return { ok: false, url: null, tls: false, reason: "absent", detail: "" };
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return {
      ok: false,
      url: null,
      tls: false,
      reason: "unparseable",
      detail:
        `"${redact(candidate)}" n'est pas une URL. Forme attendue : ` +
        "redis://[utilisateur:mot-de-passe@]hôte:port[/base] (rediss:// pour TLS).",
    };
  }

  if (!VALID_PROTOCOLS.includes(parsed.protocol)) {
    return {
      ok: false,
      url: null,
      tls: false,
      reason: "invalid-scheme",
      detail:
        `schéma "${parsed.protocol}//" non supporté — ` +
        "seuls redis:// et rediss:// sont acceptés.",
    };
  }

  if (!parsed.hostname) {
    return {
      ok: false,
      url: null,
      tls: false,
      reason: "no-host",
      detail: "l'URL ne comporte pas d'hôte.",
    };
  }

  return {
    ok: true,
    url: candidate,
    // TLS UNIQUEMENT sur `rediss://`. L'imposer sur `redis://` fait échouer la
    // poignée de main sans que rien ne le signale — le bogue du 2026-08-25.
    tls: parsed.protocol === "rediss:",
    reason: "ok",
    detail: "",
    host: parsed.hostname,
    port: parsed.port || "6379",
  };
}

function truthy(v) {
  return ["true", "1", "yes", "on"].includes(String(v || "").trim().toLowerCase());
}

/**
 * Construit une URL Redis depuis les variables discrètes.
 *
 * ⚠️ L'ENCODAGE DU MOT DE PASSE EST LA RAISON D'ÊTRE DE CETTE FONCTION.
 * `encodeURIComponent` transforme `p@ss:w/rd` en `p%40ss%3Aw%2Frd`. Écrite à la
 * main, cette URL serait découpée au premier `@` et le client tenterait de se
 * connecter à un hôte inexistant — avec un message d'erreur qui ne mentionne
 * jamais le mot de passe.
 */
function buildRedisUrlFromParts(env) {
  const host = String(env.REDIS_HOST || "").trim();
  if (!host) return { ok: false, url: null, tls: false, reason: "absent", detail: "" };

  const port = String(env.REDIS_PORT || "6379").trim();
  const user = String(env.REDIS_USERNAME || "").trim();
  const pass = String(env.REDIS_PASSWORD || "").trim();
  const db = String(env.REDIS_DB || "").trim();
  const tls = truthy(env.REDIS_TLS);

  const scheme = tls ? "rediss" : "redis";

  const credentials = pass
    ? `${encodeURIComponent(user || "default")}:${encodeURIComponent(pass)}@`
    : user
    ? `${encodeURIComponent(user)}@`
    : "";

  const url = `${scheme}://${credentials}${host}:${port}${db ? `/${db}` : ""}`;

  // On repasse par l'analyseur : construire puis valider vaut mieux que
  // supposer que la construction est correcte.
  return { ...parseRedisUrl(url), source: "parts" };
}

/**
 * Masque tout ce qui pourrait être un identifiant avant journalisation.
 *
 * Une URL fautive doit être diagnosticable, mais elle contient presque toujours
 * un vrai mot de passe — on se trompe rarement sur `redis://`, souvent sur le
 * reste.
 */
function redact(url) {
  const s = String(url || "").replace(/\/\/[^/@]*@/, "//***@");
  return s.length > 70 ? `${s.slice(0, 70)}…` : s;
}

/**
 * Point d'entrée : résout la connexion et journalise le verdict.
 *
 * @param {object} opts
 * @param {object} [opts.env]          source des variables (défaut process.env)
 * @param {object} [opts.logger]
 * @param {string} [opts.scope]        préfixe de journal ("rate-limit", "socket")
 * @param {string} [opts.consequence]  ce qui se passe en mode dégradé
 */
function resolveRedisConnection({
  env = process.env,
  logger = console,
  scope = "redis",
  consequence = "",
} = {}) {
  const rawUrl = String(env.REDIS_URL || "").trim();
  const hasParts = !!String(env.REDIS_HOST || "").trim();

  /* --- Forme 1 : REDIS_URL, prioritaire ---------------------------------- */
  if (rawUrl) {
    const verdict = parseRedisUrl(rawUrl);

    if (verdict.ok) {
      /**
       * Les deux formes coexistent : on vérifie qu'elles racontent la même
       * histoire. Une divergence signifie que quelqu'un a modifié l'une en
       * croyant configurer l'autre.
       */
      if (hasParts) {
        const partsHost = String(env.REDIS_HOST || "").trim();
        const partsPort = String(env.REDIS_PORT || "6379").trim();

        if (partsHost !== verdict.host || partsPort !== String(verdict.port)) {
          logger?.warn?.(
            `[${scope}] REDIS_URL et REDIS_HOST/REDIS_PORT DIVERGENT — ` +
              `l'URL l'emporte (${verdict.host}:${verdict.port}), ` +
              `les variables discrètes (${partsHost}:${partsPort}) sont IGNORÉES.`
          );
        }
      }

      return { ...verdict, source: "url" };
    }

    // URL présente mais fautive : on tente les variables discrètes avant de
    // renoncer — mieux vaut une connexion que deux configurations cassées.
    logger?.error?.(
      `[${scope}] REDIS_URL INVALIDE — ${verdict.detail}` +
        (hasParts ? " Repli sur REDIS_HOST/REDIS_PORT." : ` ${consequence}`)
    );

    if (!hasParts) return verdict;
  }

  /* --- Forme 2 : variables discrètes -------------------------------------- */
  if (hasParts) {
    const built = buildRedisUrlFromParts(env);

    if (built.ok) {
      logger?.info?.(
        `[${scope}] connexion construite depuis REDIS_HOST/REDIS_PORT ` +
          `(${built.host}:${built.port}, TLS ${built.tls ? "activé" : "désactivé"}).`
      );
      return built;
    }

    logger?.error?.(
      `[${scope}] REDIS_HOST présent mais inexploitable — ${built.detail} ${consequence}`.trim()
    );
    return built;
  }

  /* --- Rien ---------------------------------------------------------------- */
  logger?.warn?.(
    `[${scope}] REDIS_URL absent — mode EN MÉMOIRE. ${consequence}`.trim()
  );

  return { ok: false, url: null, tls: false, reason: "absent", detail: "", source: "none" };
}


/**
 * ============================================================================
 * DIAGNOSTIC D'UNE PANNE REDIS — TRANSFORMER UN SILENCE EN PHRASE UTILE
 * ============================================================================
 *
 * Une erreur de connexion Redis se présente aujourd'hui comme un avertissement
 * générique, puis le service continue en mémoire. C'est le bon comportement
 * — mieux vaut une limitation dégradée qu'un service arrêté — mais la CAUSE
 * disparaît avec l'avertissement, et personne ne s'aperçoit que le cache n'a
 * jamais fonctionné.
 *
 * Trouvé en conditions réelles le 2026-08-26 : `REDIS_URL` déclarait
 * `rediss://` et `REDIS_TLS=true` sur un point d'accès qui répond EN CLAIR. La
 * poignée de main TLS échouait à chaque tentative, le client ne se connectait
 * jamais, et la limitation de débit comptait en mémoire — donc par instance,
 * donc multipliée par leur nombre. Le message d'origine était
 * « wrong version number », qui ne désigne pas le coupable.
 *
 * PUR : une erreur et une URL en entrée, une phrase en sortie. Aucun secret
 * n'est journalisé — ni mot de passe, ni URL complète.
 */
function diagnoseRedisError(err, url = "") {
  const message = String(err?.message || err || "");
  const scheme = String(url || "").split(":")[0] || "";
  const tls = scheme === "rediss";

  if (/wrong version number|packet length too long|record layer failure/i.test(message)) {
    return (
      "Le serveur Redis répond EN CLAIR alors que la configuration demande TLS " +
      "(`rediss://` / `REDIS_TLS=true`). Deux issues : activer TLS côté " +
      "fournisseur — c'est la bonne pour de la production, un mot de passe Redis " +
      "circule sinon en clair — ou repasser l'URL en `redis://`. En l'état, le " +
      "client ne se connecte JAMAIS et tout ce qui dépend de Redis fonctionne en " +
      "mémoire, donc par instance."
    );
  }

  if (/self.signed|unable to verify|certificate/i.test(message)) {
    return (
      "Certificat TLS refusé par le client. Vérifier l'autorité de " +
      "certification du fournisseur — ne PAS désactiver la vérification, ce qui " +
      "reviendrait à accepter n'importe quel interlocuteur."
    );
  }

  if (/WRONGPASS|NOAUTH|invalid password/i.test(message)) {
    return (
      "Authentification Redis refusée. Vérifier `REDIS_PASSWORD` (et " +
      "`REDIS_USERNAME` si l'instance utilise les ACL Redis 6+)."
    );
  }

  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(message)) {
    return (
      "Point d'accès Redis injoignable (hôte, port ou réseau). Vérifier " +
      "`REDIS_HOST` / `REDIS_PORT` et les règles de pare-feu du fournisseur."
    );
  }

  if (!tls && /^rediss/i.test(scheme) === false && /encrypted|ssl/i.test(message)) {
    return (
      "Le serveur semble exiger TLS alors que l'URL est en `redis://`. " +
      "Passer en `rediss://`."
    );
  }

  return `Cause non reconnue (schéma ${scheme || "?"}). Message d'origine conservé.`;
}

module.exports = {
  diagnoseRedisError,
  parseRedisUrl,
  buildRedisUrlFromParts,
  resolveRedisConnection,
  extractRedisUrl,
  redact,
  truthy,
  VALID_PROTOCOLS,
};
