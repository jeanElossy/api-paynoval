"use strict";

/**
 * Audit des index au démarrage — la contrepartie observable de `autoIndex:false`.
 *
 * ── Pourquoi ce module existe ─────────────────────────────────────────────
 * Couper `autoIndex` supprime un danger (une déclaration d'index part en
 * production sans revue) mais en crée un autre : un index déclaré au schéma et
 * jamais posé par script n'existe pas, et **rien ne le dit**. La requête qui
 * comptait dessus bascule en balayage complet — elle rend le bon résultat, plus
 * lentement, sans erreur. C'est exactement la classe de défaut la plus chère :
 * celle qui se voit sur la facture avant de se voir dans les journaux.
 *
 * Ce module rétablit la symétrie : ce que le code déclare est comparé à ce que
 * la base porte, et l'écart est journalisé au démarrage, nommément.
 *
 * ── Ce qu'il ne fait pas ──────────────────────────────────────────────────
 * Il ne CRÉE rien. Jamais. Créer ici reviendrait à réintroduire `autoIndex`
 * sous un autre nom. Il ne SUPPRIME rien non plus : un index présent en base et
 * absent du code peut avoir été posé délibérément par un DBA.
 *
 * Il n'échoue jamais le démarrage : un audit indisponible ne doit pas empêcher
 * un service sain de servir. Il journalise, c'est tout.
 */

/**
 * Empreinte canonique d'un index : sa CLÉ, pas son nom.
 *
 * Deux index de même clé et d'ordre de champs identique sont le même index,
 * quel que soit leur nom — MongoDB le refuse d'ailleurs en double. Comparer
 * par nom produirait de faux écarts au moindre renommage.
 *
 * L'ordre des champs est significatif : `{a:1,b:1}` et `{b:1,a:1}` sont deux
 * index DIFFÉRENTS (un index composé ne sert que ses préfixes de gauche).
 * On ne trie donc surtout pas les entrées.
 *
 * ═══ LA CLÉ SEULE NE SUFFIT PAS — CORRIGÉ LE 2026-08-27 ══════════════════
 *
 * L'empreinte ne portait QUE la clé. Un index ordinaire sur `{startedAt:1}`
 * satisfaisait donc une déclaration d'index TTL sur `{startedAt:1}`, et
 * l'audit annonçait « déclarés et posés concordent » alors que l'expiration
 * n'existait pas : les documents ne disparaissaient jamais.
 *
 * Le défaut était exactement celui que ce module est censé empêcher — une
 * garantie affichée que la base ne porte pas. Constaté sur `reconciliation_runs`
 * du banc, où `startedAt_1` masquait `reconciliation_runs_ttl` absent.
 *
 * Trois traits changent la NATURE d'un index et entrent donc dans l'empreinte :
 * l'unicité, l'expiration, le filtre partiel. `name` et `background` n'y entrent
 * pas — ils ne changent pas ce que l'index garantit.
 *
 * ⚠️ La DURÉE du TTL est délibérément exclue. Modifier `expireAfterSeconds` se
 * fait par `collMod` sur l'index existant, pas en en créant un second : inclure
 * la valeur ferait apparaître un même index comme « manquant » ET « en trop »,
 * ce qui envoie chercher un problème d'index là où il n'y a qu'un réglage.
 *
 * @param {object} cle Spécification d'index, ex. `{ provider: 1, status: -1 }`
 * @param {object} [options] Options de l'index (schéma) ou index réel (base)
 * @returns {string} ex. `provider:1|status:-1+unique`
 */
function empreinteIndex(cle, options = null) {
  if (!cle || typeof cle !== "object") return "";

  const base = Object.entries(cle)
    .map(([champ, sens]) => `${champ}:${sens}`)
    .join("|");

  if (!base || !options || typeof options !== "object") return base;

  const traits = [];
  if (options.unique === true) traits.push("unique");
  if (options.expireAfterSeconds !== undefined && options.expireAfterSeconds !== null) {
    traits.push("ttl");
  }
  if (options.partialFilterExpression) traits.push("partiel");
  if (options.sparse === true) traits.push("sparse");

  return traits.length ? `${base}+${traits.join("+")}` : base;
}

/**
 * Index déclarés par les schémas Mongoose enregistrés sur une connexion.
 *
 * @param {object} conn Connexion Mongoose
 * @returns {Array<{modele: string, collection: string, empreintes: string[]}>}
 */
function lireIndexDeclares(conn) {
  const modeles = conn?.models || {};
  const resultat = [];

  for (const nom of Object.keys(modeles)) {
    const modele = modeles[nom];
    const schema = modele?.schema;
    if (!schema || typeof schema.indexes !== "function") continue;

    // `schema.indexes()` rend AUSSI les index déclarés en ligne (`index: true`)
    // et les `unique: true`, pas seulement les `schema.index(...)`.
    const empreintes = schema
      .indexes()
      .map(([cle, options]) => empreinteIndex(cle, options))
      .filter(Boolean);

    resultat.push({
      modele: nom,
      collection: modele?.collection?.collectionName || "",
      empreintes,
    });
  }

  return resultat;
}

/**
 * Compare déclaré et réel. **Fonction pure** — c'est elle que les tests visent,
 * sans base de données.
 *
 * @param {string[]} declares  Empreintes déclarées par le schéma
 * @param {string[]} reels     Empreintes réellement présentes en base
 * @returns {{manquants: string[], enTrop: string[]}}
 */
function comparerIndex(declares = [], reels = []) {
  const ensembleReels = new Set(reels);
  const ensembleDeclares = new Set(declares);

  return {
    // Déclaré mais absent : la requête qui comptait dessus balaye la collection.
    manquants: [...ensembleDeclares].filter((e) => !ensembleReels.has(e)),
    // Présent mais non déclaré : coût d'écriture et de stockage sans contrepartie
    // connue du code. Signalé, jamais supprimé — un DBA a pu le poser exprès.
    enTrop: [...ensembleReels].filter(
      (e) => e !== "_id:1" && !ensembleDeclares.has(e)
    ),
  };
}

/**
 * Formate le rapport. Pure, donc testable sans base ni journal.
 *
 * @param {Array<{modele: string, manquants: string[], enTrop: string[]}>} ecarts
 * @returns {string[]} lignes prêtes à journaliser
 */
function formaterRapport(ecarts = []) {
  const lignes = [];

  const avecManques = ecarts.filter((e) => e.manquants?.length);
  const avecSurplus = ecarts.filter((e) => e.enTrop?.length);

  if (!avecManques.length && !avecSurplus.length) {
    return ["[INDEX] déclarés et posés concordent."];
  }

  for (const e of avecManques) {
    lignes.push(
      `[INDEX] ⚠️  ${e.modele} : ${e.manquants.length} index DÉCLARÉ(S) MAIS ABSENT(S) — ` +
        `${e.manquants.join(", ")}. Les requêtes correspondantes balayent la collection. ` +
        `Poser avec le script d'index, en heure creuse.`
    );
  }

  for (const e of avecSurplus) {
    lignes.push(
      `[INDEX] ${e.modele} : ${e.enTrop.length} index présent(s) en base et non déclaré(s) — ` +
        `${e.enTrop.join(", ")}. Coût d'écriture sans contrepartie connue du code ; ` +
        `à confirmer avant toute suppression.`
    );
  }

  return lignes;
}

/**
 * Exécute l'audit sur une connexion. Ne lève jamais.
 *
 * @param {object} conn
 * @param {object} [opts]
 * @param {object} [opts.logger]
 * @returns {Promise<Array>} les écarts, pour les tests et les métriques
 */
async function auditerIndex(conn, { logger = null } = {}) {
  const ecarts = [];

  try {
    for (const { modele, empreintes } of lireIndexDeclares(conn)) {
      let reels = [];
      try {
        const liste = await conn.models[modele].collection.indexes();
        reels = liste.map((i) => empreinteIndex(i.key, i)).filter(Boolean);
      } catch (err) {
        // Collection absente : normal sur une base neuve, et `autoCreate:false`
        // veut dire qu'elle n'apparaîtra qu'à la première écriture. Ce n'est
        // pas un écart d'index, on ne pollue pas le rapport avec.
        continue;
      }

      const { manquants, enTrop } = comparerIndex(empreintes, reels);
      if (manquants.length || enTrop.length) {
        ecarts.push({ modele, manquants, enTrop });
      }
    }

    for (const ligne of formaterRapport(ecarts)) {
      if (ligne.includes("⚠️")) logger?.warn?.(ligne);
      else logger?.info?.(ligne);
    }
  } catch (err) {
    logger?.warn?.(`[INDEX] audit indisponible : ${err?.message || err}`);
  }

  return ecarts;
}

module.exports = {
  empreinteIndex,
  lireIndexDeclares,
  comparerIndex,
  formaterRapport,
  auditerIndex,
};
