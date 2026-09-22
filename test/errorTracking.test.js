"use strict";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * errorTracking — la garde du défaut D1, et le filtre de sortie (règle B.4)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ LE TEST QUI COMPTE EST « un SDK sans setupExpressErrorHandler est REFUSÉ
 *    BRUYAMMENT ». C'est la reproduction exacte du défaut D1 :
 *
 *      if (sentry && sentry.Handlers?.requestHandler) { … }
 *
 *    Sur @sentry/node 9.47.1, `Sentry.Handlers` vaut `undefined`. Le montage
 *    était donc sauté en silence, et le service tournait sans suivi d'erreurs
 *    en croyant en avoir un. Ce test échoue si quelqu'un réintroduit un repli
 *    silencieux sur une API absente (règle B.5).
 *
 * Le reste vérifie que RIEN de sensible ne quitte le processus. Ces assertions
 * sont la traduction directe de la règle B.4 : « jamais dans un journal, une
 * réponse d'API, un registre d'événements ni un message d'erreur ».
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createErrorTracking,
  redactString,
  stripUrlQuery,
  deepRedact,
  scrubEvent,
  scrubBreadcrumb,
} = require("../src/services/errorTracking");

/* -------------------------------------------------------------------------- */
/* Outillage                                                                  */
/* -------------------------------------------------------------------------- */

const makeLogger = () => {
  const lines = { info: [], warn: [], error: [] };
  return {
    lines,
    info: (m) => lines.info.push(String(m)),
    warn: (m) => lines.warn.push(String(m)),
    error: (m) => lines.error.push(String(m)),
  };
};

/** Un SDK v8+ minimal — celui qu'on sait piloter. */
const makeModernSdk = () => {
  const calls = { init: [], setupExpressErrorHandler: 0, captured: [], tags: {}, user: undefined };
  return {
    calls,
    init: (opts) => calls.init.push(opts),
    setTag: (k, v) => {
      calls.tags[k] = v;
    },
    setUser: (u) => {
      calls.user = u;
    },
    setupExpressErrorHandler: () => {
      calls.setupExpressErrorHandler += 1;
    },
    withScope: (fn) => {
      const extras = {};
      const tags = {};
      fn({ setExtra: (k, v) => (extras[k] = v), setTag: (k, v) => (tags[k] = v) });
      calls.captured.push({ extras, tags });
    },
    captureException: (err) => {
      const last = calls.captured[calls.captured.length - 1];
      if (last) last.error = err;
    },
  };
};

const DSN = "https://k@o0.ingest.sentry.io/1";

/* ========================================================================== */
/* 1) LA GARDE D1                                                             */
/* ========================================================================== */

test("D1 — un SDK exposant Handlers mais PAS setupExpressErrorHandler est REFUSÉ, et l'annonce", () => {
  const logger = makeLogger();

  /**
   * Exactement la forme du SDK v7 que l'ancien code attendait. Le point du
   * test : ne pas se contenter de « ça ne plante pas ». Un refus SILENCIEUX
   * serait le défaut d'origine.
   */
  const sdkV7 = {
    init: () => {},
    setTag: () => {},
    Handlers: { requestHandler: () => {}, errorHandler: () => {} },
  };

  const tracking = createErrorTracking({
    loadSdk: () => sdkV7,
    dsn: DSN,
    environment: "production",
    logger,
  });

  const state = tracking.init();

  assert.equal(state.enabled, false, "un SDK incompatible ne doit JAMAIS être déclaré actif");
  assert.match(state.reason, /incompatible/i);
  assert.equal(logger.lines.error.length, 1, "le refus doit être ANNONCÉ, pas avalé");
  assert.match(
    logger.lines.error[0],
    /CONSÉQUENCE/,
    "règle B.6 : annoncer avec la conséquence, pas seulement la cause"
  );
  assert.equal(
    tracking.setupExpressErrorHandler({}),
    false,
    "rien ne doit être monté sur un SDK refusé"
  );
});

test("D1 — un SDK v8+ est initialisé et le gestionnaire d'erreurs est réellement monté", () => {
  const sdk = makeModernSdk();
  const logger = makeLogger();

  const tracking = createErrorTracking({
    loadSdk: () => sdk,
    dsn: DSN,
    environment: "production",
    release: "1.2.3",
    logger,
  });

  const state = tracking.init();

  assert.equal(state.enabled, true);
  assert.equal(sdk.calls.init.length, 1);
  assert.equal(sdk.calls.init[0].environment, "production");
  assert.equal(sdk.calls.init[0].release, "1.2.3");
  assert.equal(
    sdk.calls.init[0].sendDefaultPii,
    false,
    "aucune donnée de personne par défaut — le premier des deux verrous"
  );

  assert.equal(tracking.setupExpressErrorHandler({}), true);
  assert.equal(sdk.calls.setupExpressErrorHandler, 1);
});

test("SENTRY_DSN absente : désactivé, et la conséquence est annoncée", () => {
  const logger = makeLogger();
  const tracking = createErrorTracking({
    loadSdk: () => makeModernSdk(),
    dsn: "",
    environment: "production",
    logger,
  });

  const state = tracking.init();
  assert.equal(state.enabled, false);
  assert.equal(logger.lines.warn.length, 1);
  assert.match(logger.lines.warn[0], /CONSÉQUENCE/);
});

test("DSN posée mais SDK introuvable : c'est une ERREUR, pas un avertissement", () => {
  const logger = makeLogger();
  const tracking = createErrorTracking({
    loadSdk: () => null,
    dsn: DSN,
    environment: "production",
    logger,
  });

  assert.equal(tracking.init().enabled, false);
  assert.equal(
    logger.lines.error.length,
    1,
    "la configuration affirme une capacité qui n'existe pas — c'est plus grave qu'une absence de configuration"
  );
});

test("en suite de tests, rien n'est expédié — même avec un DSN valide", () => {
  const sdk = makeModernSdk();
  const tracking = createErrorTracking({
    loadSdk: () => sdk,
    dsn: DSN,
    environment: "test",
    logger: makeLogger(),
  });

  assert.equal(tracking.init().enabled, false);
  assert.equal(sdk.calls.init.length, 0, "aucun init : un test ne pollue pas un tableau de bord");
});

/* ========================================================================== */
/* 2) RÈGLE B.4 — le filtre de sortie                                         */
/* ========================================================================== */

test("redactString masque JWT, Bearer, e-mail, IBAN et numéro long", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghijkl";

  assert.match(redactString(`token=${jwt}`), /\[redacted\]/);
  assert.equal(redactString(jwt), "[jwt]");

  /** Un « Bearer » isolé : la première règle suffit et la forme reste lisible. */
  assert.equal(redactString("Bearer abc.def-ghi"), "Bearer [redacted]");

  /**
   * Précédé de `Authorization:`, les DEUX règles s'appliquent — la règle Bearer
   * d'abord, puis la règle clé=valeur sur le résultat. Le rendu devient
   * `Authorization: [redacted] [redacted]`, ce qui est moins joli et plus sûr.
   * Ce qui est testé ici est la seule chose qui compte : le jeton a disparu.
   */
  assert.doesNotMatch(redactString("Authorization: Bearer abc.def-ghi"), /abc\.def/);
  assert.doesNotMatch(redactString("Authorization: Bearer abc.def-ghi"), /ghi/);
  assert.equal(redactString("contact jean@paynoval.com svp"), "contact [email] svp");
  assert.match(redactString("IBAN FR76 3000 6000 0112 3456 7890 189"), /\[iban\]/);
  assert.match(redactString("carte 4111 1111 1111 1111"), /\[number\]/);
});

test("redactString masque les paires clé=valeur quelle que soit la casse", () => {
  for (const cle of ["password", "otp", "securityAnswer", "cvv", "refreshToken", "pin"]) {
    const out = redactString(`${cle}=SUPERSECRET123`);
    assert.doesNotMatch(out, /SUPERSECRET123/, `${cle} a fui`);
  }
});

test("redactString laisse passer ce qui est utile au diagnostic", () => {
  assert.equal(redactString("statut 502 en 1250 ms"), "statut 502 en 1250 ms");
  assert.equal(redactString("2026-09-22"), "2026-09-22");
  assert.match(redactString("montant 150.75 XOF"), /150\.75 XOF/);
});

test("une chaîne très longue est tronquée", () => {
  const out = redactString("a".repeat(5000));
  assert.ok(out.length <= 1001, `longueur ${out.length}`);
  assert.match(out, /…$/);
});

test("stripUrlQuery retire la chaîne de requête et le fragment", () => {
  assert.equal(
    stripUrlQuery("https://api.paynoval.com/v1/tx?token=abc&id=42#frag"),
    "https://api.paynoval.com/v1/tx"
  );
  assert.equal(stripUrlQuery("/api/v1/health"), "/api/v1/health");
});

test("deepRedact masque par CLÉ puis par VALEUR — les deux niveaux", () => {
  const out = deepRedact({
    securityAnswer: "ma mère",
    note: "écrire à jean@paynoval.com",
    imbrique: { otp: "123456", trace: "Bearer zzz.yyy.xxx" },
  });

  assert.equal(out.securityAnswer, "[REDACTED]", "niveau 1 : par clé");
  assert.equal(out.note, "écrire à [email]", "niveau 2 : par valeur");
  assert.equal(out.imbrique.otp, "[REDACTED]");
  assert.match(out.imbrique.trace, /Bearer \[redacted\]/);
});

test("deepRedact ne mute jamais son entrée — le chemin de l'argent en a besoin", () => {
  const original = { securityAnswer: "ma mère", montant: 150 };
  deepRedact(original);
  assert.equal(original.securityAnswer, "ma mère", "l'original a été muté");
});

test("scrubEvent retire le corps, les en-têtes, les cookies et la chaîne de requête", () => {
  const out = scrubEvent({
    request: {
      url: "https://api.paynoval.com/v1/tx/initiate?otp=123456",
      data: { securityAnswer: "ma mère", amount: 150 },
      headers: { authorization: "Bearer eyJabc.def.ghi", cookie: "sid=xyz" },
      cookies: { sid: "xyz" },
      query_string: "otp=123456",
    },
  });

  assert.equal(out.request.data, undefined, "le corps de requête ne sort JAMAIS (règle B.4)");
  assert.equal(out.request.headers, undefined, "Authorization ne sort jamais");
  assert.equal(out.request.cookies, undefined);
  assert.equal(out.request.query_string, undefined);
  assert.equal(out.request.url, "https://api.paynoval.com/v1/tx/initiate");
});

test("scrubEvent réduit l'utilisateur à son identifiant interne", () => {
  const out = scrubEvent({
    user: { id: "64f1a2b3c4d5e6f7a8b9c0d1", email: "jean@paynoval.com", ip_address: "1.2.3.4" },
  });

  assert.deepEqual(out.user, { id: "64f1a2b3c4d5e6f7a8b9c0d1" });
});

test("scrubEvent retire les variables locales des piles d'appel", () => {
  const out = scrubEvent({
    exception: {
      values: [
        {
          value: "échec pour jean@paynoval.com",
          stacktrace: {
            frames: [{ filename: "pay.js", lineno: 12, vars: { otp: "123456", pan: "4111111111111111" } }],
          },
        },
      ],
    },
  });

  const frame = out.exception.values[0].stacktrace.frames[0];
  assert.equal(frame.vars, undefined, "frame.vars porte les arguments de fonction");
  assert.equal(frame.filename, "pay.js", "ce qui sert au diagnostic est conservé");
  assert.match(out.exception.values[0].value, /\[email\]/);
});

test("scrubBreadcrumb garde la route appelée mais retire ses paramètres", () => {
  const out = scrubBreadcrumb({
    message: "appel à jean@paynoval.com",
    data: {
      url: "https://api.paynoval.com/v1/pay?token=secret",
      body: { pin: "0000" },
      headers: { authorization: "Bearer x" },
      status_code: 502,
    },
  });

  assert.equal(out.data.url, "https://api.paynoval.com/v1/pay");
  assert.equal(out.data.body, undefined);
  assert.equal(out.data.headers, undefined);
  assert.equal(out.data.status_code, 502, "le code HTTP est l'information utile");
  assert.match(out.message, /\[email\]/);
});

/* ========================================================================== */
/* 3) LE MONITORING NE CASSE JAMAIS L'APPELANT                                */
/* ========================================================================== */

test("captureError ne lève jamais, même si le SDK explose", () => {
  const sdkQuiExplose = {
    init: () => {},
    setTag: () => {},
    setupExpressErrorHandler: () => {},
    withScope: () => {
      throw new Error("SDK cassé");
    },
    captureException: () => {},
  };

  const tracking = createErrorTracking({
    loadSdk: () => sdkQuiExplose,
    dsn: DSN,
    environment: "production",
    logger: makeLogger(),
  });
  tracking.init();

  assert.doesNotThrow(() => tracking.captureError(new Error("panne")));
  assert.equal(tracking.captureError(new Error("panne")), false, "l'échec est rendu, pas caché");
});

test("init() qui échoue ne fait pas tomber l'appelant", () => {
  const sdkQuiExplose = {
    init: () => {
      throw new Error("DSN invalide");
    },
    setTag: () => {},
    setupExpressErrorHandler: () => {},
  };

  const tracking = createErrorTracking({
    loadSdk: () => sdkQuiExplose,
    dsn: DSN,
    environment: "production",
    logger: makeLogger(),
  });

  assert.doesNotThrow(() => tracking.init());
  assert.equal(tracking.status().enabled, false);
});

test("captureError masque son contexte avant de l'attacher", () => {
  const sdk = makeModernSdk();
  const tracking = createErrorTracking({
    loadSdk: () => sdk,
    dsn: DSN,
    environment: "production",
    logger: makeLogger(),
  });
  tracking.init();

  tracking.captureError(new Error("échec règlement"), {
    requestId: "req-abc-123",
    securityAnswer: "ma mère",
    note: "jean@paynoval.com",
  });

  const captured = sdk.calls.captured[0];
  assert.equal(captured.extras.securityAnswer, "[REDACTED]");
  assert.equal(captured.extras.note, "[email]");
  assert.equal(captured.extras.requestId, "req-abc-123", "la corrélation doit survivre au masquage");
  assert.equal(captured.tags.requestId, "req-abc-123");
});

test("une double initialisation n'écrase pas la configuration de masquage", () => {
  const sdk = makeModernSdk();
  const tracking = createErrorTracking({
    loadSdk: () => sdk,
    dsn: DSN,
    environment: "production",
    logger: makeLogger(),
  });

  tracking.init();
  tracking.init();
  tracking.init();

  assert.equal(sdk.calls.init.length, 1, "un seul init — sinon beforeSend pourrait être perdu");
});
