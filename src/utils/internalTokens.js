"use strict";

/**
 * Comparaison des tokens internes — logique PURE.
 *
 * Extrait de `middleware/internalAuth.js` pour une raison précise : ce
 * middleware charge `../config`, donc `dotenv-safe`, donc un `.env` complet.
 * Une logique de sécurité qu'on ne peut pas tester sans configuration est une
 * logique qu'on ne teste pas. Le dépôt applique déjà ce découpage
 * (`utils/userScopeQuery.js`, extrait du contrôleur pour la même raison).
 */

const crypto = require("crypto");

/**
 * Comparaison à temps constant.
 *
 * `crypto.timingSafeEqual` exige des tampons de même longueur — on complète
 * donc par des zéros avant de comparer, puis on vérifie séparément l'égalité
 * des longueurs. Comparer d'abord les longueurs révélerait, par le temps de
 * réponse, la taille du secret attendu.
 */
function timingSafeEqualStr(a, b) {
  const aBuf = Buffer.from(String(a || ""), "utf8");
  const bBuf = Buffer.from(String(b || ""), "utf8");

  const len = Math.max(aBuf.length, bBuf.length);
  const aPadded = Buffer.concat([aBuf, Buffer.alloc(len - aBuf.length)]);
  const bPadded = Buffer.concat([bBuf, Buffer.alloc(len - bBuf.length)]);

  return crypto.timingSafeEqual(aPadded, bPadded) && aBuf.length === bBuf.length;
}

/** Lit l'en-tête, quelle qu'en soit la casse. */
function extractInternalToken(req) {
  const headers = req?.headers || {};

  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "x-internal-token") {
      return String(headers[key] || "").trim();
    }
  }

  return "";
}

/**
 * Le token présenté correspond-il à l'un des tokens attendus ?
 *
 * Renvoie `false` si aucun token n'est attendu : une configuration absente ne
 * doit jamais valoir autorisation. C'est exactement la faute qui existait sur
 * le rate-limit — présence de l'en-tête prise pour preuve de légitimité.
 */
function matchesAnyToken(presented, expectedList = []) {
  const got = String(presented || "").trim();
  if (!got) return false;

  const expected = (Array.isArray(expectedList) ? expectedList : [expectedList])
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  if (!expected.length) return false;

  return expected.some((value) => timingSafeEqualStr(got, value));
}

/**
 * ============================================================================
 * LES NOMS DE VARIABLE ADMIS POUR LE JETON INTERNE — UNE SEULE LISTE
 * ============================================================================
 *
 * ── Le défaut que cette liste referme ───────────────────────────────────────
 *
 * Trois chaînes de repli coexistaient dans Tx-Core, et elles ne se recouvraient
 * pas :
 *
 *   · `collectionRoutes` / `cagnotteExternalSettlement` :
 *       TX_CORE_INTERNAL_TOKEN → INTERNAL_TX_TOKEN → INTERNAL_TOKEN
 *   · `internalAdminTransactions.routes` :
 *       TX_CORE_INTERNAL_TOKEN → INTERNAL_API_TOKEN → PAYNOVAL_INTERNAL_TOKEN
 *
 * Or la seule variable réellement posée est `INTERNAL_TOKEN`, et c'est celle
 * que la passerelle envoie. La première chaîne la trouvait ; la seconde non.
 * Résultat mesuré le 2026-09-10 : le back-office admin — tableau de bord,
 * trésorerie, transactions, statistiques utilisateur, ajustements — rendait
 * **500 « TX_CORE_INTERNAL_TOKEN manquant »** sur chaque appel.
 *
 * Le défaut ne se voyait ni au démarrage ni dans les tests : les routes se
 * montent, le service annonce qu'il écoute, et l'erreur ne survient qu'au
 * premier appel réel — avec un message qui accuse une variable d'environnement
 * plutôt que la divergence qui l'a produit.
 *
 * ── Pourquoi l'UNION et non un ordre de priorité ────────────────────────────
 *
 * Un ordre de priorité ne referme le défaut que d'un côté : si l'exploitant
 * pose `TX_CORE_INTERNAL_TOKEN` chez Tx-Core pendant que la passerelle continue
 * d'envoyer `INTERNAL_TOKEN`, la panne revient à l'identique. L'union accepte
 * toute valeur que l'exploitant a délibérément configurée — ce sont toutes des
 * identifiants internes de sa main — et `annoncerJetonsInternes()` signale au
 * démarrage le cas où deux noms portent des valeurs DIFFÉRENTES, qui est le
 * seul vrai symptôme de mauvaise configuration.
 */
const NOMS_JETON_INTERNE = Object.freeze([
  "TX_CORE_INTERNAL_TOKEN",
  "INTERNAL_TX_TOKEN",
  "INTERNAL_API_TOKEN",
  "PAYNOVAL_INTERNAL_TOKEN",
  "INTERNAL_TOKEN",
]);

/**
 * Les valeurs attendues, dédoublonnées. Vide si rien n'est configuré — et
 * `matchesAnyToken` refuse alors tout, une configuration absente ne valant
 * jamais autorisation.
 */
function expectedInternalTokens(env = process.env) {
  const vues = new Set();

  for (const nom of NOMS_JETON_INTERNE) {
    const valeur = String(env[nom] || "").trim();
    if (valeur) vues.add(valeur);
  }

  return [...vues];
}

/**
 * Règle B.6 : le démarrage dit la vérité, avec la conséquence. Appelé une fois
 * par `server.js`.
 */
function annoncerJetonsInternes(env = process.env, log = console) {
  const poses = NOMS_JETON_INTERNE.filter((nom) =>
    String(env[nom] || "").trim()
  );

  if (!poses.length) {
    log.error?.(
      "❌ Aucun jeton interne configuré (" +
        NOMS_JETON_INTERNE.join(", ") +
        ") — CONSÉQUENCE : toutes les routes internes et admin refuseront " +
        "les appels de la passerelle et du backend."
    );
    return { poses, coherent: false };
  }

  const distinctes = expectedInternalTokens(env);

  if (distinctes.length > 1) {
    log.warn?.(
      "⚠️ Jeton interne : " +
        poses.length +
        " variables posées (" +
        poses.join(", ") +
        ") portant " +
        distinctes.length +
        " valeurs DIFFÉRENTES. Toutes sont acceptées ; c'est probablement une " +
        "erreur de configuration — la surface d'identifiants valides est " +
        "plus large que prévu."
    );
    return { poses, coherent: false };
  }

  log.info?.(
    "✅ Jeton interne configuré via : " + poses.join(", ") + " (valeur unique)."
  );

  return { poses, coherent: true };
}

module.exports = {
  timingSafeEqualStr,
  extractInternalToken,
  matchesAnyToken,
  NOMS_JETON_INTERNE,
  expectedInternalTokens,
  annoncerJetonsInternes,
};
