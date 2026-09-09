"use strict";

/**
 * GARDE D'ENVIRONNEMENT DE BASE DE DONNÉES
 * ============================================================================
 *
 * ⚠️ FICHIER RÉPLIQUÉ À L'IDENTIQUE DANS LES TROIS SERVICES :
 * `paynoval-backend/utils/dbEnvironmentGuard.js`,
 * `api-gateway/api-gateway/src/utils/dbEnvironmentGuard.js`,
 * `api-paynoval/src/utils/dbEnvironmentGuard.js`.
 * Toute correction se porte dans les trois — comme `jwtKeyring.js`,
 * `redisStoreSafety.js` et `requestId.js`.
 *
 * ── Le défaut que cette garde empêche ─────────────────────────────────────
 *
 * Le 2026-08-27, une campagne de charge a tourné contre l'Atlas de PRODUCTION.
 * Personne ne l'avait voulu : le `.env` pointait là, et rien ne le disait
 * (défaut A1 de `RESTE_A_FAIRE.md`).
 *
 * Les trois services pointent sur le **même cluster**. Jusqu'au 2026-09-03,
 * les bases s'appelaient `paynoval`, `api_transactions_paynoval` et
 * `api-gateway` — **aucun suffixe** : rien, dans une chaîne de connexion, ne
 * distinguait un environnement de test d'un environnement de production.
 *
 * Elles ont été copiées vers `…-test` et les `.env` basculés ; les bases
 * d'origine sont conservées intactes comme retour arrière. Le renommage rend
 * l'erreur VISIBLE, cette garde la rend IMPOSSIBLE — les deux se complètent,
 * et c'est le renommage qui permet d'activer `DB_ENV_STRICT=true`.
 *
 * ── Ce qu'elle vérifie ────────────────────────────────────────────────────
 *
 * 1. Elle ANNONCE toujours le cluster et la base (règle B.6). Un service qui
 *    ne dit pas sur quelles données il travaille est la panne la plus chère à
 *    diagnostiquer.
 * 2. Elle REFUSE de démarrer quand `NODE_ENV=production` et que la base porte
 *    un marqueur de non-production. Servir de la production depuis une base de
 *    test est la faute la plus grave des deux : les utilisateurs verraient des
 *    données fausses, et les vraies ne bougeraient pas.
 * 3. Elle REFUSE l'inverse — hors production sur une base marquée production —
 *    dès que `DB_ENV` est posée. C'est le sens du défaut A1.
 * 4. Elle AVERTIT quand la base ne porte aucun marqueur : on ne peut alors rien
 *    vérifier, et c'est l'état actuel du projet.
 *
 * ── Configuration ─────────────────────────────────────────────────────────
 *
 *   DB_ENV=test | production     déclare l'environnement ATTENDU des données
 *   DB_ENV_STRICT=true           refuse de démarrer si la base ne porte pas de
 *                                marqueur reconnaissable — ACTIF depuis le
 *                                renommage du 2026-09-03
 *
 * Sans `DB_ENV`, la garde se limite à annoncer et à empêcher le cas 2, le seul
 * qu'on puisse trancher sans déclaration.
 */

/** Marqueurs reconnus dans un nom de base. */
const MARQUEURS_NON_PROD = [
  "test", "dev", "staging", "recette", "sandbox", "local",
  // `bench` : les bases du banc de charge (`docs/load/bench/env.sh`). Une base
  // de mesure n'est jamais une base de production — et c'est précisément une
  // campagne de charge qui a tourné contre la production le 2026-08-27.
  "bench",
];
const MARQUEURS_PROD = ["prod", "production"];

/**
 * Extrait le nom de la base et l'hôte d'une URI, SANS jamais toucher au secret.
 * Une URI illisible rend `null` — l'appelant décide quoi en faire ; deviner
 * serait pire que de ne rien dire.
 */
function describeUri(uri) {
  const brut = String(uri || "").trim();
  if (!brut) return null;

  try {
    // `mongodb+srv://user:pass@hote/base?options`
    const sansSchema = brut.replace(/^mongodb(\+srv)?:\/\//i, "");
    const sansIdentifiants = sansSchema.includes("@")
      ? sansSchema.slice(sansSchema.indexOf("@") + 1)
      : sansSchema;

    const [hote, ...reste] = sansIdentifiants.split("/");
    const base = (reste.join("/") || "").split("?")[0];

    return { hote: hote || null, base: base || null };
  } catch {
    return null;
  }
}

/** `test` / `production` / `inconnu`, d'après le nom de la base. */
function classifyDatabaseName(nomBase) {
  const n = String(nomBase || "").toLowerCase();
  if (!n) return "inconnu";

  if (MARQUEURS_NON_PROD.some((m) => n.includes(m))) return "test";
  if (MARQUEURS_PROD.some((m) => n.includes(m))) return "production";

  return "inconnu";
}

function estProduction() {
  return String(process.env.NODE_ENV || "").trim() === "production";
}

/**
 * Vérifie la cohérence entre l'environnement d'exécution et la base visée.
 *
 * @returns {{ok: boolean, niveau: "info"|"warn"|"error", message: string, base: string|null, hote: string|null}}
 */
function checkDatabaseEnvironment(uri, { label = "base" } = {}) {
  const infos = describeUri(uri);

  if (!infos || !infos.base) {
    return {
      ok: false,
      niveau: "error",
      base: null,
      hote: infos?.hote || null,
      message:
        `❌ ${label} : impossible de lire le nom de la base dans l'URI. ` +
        "CONSÉQUENCE : on ne peut pas vérifier sur quelles données ce service " +
        "travaille. Aucun repli n'est appliqué.",
    };
  }

  const { hote, base } = infos;
  const classe = classifyDatabaseName(base);
  const prod = estProduction();
  const attendu = String(process.env.DB_ENV || "").trim().toLowerCase();
  const strict = String(process.env.DB_ENV_STRICT || "").toLowerCase() === "true";
  const ou = `${label} « ${base} » sur ${hote}`;

  // 1. Production servie depuis une base de test — le pire des deux sens.
  if (prod && classe === "test") {
    return {
      ok: false,
      niveau: "error",
      base,
      hote,
      message:
        `❌ NODE_ENV=production mais ${ou} porte un marqueur de NON-PRODUCTION. ` +
        "CONSÉQUENCE : les utilisateurs verraient des données de test, et les " +
        "vraies ne bougeraient pas. Démarrage refusé.",
    };
  }

  // 2. Développement pointé sur une base de production — le défaut A1.
  if (!prod && classe === "production") {
    return {
      ok: false,
      niveau: "error",
      base,
      hote,
      message:
        `❌ NODE_ENV="${process.env.NODE_ENV || "(absent)"}" mais ${ou} porte un ` +
        "marqueur de PRODUCTION. CONSÉQUENCE : un test, un banc de charge ou un " +
        "script d'exploitation écrirait dans les données réelles. C'est le " +
        "défaut A1, tel quel. Démarrage refusé.",
    };
  }

  // 3. `DB_ENV` déclaré et contredit par le nom de la base.
  if (attendu && classe !== "inconnu" && attendu !== classe) {
    return {
      ok: false,
      niveau: "error",
      base,
      hote,
      message:
        `❌ DB_ENV="${attendu}" mais ${ou} est classée « ${classe} ». ` +
        "Les deux se contredisent : on ne devine pas laquelle a raison. " +
        "Démarrage refusé.",
    };
  }

  // 4. Aucun marqueur — l'état actuel du projet.
  if (classe === "inconnu") {
    if (strict) {
      return {
        ok: false,
        niveau: "error",
        base,
        hote,
        message:
          `❌ DB_ENV_STRICT=true et ${ou} ne porte aucun marqueur d'environnement. ` +
          "Renommer la base avec un suffixe (-test, -prod) ou retirer DB_ENV_STRICT.",
      };
    }

    return {
      ok: true,
      niveau: "warn",
      base,
      hote,
      message:
        `⚠️ ${ou} ne porte AUCUN marqueur d'environnement. CONSÉQUENCE : rien ne ` +
        "distingue cette base d'une base de production, ni pour cette garde, ni " +
        "pour l'œil de celui qui édite le .env. C'est la configuration qui a " +
        "produit le défaut A1. Un suffixe (-test) la rendrait vérifiable.",
    };
  }

  return {
    ok: true,
    niveau: "info",
    base,
    hote,
    message: `✅ ${ou} — environnement « ${classe} », cohérent avec NODE_ENV.`,
  };
}

/**
 * Applique la garde au démarrage. Journalise TOUJOURS, lève si incohérent.
 *
 * Échoue en FERMETURE : un service qui ne peut pas prouver qu'il vise les
 * bonnes données ne démarre pas. C'est un arbitrage assumé — un démarrage
 * refusé se voit tout de suite, une écriture dans la mauvaise base ne se voit
 * qu'après coup, et parfois jamais.
 */
function assertDatabaseEnvironment(uri, { label = "base", logger = console } = {}) {
  const r = checkDatabaseEnvironment(uri, { label });

  if (r.niveau === "error" && !r.ok) {
    logger.error?.(r.message);
    const err = new Error(r.message);
    err.code = "DB_ENVIRONMENT_MISMATCH";
    throw err;
  }

  if (r.niveau === "warn") logger.warn?.(r.message);
  else logger.info?.(r.message);

  return r;
}

/**
 * Garde pour un script qui ÉCRIT — purge, migration, seed.
 *
 * Plus stricte que celle du démarrage : un service qui lit peut tolérer une
 * base non marquée, un script qui efface, non. Il faut une déclaration
 * explicite, ou `--yes-i-know` pour la lever en connaissance de cause.
 */
function assertSafeForDestructiveWrite(uri, { nomScript = "ce script", argv = process.argv } = {}) {
  const r = checkDatabaseEnvironment(uri, { label: "base cible" });
  const force = argv.includes("--yes-i-know");

  console.log(r.message);

  if (!r.ok && !force) {
    throw Object.assign(
      new Error(
        `${nomScript} refuse d'écrire : ${r.message}\n` +
          "Relancer avec --yes-i-know pour passer outre, en connaissance de cause."
      ),
      { code: "DB_ENVIRONMENT_MISMATCH" }
    );
  }

  /**
   * `DB_ENV` fait AUTORITÉ quand le nom de base ne dit rien.
   *
   * C'est le sens même de la déclaration : le nom `paynoval` ne permet pas de
   * trancher, l'opérateur déclare donc explicitement de quoi il s'agit. Sans
   * cette ligne, la garde réclamait `DB_ENV` puis l'ignorait — un conseil qui
   * ne marchait pas, ce qui est pire que pas de conseil.
   *
   * Le nom reste prioritaire quand il porte un marqueur : une base nommée
   * `paynoval-prod` est de la production, quoi que déclare `DB_ENV`. La
   * contradiction est d'ailleurs traitée plus haut, en refus.
   */
  const parNom = classifyDatabaseName(r.base);
  const declare = String(process.env.DB_ENV || "").trim().toLowerCase();
  const classe = parNom !== "inconnu" ? parNom : declare || "inconnu";

  if (classe === "production" && !force) {
    throw Object.assign(
      new Error(
        `${nomScript} vise une base classée PRODUCTION (« ${r.base} »). ` +
          "Refus. Relancer avec --yes-i-know si c'est réellement voulu."
      ),
      { code: "DB_WRITE_ON_PRODUCTION" }
    );
  }

  if (classe === "inconnu" && !force) {
    console.log(
      "\n⚠️ La base ne porte aucun marqueur d'environnement et DB_ENV n'est pas " +
        "déclarée : cette garde ne peut pas vérifier qu'il ne s'agit pas de la " +
        "production.\n" +
        "   Poser DB_ENV=test, renommer la base avec un suffixe, ou relancer " +
        "avec --yes-i-know."
    );
    throw Object.assign(new Error("Environnement de base non vérifiable."), {
      code: "DB_ENVIRONMENT_UNKNOWN",
    });
  }

  if (parNom === "inconnu" && declare) {
    console.log(
      `ℹ️ Environnement « ${declare} » pris de DB_ENV — le nom de la base ne le ` +
        "confirme pas. Un suffixe le rendrait vérifiable sans déclaration."
    );
  }

  if (force) {
    console.log("⚠️ --yes-i-know : garde d'environnement levée explicitement.");
  }

  return r;
}

module.exports = {
  describeUri,
  classifyDatabaseName,
  checkDatabaseEnvironment,
  assertDatabaseEnvironment,
  assertSafeForDestructiveWrite,
};
