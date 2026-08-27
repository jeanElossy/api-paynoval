"use strict";

/**
 * ============================================================================
 * LA BARRIÈRE — ELLE PASSE AVANT LA PREMIÈRE ÉCRITURE, TOUJOURS
 * ============================================================================
 *
 * Cette suite ÉCRIT. Elle crée des portefeuilles, réserve des fonds, pose des
 * écritures au grand livre. Lancée contre la mauvaise base, elle ne produit pas
 * un test raté : elle produit des mouvements financiers dans une base réelle.
 *
 * ── Pourquoi une barrière propre, et non celle de `docs/load/bench/preflight.js`
 *
 * `docs/` appartient au dépôt racine du workspace ; `api-paynoval/` est un dépôt
 * INDÉPENDANT. Un `require("../../../docs/...")` marcherait sur ce poste et
 * nulle part ailleurs — le jour où ce dépôt est cloné seul, la barrière
 * disparaîtrait sans bruit. Une garde qui dépend d'un fichier hors du dépôt
 * n'est pas une garde, c'est une coïncidence de disposition.
 *
 * ── Deux verrous indépendants, et c'est délibéré
 *
 *   1. L'HÔTE doit être dans l'allowlist. Jamais une liste noire : le jour où
 *      la production s'appelle `paynoval-api.onrender.com`, une règle
 *      « refuser ce qui contient prod » ne dit rien et la rafale part.
 *
 *   2. LE NOM DE BASE doit être préfixé `bench_` ou `test_`. Aucune base réelle
 *      de PayNoval ne porte ces préfixes.
 *
 * Un seul verrou aurait suffi à quelqu'un de prudent. Deux servent le cas
 * réel : un tunnel SSH qui expose Atlas sur `localhost:27117` franchit le
 * premier verrou sans difficulté — et bute sur le second.
 *
 * ── Ce précédent n'est pas théorique
 *
 * Le 2026-08-26, une campagne de charge a démarré TX Core contre l'Atlas de
 * PRODUCTION : un `&` non échappé dans l'URI a fait que bash a mis
 * l'affectation en tâche de fond, et `dotenv` a comblé le vide avec le `.env`
 * du dépôt. Le garde de l'époque contrôlait trois variables sur les neuf que le
 * système lit réellement, et affichait « toutes les cibles sont locales ».
 *
 * D'où la règle appliquée ici : **une variable ABSENTE est un refus**, au même
 * titre qu'un hôte interdit. Un garde incomplet est pire qu'un garde absent —
 * il donne une assurance fausse.
 */

const HOTES_AUTORISES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "mongo",
  "redis",
]);

const PREFIXES_BASE_AUTORISES = ["bench_", "test_"];

/** Découpe `mongodb://h:p/base?opts` sans dépendre d'un parseur d'URL. */
function decomposer(uri) {
  const brut = String(uri || "").trim();

  if (!/^mongodb(\+srv)?:\/\//i.test(brut)) {
    return { valide: false, raison: "ce n'est pas une URI MongoDB" };
  }

  const sansSchema = brut.replace(/^mongodb(\+srv)?:\/\//i, "");
  const sansAuth = sansSchema.includes("@")
    ? sansSchema.slice(sansSchema.lastIndexOf("@") + 1)
    : sansSchema;

  const [autorite, ...reste] = sansAuth.split("/");
  const cheminEtOpts = reste.join("/");
  const base = cheminEtOpts.split("?")[0];

  // `h1:p1,h2:p2` — un jeu de réplicas énumère ses membres.
  const hotes = autorite.split(",").map((h) => {
    const sansPort = h.replace(/:\d+$/, "");
    return sansPort.replace(/^\[|\]$/g, "");
  });

  return { valide: true, hotes, base };
}

/**
 * Refuse — en levant — toute cible qui n'est pas le banc.
 *
 * Ne rend rien d'utile : son seul effet est de laisser passer, ou d'arrêter.
 */
function exigerBanc(uri, nomVariable) {
  if (!uri) {
    throw new Error(
      `[banc] ${nomVariable} est ABSENTE. Une variable absente n'est pas ` +
        `une cible sûre : la bibliothèque de configuration comblerait le vide ` +
        `avec le .env du dépôt, qui pointe ailleurs. Refus.`
    );
  }

  const { valide, raison, hotes, base } = decomposer(uri);

  if (!valide) {
    throw new Error(`[banc] ${nomVariable} : ${raison}. Refus.`);
  }

  const interdits = hotes.filter((h) => !HOTES_AUTORISES.has(h));
  if (interdits.length) {
    throw new Error(
      `[banc] ${nomVariable} vise ${interdits.join(", ")} — hors allowlist ` +
        `(${[...HOTES_AUTORISES].join(", ")}). Refus.`
    );
  }

  if (!base) {
    throw new Error(
      `[banc] ${nomVariable} ne nomme aucune base. Sans nom de base, le ` +
        `second verrou ne peut pas s'appliquer. Refus.`
    );
  }

  if (!PREFIXES_BASE_AUTORISES.some((p) => base.startsWith(p))) {
    throw new Error(
      `[banc] ${nomVariable} vise la base « ${base} » — attendu un préfixe ` +
        `${PREFIXES_BASE_AUTORISES.join(" ou ")}. Un hôte local ne prouve ` +
        `rien : un tunnel expose Atlas sur localhost. Refus.`
    );
  }

  return { hotes, base };
}

module.exports = {
  HOTES_AUTORISES,
  PREFIXES_BASE_AUTORISES,
  decomposer,
  exigerBanc,
};
