"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveProviderMode,
  inspectProviderMode,
  ProviderConfigError,
  readFlag,
  isProduction,
} = require("../src/providers/providerMode");

const {
  describeProviderRails,
  formatProviderRailsReport,
  assertProviderRails,
  RAILS,
} = require("../src/providers/providerConfigReport");

/**
 * Aucun `process.env` n'est touché : `env` est un paramètre des deux modules.
 * Les tests sont donc parallélisables et ne peuvent pas fuiter l'un dans
 * l'autre — c'est la raison pour laquelle l'environnement est injecté.
 */

const P = { provider: "orange", envPrefix: "ORANGE" };

/* -------------------------------------------------------------------------- */
/* La matrice de décision                                                     */
/* -------------------------------------------------------------------------- */

test("hors production, un rail non configuré est simulé — le dev doit tourner", () => {
  const mode = resolveProviderMode({
    ...P,
    baseURL: "",
    env: { NODE_ENV: "development" },
  });

  assert.equal(mode.mock, true);
  assert.equal(mode.reason, "default-non-production");
});

test("EN PRODUCTION, un rail non configuré REFUSE — c'est le correctif central", () => {
  assert.throws(
    () => resolveProviderMode({ ...P, baseURL: "", env: { NODE_ENV: "production" } }),
    (err) => {
      assert.ok(err instanceof ProviderConfigError);
      assert.equal(err.code, "PROVIDER_NOT_CONFIGURED");
      assert.equal(err.status, 503, "503 : le rail est indisponible, pas le service");
      return true;
    }
  );
});

test("une URL de base vaut déclaration d'intention : le rail est réel sans drapeau", () => {
  for (const NODE_ENV of ["development", "production"]) {
    const mode = resolveProviderMode({
      ...P,
      baseURL: "https://api.orange.example",
      env: { NODE_ENV },
    });

    assert.equal(mode.mock, false, NODE_ENV);
    assert.equal(mode.reason, "inferred-from-base-url");
  }
});

test("réel demandé sans URL : refus, quel que soit l'environnement", () => {
  for (const NODE_ENV of ["development", "production"]) {
    assert.throws(
      () =>
        resolveProviderMode({
          ...P,
          baseURL: "",
          env: { NODE_ENV, ORANGE_MOCK: "false" },
        }),
      ProviderConfigError,
      NODE_ENV
    );
  }
});

test("simulé explicite en production : refusé sans échappatoire, accepté avec", () => {
  const env = { NODE_ENV: "production", ORANGE_MOCK: "true" };

  assert.throws(
    () => resolveProviderMode({ ...P, baseURL: "", env }),
    (err) => err.code === "PROVIDER_MOCK_IN_PRODUCTION"
  );

  const mode = resolveProviderMode({
    ...P,
    baseURL: "",
    env: { ...env, ALLOW_PROVIDER_MOCK_IN_PRODUCTION: "true" },
  });

  assert.equal(mode.mock, true);
  assert.equal(mode.reason, "explicit");
});

test("le drapeau explicite prime sur l'URL de base", () => {
  const mode = resolveProviderMode({
    ...P,
    baseURL: "https://api.orange.example",
    env: { NODE_ENV: "development", ORANGE_MOCK: "true" },
  });

  assert.equal(mode.mock, true, "MOCK=true doit gagner même URL présente");
});

/* -------------------------------------------------------------------------- */
/* Lecture des drapeaux                                                       */
/* -------------------------------------------------------------------------- */

test("les formes usuelles de vrai/faux sont reconnues", () => {
  for (const v of ["true", "TRUE", "1", "yes", "on", " True "]) {
    assert.equal(readFlag({ X: v }, "X"), true, v);
  }
  for (const v of ["false", "FALSE", "0", "no", "off"]) {
    assert.equal(readFlag({ X: v }, "X"), false, v);
  }
});

test("une valeur non reconnue vaut « non renseigné », pas « faux »", () => {
  /**
   * `ORANGE_MOCK=flase` ne doit pas signifier « rail réel ». Le traiter comme
   * un `false` implicite ferait échouer les paiements en réclamant une URL,
   * sans jamais mentionner la faute de frappe.
   */
  assert.equal(readFlag({ X: "flase" }, "X"), null);
  assert.equal(readFlag({ X: "" }, "X"), null);
  assert.equal(readFlag({}, "X"), null);
});

test("NODE_ENV vide n'est pas de la production — sinon les tests ne tourneraient pas", () => {
  assert.equal(isProduction({}), false);
  assert.equal(isProduction({ NODE_ENV: "" }), false);
  assert.equal(isProduction({ NODE_ENV: "test" }), false);
  assert.equal(isProduction({ NODE_ENV: "development" }), false);
  assert.equal(isProduction({ NODE_ENV: "sandbox" }), false);
  assert.equal(isProduction({ NODE_ENV: "production" }), true);
  assert.equal(isProduction({ NODE_ENV: "staging" }), true, "staging manipule de l'argent réel");
});

test("inspectProviderMode rend l'erreur au lieu de la lever", () => {
  const state = inspectProviderMode({ ...P, baseURL: "", env: { NODE_ENV: "production" } });

  assert.equal(state.ok, false);
  assert.ok(state.error instanceof ProviderConfigError);
});

/* -------------------------------------------------------------------------- */
/* Inventaire des rails                                                       */
/* -------------------------------------------------------------------------- */

test("les sept rails sont inventoriés", () => {
  assert.equal(RAILS.length, 7);

  const report = describeProviderRails({ NODE_ENV: "development" });
  assert.equal(report.rails.length, 7);
  assert.equal(report.mocked.length, 7, "rien n'est configuré ⇒ tout est simulé hors prod");
  assert.equal(report.ok, true);
});

test("l'inventaire ne s'arrête pas au premier rail cassé", () => {
  /**
   * Un démarrage qui meurt sur ORANGE fait corriger Orange, redéployer, puis
   * mourir sur MTN. L'inventaire complet permet de tout corriger d'un coup.
   */
  // Depuis le 2026-08-26, un rail n'est exigé que s'il est DÉCLARÉ : on les
  // déclare tous ici, puisque c'est le comportement en défaut qu'on teste.
  const report = describeProviderRails({
    NODE_ENV: "production",
    PROVIDER_RAILS_ENABLED: "orange,mtn,moov,wave,stripe,visa_direct,bank_generic",
  });

  assert.equal(report.broken.length, 7);
  assert.equal(report.ok, false);
});

test("un inventaire mixte sépare correctement réels, simulés et cassés", () => {
  const report = describeProviderRails({
    NODE_ENV: "production",
    PROVIDER_RAILS_ENABLED: "orange,mtn,moov,wave,stripe,visa_direct,bank_generic",
    WAVE_BASE_URL: "https://api.wave.example",
    ORANGE_BASE_URL: "https://api.orange.example",
    MTN_MOCK: "true",
    ALLOW_PROVIDER_MOCK_IN_PRODUCTION: "true",
    // moov, stripe, visa_direct, bank_generic : déclarés, non configurés ⇒ cassés
  });

  assert.deepEqual(report.live.map((r) => r.provider).sort(), ["orange", "wave"]);
  assert.deepEqual(report.mocked.map((r) => r.provider), ["mtn"]);
  assert.equal(report.broken.length, 4);
  assert.equal(report.ok, false);
});

test("assertProviderRails nomme TOUS les rails en défaut", () => {
  assert.throws(
    () =>
      assertProviderRails({
        NODE_ENV: "production",
        PROVIDER_RAILS_ENABLED: "orange,mtn,moov,wave,stripe,visa_direct,bank_generic",
      }),
    (err) => {
      assert.equal(err.code, "PROVIDER_CONFIG_INVALID");
      assert.equal(err.rails.length, 7);
      for (const p of ["orange", "mtn", "moov", "wave", "stripe", "visa_direct", "bank_generic"]) {
        assert.ok(err.message.includes(p), `${p} absent du message`);
      }
      return true;
    }
  );
});

test("le rapport ne journalise ni URL, ni clé, ni secret", () => {
  const env = {
    NODE_ENV: "production",
    ORANGE_BASE_URL: "https://api.orange.example/v1?token=SECRET_DANS_URL",
    ORANGE_API_KEY: "sk_live_TRES_SECRET",
    WAVE_WEBHOOK_SECRET: "whsec_TRES_SECRET",
  };

  const text = formatProviderRailsReport(describeProviderRails(env)).join("\n");

  assert.ok(!text.includes("SECRET_DANS_URL"), "une URL peut porter un jeton");
  assert.ok(!text.includes("sk_live_TRES_SECRET"));
  assert.ok(!text.includes("whsec_TRES_SECRET"));
  assert.ok(text.includes("orange"), "le nom du rail, lui, doit apparaître");
});

test("le rapport signale explicitement qu'aucun rail réel n'existe", () => {
  const text = formatProviderRailsReport(
    describeProviderRails({
      NODE_ENV: "development",
      PROVIDER_RAILS_ENABLED: "orange,mtn,moov,wave,stripe,visa_direct,bank_generic",
    })
  ).join("\n");

  assert.ok(text.includes("AUCUN rail réel"));
  assert.ok(text.includes("ACCEPTENT les ordres sans jamais payer"));
});

/* -------------------------------------------------------------------------- */
/* Le contrat avec les adapters                                               */
/* -------------------------------------------------------------------------- */

test("chaque adapter consomme resolveProviderMode et n'a plus de défaut permissif", () => {
  const fs = require("fs");
  const path = require("path");

  const dir = path.join(__dirname, "..", "src", "providers");
  const files = [
    "mobilemoney/orangeAdapter.js",
    "mobilemoney/mtnAdapter.js",
    "mobilemoney/moovAdapter.js",
    "mobilemoney/waveAdapter.js",
    "card/stripeAdapter.js",
    "card/visaDirectAdapter.js",
    "bank/bankGenericAdapter.js",
  ];

  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");

    assert.ok(
      src.includes("resolveProviderMode"),
      `${f} n'utilise pas resolveProviderMode`
    );

    assert.ok(
      !/_MOCK \|\| "true"/.test(src),
      `${f} porte encore le défaut permissif _MOCK || "true"`
    );

    assert.ok(
      !src.includes("cfg.mock || !cfg.baseURL"),
      `${f} porte encore le repli « URL absente ⇒ simulé »`
    );
  }
});

test("un adapter réel mais non configuré lève au lieu de simuler", async () => {
  /**
   * Test de bout en bout sur l'adapter, pas seulement sur le résolveur : c'est
   * `getConfig()` qui doit lever, et il est appelé au début de `payout()`.
   *
   * `process.env` est modifié puis restauré — c'est le seul test qui y touche,
   * parce que l'adapter lit l'environnement global par construction.
   */
  const saved = { ...process.env };

  try {
    process.env.NODE_ENV = "production";
    delete process.env.ORANGE_BASE_URL;
    delete process.env.ORANGE_MOCK;

    delete require.cache[require.resolve("../src/providers/mobilemoney/orangeAdapter")];
    const orange = require("../src/providers/mobilemoney/orangeAdapter");

    await assert.rejects(
      () => orange.payout({ amount: 1000, currency: "XOF" }),
      (err) => {
        assert.equal(err.code, "PROVIDER_NOT_CONFIGURED");
        return true;
      },
      "un rail non configuré doit REFUSER, jamais accuser réception"
    );
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    Object.assign(process.env, saved);
    delete require.cache[require.resolve("../src/providers/mobilemoney/orangeAdapter")];
  }
});
