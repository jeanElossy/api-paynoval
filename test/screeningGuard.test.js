"use strict";

/**
 * ============================================================================
 * ON NE PART PAS EN PRODUCTION SANS CRIBLAGE
 * ============================================================================
 *
 * ── Le défaut que ces tests empêchent de revenir ────────────────────────────
 *
 * Le criblage sanctions a été trouvé ÉTEINT le 2026-09-10 : 1 359 lignes de
 * service, cinq fournisseurs gérés, branché sur les deux chemins de l'argent,
 * et `SANCTIONS_SCREENING_ENABLED` renseignée nulle part — valeur par défaut
 * `false`.
 *
 * Aucune erreur nulle part. Les routes montées, le middleware appelant le
 * service, le service répondant, les journaux propres. C'est le mode de panne
 * le plus coûteux : celui qui a l'air de marcher.
 *
 * ── Ce qui est vérifié ──────────────────────────────────────────────────────
 *
 * Que le REFUS a bien lieu, et qu'il a lieu pour les DEUX formes du défaut :
 * criblage éteint, et criblage allumé sur un fournisseur qui ne consulte aucune
 * liste. La seconde est la plus dangereuse — elle produit des journaux qui
 * annoncent un criblage actif.
 *
 * Test **pur** : aucune connexion, aucun serveur.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FOURNISSEURS_REELS,
  ScreeningGuardError,
  inspecterCriblage,
  assertScreeningReady,
} = require("../src/utils/screeningGuard");

const MUET = { info() {}, warn() {}, error() {} };

/** Journal capturant, pour vérifier CE QUI EST DIT et à quel niveau. */
function journal() {
  const lignes = { info: [], warn: [], error: [] };

  return {
    lignes,
    info: (m) => lignes.info.push(String(m)),
    warn: (m) => lignes.warn.push(String(m)),
    error: (m) => lignes.error.push(String(m)),
  };
}

const REEL = Object.freeze({
  NODE_ENV: "production",
  SANCTIONS_SCREENING_ENABLED: "true",
  SANCTIONS_SCREENING_PROVIDER: "opensanctions",
  SANCTIONS_SCREENING_FAIL_CLOSED: "true",
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* LE REFUS                                                                  */
/* ══════════════════════════════════════════════════════════════════════════ */

test("production + criblage éteint ⇒ DÉMARRAGE REFUSÉ", () => {
  assert.throws(
    () => assertScreeningReady({ NODE_ENV: "production" }, MUET),
    (err) => err instanceof ScreeningGuardError
  );
});

test("production + fournisseur `mock` ⇒ DÉMARRAGE REFUSÉ", () => {
  /**
   * ⚠️ LA FORME LA PLUS DANGEREUSE DU DÉFAUT.
   *
   * `mock` répond « aucune correspondance » à tout, et les journaux annoncent
   * un criblage ACTIF. Un contrôle qui ment coûte plus cher qu'un contrôle
   * éteint : personne ne va vérifier ce qui se déclare en bon état.
   */
  assert.throws(
    () =>
      assertScreeningReady(
        {
          NODE_ENV: "production",
          SANCTIONS_SCREENING_ENABLED: "true",
          SANCTIONS_SCREENING_PROVIDER: "mock",
        },
        MUET
      ),
    (err) => err.code === "SANCTIONS_SCREENING_REQUIRED"
  );
});

test("`SANCTIONS_SCREENING_STRICT` suffit, sans NODE_ENV=production", () => {
  /**
   * Un environnement de pré-production porte les vraies données et doit être
   * tenu au même niveau. Le lier au seul `NODE_ENV` laisserait ce cas dehors.
   */
  assert.throws(
    () => assertScreeningReady({ SANCTIONS_SCREENING_STRICT: "true" }, MUET),
    (err) => err instanceof ScreeningGuardError
  );
});

test("le message de refus DIT quoi faire, pas seulement ce qui manque", () => {
  /**
   * Un refus de démarrage qui n'indique pas la sortie se contourne en
   * commentant le garde. Le message nomme la voie sans contrat commercial.
   */
  try {
    assertScreeningReady({ NODE_ENV: "production" }, MUET);
    assert.fail("aurait dû lever");
  } catch (err) {
    assert.match(err.message, /SANCTIONS_SCREENING_ENABLED=true/);
    assert.match(err.message, /opensanctions/);
    assert.match(err.message, /CONSÉQUENCE/);
  }
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* CE QUI PASSE                                                              */
/* ══════════════════════════════════════════════════════════════════════════ */

test("un fournisseur réel en fermeture passe sans avertissement", () => {
  const j = journal();
  const etat = assertScreeningReady(REEL, j);

  assert.equal(etat.reel, true);
  assert.equal(etat.fermeture, true);
  assert.equal(j.lignes.warn.length, 0, "avertissement inattendu : " + j.lignes.warn);
  assert.equal(j.lignes.error.length, 0);
});

test("tous les fournisseurs déclarés réels sont acceptés", () => {
  for (const fournisseur of FOURNISSEURS_REELS) {
    const etat = inspecterCriblage({
      SANCTIONS_SCREENING_ENABLED: "true",
      SANCTIONS_SCREENING_PROVIDER: fournisseur,
    });

    assert.equal(etat.reel, true, `« ${fournisseur} » rejeté alors qu'il est déclaré réel`);
  }
});

test("`mock` n'est JAMAIS considéré comme un criblage réel", () => {
  assert.ok(!FOURNISSEURS_REELS.includes("mock"));
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* CE QUI EST DIT — règle B.6                                                */
/* ══════════════════════════════════════════════════════════════════════════ */

test("en développement, l'état éteint est TOLÉRÉ mais ANNONCÉ avec sa conséquence", () => {
  const j = journal();
  const etat = assertScreeningReady({}, j);

  assert.equal(etat.reel, false);
  assert.equal(j.lignes.warn.length, 1);
  assert.match(j.lignes.warn[0], /CONSÉQUENCE/);
  assert.match(j.lignes.warn[0], /liste de sanctions/);
});

test("un criblage réel SANS fermeture est signalé — règle B.2", () => {
  const j = journal();

  assertScreeningReady(
    { ...REEL, SANCTIONS_SCREENING_FAIL_CLOSED: "false" },
    j
  );

  assert.equal(j.lignes.warn.length, 1);
  assert.match(j.lignes.warn[0], /LAISSE PASSER/);
});

test("l'échappatoire de production journalise en ERROR, pas en warn", () => {
  /**
   * Une échappatoire de conformité active doit apparaître dans ce que la
   * supervision REMONTE, pas dans ce qu'elle filtre. La différence de niveau
   * est le tout du garde-fou : un `warn` de plus dans un journal bruyant ne se
   * voit pas.
   */
  const j = journal();

  const etat = assertScreeningReady(
    { NODE_ENV: "production", SANCTIONS_SCREENING_ALLOW_DISABLED: "true" },
    j
  );

  assert.equal(etat.echappatoire, true);
  assert.equal(j.lignes.error.length, 1);
  assert.match(j.lignes.error[0], /ÉCHAPPATOIRE EXPLICITE/);
  assert.match(j.lignes.error[0], /doit être retirée/);
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* LE BRANCHEMENT — sans lui, tout ce qui précède est décoratif              */
/* ══════════════════════════════════════════════════════════════════════════ */

test("le garde est réellement appelé au démarrage, et il arrête le service", () => {
  const fs = require("node:fs");
  const path = require("node:path");

  const src = fs
    .readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  assert.match(src, /require\("\.\/utils\/screeningGuard"\)/);
  assert.match(src, /assertScreeningReady\(process\.env, logger\)/);

  /**
   * Et l'erreur ARRÊTE le processus. Un `catch` qui journalise et continue
   * ferait démarrer le service sans criblage tout en affichant un refus —
   * exactement le genre de contradiction qu'on ne relit jamais.
   */
  const bloc = src.slice(
    src.indexOf("assertScreeningReady(process.env, logger)"),
    src.indexOf("assertScreeningReady(process.env, logger)") + 400
  );

  assert.match(bloc, /process\.exit\(1\)/);
});
