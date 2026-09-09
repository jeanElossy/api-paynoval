"use strict";

/**
 * ============================================================================
 * PARTIE DOUBLE — LE CŒUR VÉRIFIABLE
 * ============================================================================
 *
 * CE QUI EXISTAIT, ET POURQUOI ÇA NE SUFFISAIT PAS
 * ------------------------------------------------
 * Chaque primitive de `ledgerService.js` écrivait UNE ligne :
 *
 *     reserveSenderFunds() → DEBIT user_wallet:<id>:XOF  10 000
 *                            (et rien d'autre)
 *
 * `SYSTEM_CLEARING` et `SYSTEM_RESERVE` étaient DÉCLARÉS dans l'énumération de
 * `LedgerEntry` et jamais écrits : la contrepartie avait été prévue, puis jamais
 * implémentée.
 *
 * La conséquence est structurelle, pas cosmétique. Un grand livre à partie
 * double possède un invariant vérifiable en une requête :
 *
 *     Σ(DEBIT) − Σ(CREDIT) = 0
 *
 * C'est la balance de vérification. Elle attrape **tout** : une écriture perdue,
 * une écriture en double, un montant erroné. C'est le seul contrôle qui n'a pas
 * besoin de connaître le bogue à l'avance.
 *
 * En partie simple, cet invariant n'existe pas. La réconciliation compense en
 * vérifiant six invariants ÉNUMÉRÉS À LA MAIN — elle n'attrape donc que les
 * défauts déjà imaginés. C'est précisément la limite que son propre en-tête
 * reconnaît : « elle cherche les incohérences qu'on n'a pas prévues ». Sans
 * partie double, elle ne les cherche qu'à moitié.
 *
 * ═══ L'ÉQUILIBRE EST PAR DEVISE, ET CE N'EST PAS UN DÉTAIL ═══════════════
 *
 * Un virement PayNoval peut convertir : l'expéditeur débite des XOF, la
 * trésorerie encaisse sa marge en CAD. Exiger `Σ DEBIT = Σ CREDIT` toutes
 * devises confondues n'aurait aucun sens — on additionnerait des francs CFA et
 * des dollars canadiens.
 *
 * La règle appliquée ici est celle de tous les grands livres multidevises :
 *
 *     l'équilibre est vérifié PAR DEVISE, jamais globalement.
 *
 * Une conversion apparaît alors comme un déséquilibre entre deux devises sur le
 * compte de compensation — et ce déséquilibre EST la position de change. Ce
 * n'est pas un défaut du modèle, c'est l'information qu'on veut : elle devient
 * mesurable au lieu d'être invisible.
 *
 * ═══ LE MODÈLE DE COMPTES ════════════════════════════════════════════════
 *
 * Quatre familles, dont deux enfin utilisées :
 *
 *   USER_WALLET     le solde disponible d'un utilisateur
 *   SYSTEM_RESERVE  fonds gelés pour une transaction en cours
 *   SYSTEM_CLEARING fonds en transit, entre le débit et le crédit final
 *   TREASURY        les cinq trésoreries système
 *
 * Le cycle d'un virement interne de 10 000 XOF avec 200 de frais :
 *
 *   1. réservation   DEBIT  user_A       10 000   CREDIT system_reserve  10 000
 *   2. capture       DEBIT  system_reserve 10 000 CREDIT system_clearing 10 000
 *   3. crédit        DEBIT  system_clearing 9 800 CREDIT user_B           9 800
 *   4. frais         DEBIT  system_clearing   200 CREDIT fees_treasury      200
 *
 *   Σ DEBIT = 30 000   Σ CREDIT = 30 000   ✓
 *
 * Chaque étape est équilibrée SEULE, ce qui compte autant que le total : une
 * transaction interrompue au milieu reste vérifiable.
 *
 * ═══ POURQUOI UNE VERSION D'ÉCRITURE ═════════════════════════════════════
 *
 * Les écritures antérieures à cette bascule sont en partie simple : les inclure
 * dans une balance de vérification la ferait échouer sur tout l'historique, et
 * le contrôle serait désactivé dans la semaine.
 *
 * `metadata.ledgerVersion = 2` marque les écritures équilibrées. La balance ne
 * porte que sur elles. **On ne réécrit aucune écriture existante** — c'est la
 * règle du grand livre, et elle vaut aussi pour une migration.
 */

/** Version des écritures produites par ce module. */
const LEDGER_VERSION = 2;

const ACCOUNT_TYPES = Object.freeze([
  "USER_WALLET",
  "TREASURY",
  "SYSTEM_CLEARING",
  "SYSTEM_RESERVE",
]);

const DIRECTIONS = Object.freeze(["DEBIT", "CREDIT"]);

/**
 * Tolérance d'arrondi, en unités monétaires.
 *
 * Les montants sont arrondis par `roundMoney()` avant d'arriver ici, donc
 * l'écart devrait être nul. Mais comparer des flottants avec `===` est une
 * faute connue : `0.1 + 0.2 !== 0.3`. Un demi-centime est très en dessous de
 * toute erreur réelle et très au-dessus de toute erreur de représentation.
 */
const BALANCE_EPSILON = 0.005;

/* -------------------------------------------------------------------------- */
/* Identifiants de comptes                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Devise d'un IDENTIFIANT DE COMPTE — stricte, avec alias.
 * ============================================================================
 *
 * Jusqu'au 2026-09-03, ce module normalisait par un simple `toUpperCase()`
 * tandis que `ledgerService.js` passait par `normalizeAccountCurrency`, qui
 * connaît les alias. Deux implémentations, deux résultats :
 *
 *     "FCFA" →  user_wallet:<id>:FCFA   (ici)
 *     "FCFA" →  user_wallet:<id>:XOF    (ledgerService)
 *
 * Soit exactement « deux comptes pour un seul argent », le défaut que
 * `utils/currency.js:81-85` raconte avoir déjà coûté cher. Le chemin de
 * production était sauf — `ledgerService` normalise avant d'appeler ces
 * constructeurs — mais la version exportée d'ici restait un piège armé pour
 * quiconque l'appellerait directement.
 *
 * Une convention d'identifiant de compte est la clé de jointure entre le grand
 * livre et sa projection : elle ne peut pas avoir deux implémentations.
 *
 * ⚠️ Cette fonction LÈVE sur une devise absente ou illisible. C'est voulu
 * (règle B.2) : un repli ferait porter l'écriture au mauvais compte sans
 * qu'aucune erreur ne le signale.
 */
const { normalizeAccountCurrency } = require("../../utils/currency");

function normCurrency(c) {
  return normalizeAccountCurrency(c);
}

/**
 * Devise pour un CUMUL DE LECTURE — tolérante, et qui SIGNALE.
 *
 * `summarizeLegs` relit des données déjà écrites : y lever transformerait le
 * contrôle en panne. On tolère donc, mais on compte — voir `summarizeLegs`.
 */
function normCurrencyLecture(c) {
  const brut = String(c || "").trim().toUpperCase();
  if (!brut) return "?";
  try {
    return normalizeAccountCurrency(brut);
  } catch {
    return brut;
  }
}

function normId(v) {
  return String(v || "").trim();
}

/** Solde disponible d'un utilisateur. Convention historique, inchangée. */
function userWalletAccountId(userId, currency) {
  return `user_wallet:${normId(userId)}:${normCurrency(currency)}`;
}

/**
 * Fonds gelés POUR UN UTILISATEUR DONNÉ.
 *
 * L'identifiant porte l'utilisateur : un compte de réserve global empêcherait de
 * répondre à « de qui sont ces fonds gelés ? », qui est exactement la question
 * posée quand une réserve reste bloquée.
 */
function systemReserveAccountId(userId, currency) {
  return `system_reserve:${normId(userId)}:${normCurrency(currency)}`;
}

/**
 * Fonds en transit, par devise.
 *
 * PAS d'identifiant d'utilisateur ici, et c'est délibéré : la compensation est
 * un compte collectif. Son solde par devise est une mesure utile — s'il dérive
 * durablement de zéro, des fonds sont restés en transit.
 */
function systemClearingAccountId(currency) {
  return `system_clearing:${normCurrency(currency)}`;
}

function treasuryAccountId({ treasuryUserId, treasurySystemType, currency }) {
  return `treasury:${String(treasurySystemType || "").trim().toUpperCase()}:${normId(
    treasuryUserId
  )}:${normCurrency(currency)}`;
}

/* -------------------------------------------------------------------------- */
/* Vérification de l'équilibre                                                */
/* -------------------------------------------------------------------------- */

/**
 * Somme les jambes par devise et par sens.
 *
 * Fonction **pure**, et c'est la pièce à tester en priorité : c'est elle qui
 * décide si une écriture part en base.
 *
 * @param {Array} legs
 * @returns {Map<string, { debit: number, credit: number, delta: number }>}
 */
/**
 * Cumule les jambes par devise — ET COMPTE CE QU'ELLE NE SAIT PAS LIRE.
 * ============================================================================
 *
 * ⚠️ Deux replis silencieux existaient ici jusqu'au 2026-09-03 :
 *
 *   1. `Number(leg?.amount || 0)` — un montant illisible comptait pour **zéro** ;
 *   2. `else { bucket.credit += … }` — tout sens différent de `"DEBIT"`, y
 *      compris un sens absent ou corrompu, comptait pour un **crédit**.
 *
 * Sur le chemin d'ÉCRITURE, c'était sans conséquence : `checkBalanced` valide
 * en amont. Mais `computeTrialBalance` appelle cette fonction **sans aucune
 * validation**, sur des données relues depuis la base — et c'est précisément le
 * contrôle que le §3 de `ledger.md` désigne comme « le filet » contre une
 * écriture de masse qui aurait contourné les gardes du modèle.
 *
 * Autrement dit : le filet avait des mailles exactement là où on lui demande de
 * tenir. Une écriture corrompue par le chemin qu'il surveille pouvait être
 * absorbée en silence et laisser la balance équilibrée.
 *
 * On ne LÈVE pas — un contrôle qui tombe en panne sur une donnée douteuse ne
 * contrôle plus rien. On COMPTE, et l'appelant décide.
 *
 * @returns {{byCurrency: Map, anomalies: {montantIllisible: number, sensInconnu: number, deviseIllisible: number}}}
 */
function summarizeLegs(legs = []) {
  const byCurrency = new Map();
  const anomalies = { montantIllisible: 0, sensInconnu: 0, deviseIllisible: 0 };

  for (const leg of legs) {
    const curBrute = String(leg?.currency || "").trim();
    const cur = normCurrencyLecture(leg?.currency);
    if (!curBrute || cur === "?") anomalies.deviseIllisible += 1;

    const brut = Number(leg?.amount);
    const amount = Number.isFinite(brut) ? brut : 0;
    if (!Number.isFinite(brut)) anomalies.montantIllisible += 1;

    if (!byCurrency.has(cur)) {
      byCurrency.set(cur, { debit: 0, credit: 0, delta: 0 });
    }

    const bucket = byCurrency.get(cur);
    const sens = String(leg?.direction || "").toUpperCase();

    if (sens === "DEBIT") {
      bucket.debit += amount;
    } else {
      if (sens !== "CREDIT") anomalies.sensInconnu += 1;
      bucket.credit += amount;
    }

    bucket.delta = bucket.debit - bucket.credit;
  }

  byCurrency.anomalies = anomalies;
  return byCurrency;
}

/**
 * Vérifie qu'un jeu de jambes est valide et équilibré par devise.
 *
 * @returns {{ ok: boolean, reason: string|null, detail: string, byCurrency: object }}
 */
function checkBalanced(legs = []) {
  if (!Array.isArray(legs) || legs.length === 0) {
    return { ok: false, reason: "empty", detail: "aucune jambe", byCurrency: {} };
  }

  /**
   * Une seule jambe ne peut pas être équilibrée — c'est exactement la partie
   * simple qu'on remplace. On refuse explicitement plutôt que de laisser
   * l'assertion d'équilibre échouer avec un message obscur.
   */
  if (legs.length < 2) {
    return {
      ok: false,
      reason: "single-leg",
      detail:
        "une écriture isolée n'est pas une écriture en partie double — " +
        "il faut au moins une contrepartie",
      byCurrency: {},
    };
  }

  for (const [i, leg] of legs.entries()) {
    if (!DIRECTIONS.includes(String(leg?.direction || "").toUpperCase())) {
      return {
        ok: false,
        reason: "bad-direction",
        detail: `jambe ${i} : sens invalide (${leg?.direction})`,
        byCurrency: {},
      };
    }

    if (!ACCOUNT_TYPES.includes(String(leg?.accountType || "").toUpperCase())) {
      return {
        ok: false,
        reason: "bad-account-type",
        detail: `jambe ${i} : type de compte invalide (${leg?.accountType})`,
        byCurrency: {},
      };
    }

    if (!normId(leg?.accountId)) {
      return {
        ok: false,
        reason: "missing-account-id",
        detail: `jambe ${i} : identifiant de compte manquant`,
        byCurrency: {},
      };
    }

    const amount = Number(leg?.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
      /**
       * Un montant négatif est refusé, et ce n'est pas de la rigidité : le SENS
       * porte déjà le signe. Autoriser les deux permettrait d'écrire un débit
       * négatif, c'est-à-dire un crédit déguisé — et la balance ne verrait rien.
       */
      return {
        ok: false,
        reason: "bad-amount",
        detail: `jambe ${i} : montant invalide (${leg?.amount}) — le sens porte le signe`,
        byCurrency: {},
      };
    }

    /**
     * ⚠️ `normCurrencyLecture`, pas `normCurrency`.
     *
     * `checkBalanced` est un VALIDATEUR : il rend un refus structuré, il ne
     * lève pas. Utiliser ici la version stricte ferait remonter une exception
     * à la place du `{ ok: false, reason: "missing-currency" }` que tout
     * l'appelant attend — la garde disparaîtrait derrière un plantage.
     *
     * Trois normalisations, trois rôles :
     *   • `normCurrency` — construction d'identifiant : LÈVE (règle B.2) ;
     *   • `normCurrencyLecture` — validation et cumul : tolère et signale ;
     *   • ici : tolère, et c'est le test explicite ci-dessous qui refuse.
     */
    if (normCurrencyLecture(leg?.currency) === "?") {
      return {
        ok: false,
        reason: "missing-currency",
        detail: `jambe ${i} : devise manquante`,
        byCurrency: {},
      };
    }
  }

  const summary = summarizeLegs(legs);
  const byCurrency = {};

  for (const [cur, b] of summary) {
    byCurrency[cur] = { debit: b.debit, credit: b.credit, delta: b.delta };
  }

  for (const [cur, b] of summary) {
    if (Math.abs(b.delta) > BALANCE_EPSILON) {
      return {
        ok: false,
        reason: "unbalanced",
        detail:
          `devise ${cur} : débits ${b.debit} ≠ crédits ${b.credit} ` +
          `(écart ${b.delta.toFixed(4)})`,
        byCurrency,
      };
    }
  }

  return { ok: true, reason: null, detail: "", byCurrency };
}

/**
 * Variante levante, pour les sites d'appel qui ne doivent jamais écrire un jeu
 * déséquilibré.
 */
function assertBalanced(legs, context = "") {
  const verdict = checkBalanced(legs);

  if (!verdict.ok) {
    const err = new Error(
      `Écriture en partie double invalide${context ? ` (${context})` : ""} : ${
        verdict.detail
      }`
    );
    err.code = "LEDGER_UNBALANCED";
    err.reason = verdict.reason;
    err.byCurrency = verdict.byCurrency;
    throw err;
  }

  return verdict;
}

/* -------------------------------------------------------------------------- */
/* Construction de jambes                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Raccourci pour le cas courant : un transfert d'un compte vers un autre, dans
 * une seule devise.
 *
 * La très grande majorité des mouvements a cette forme. Un helper dédié évite
 * de réécrire deux objets symétriques à chaque fois — et l'asymétrie est
 * précisément le genre de faute qu'on introduit en les recopiant.
 */
function transferLegs({ from, to, amount, currency }) {
  return [
    { ...from, direction: "DEBIT", amount, currency },
    { ...to, direction: "CREDIT", amount, currency },
  ];
}

/**
 * Balance de vérification d'un ensemble d'écritures déjà enregistrées.
 *
 * Pure : elle reçoit les écritures, elle ne les lit pas. Sert à la
 * réconciliation.
 *
 * ⚠️ N'AGRÈGE QUE LES ÉCRITURES `ledgerVersion >= 2`. Inclure l'historique en
 * partie simple ferait échouer le contrôle partout et il serait désactivé dans
 * la semaine.
 */
function computeTrialBalance(entries = [], { minVersion = LEDGER_VERSION } = {}) {
  const eligible = entries.filter(
    (e) => Number(e?.metadata?.ledgerVersion || 0) >= minVersion
  );

  const summary = summarizeLegs(
    eligible.map((e) => ({
      currency: e.currency,
      direction: e.direction,
      // `Decimal128` ou nombre selon la voie de lecture (`.lean()` ou non).
      amount: Number(e.amount?.toString?.() ?? e.amount ?? 0),
    }))
  );

  const byCurrency = {};
  let ecartsDansLaTolerance = true;

  for (const [cur, b] of summary) {
    byCurrency[cur] = { debit: b.debit, credit: b.credit, delta: b.delta };
    if (Math.abs(b.delta) > BALANCE_EPSILON) ecartsDansLaTolerance = false;
  }

  const anomalies = summary.anomalies || {
    montantIllisible: 0,
    sensInconnu: 0,
    deviseIllisible: 0,
  };
  const nbAnomalies =
    anomalies.montantIllisible + anomalies.sensInconnu + anomalies.deviseIllisible;

  /**
   * ⚠️ Une donnée illisible rend `balanced: false`, depuis le 2026-09-03.
   *
   * Avant, un montant illisible comptait pour 0 et un sens corrompu pour un
   * crédit : la balance pouvait rendre `balanced: true` sur des écritures
   * qu'elle n'avait pas su lire. « Je ne sais pas » n'est pas « équilibré » —
   * et c'est bien ici, dans le filet, que la distinction compte le plus.
   *
   * `ecartsDansLaTolerance` reste exposé séparément pour que l'appelant
   * distingue « les débits ne valent pas les crédits » de « je n'ai pas su
   * lire ces écritures ». Deux problèmes différents, deux actions différentes.
   */
  return {
    balanced: ecartsDansLaTolerance && nbAnomalies === 0,
    ecartsDansLaTolerance,
    anomalies,
    byCurrency,
    consideredEntries: eligible.length,
    skippedLegacyEntries: entries.length - eligible.length,
  };
}

/**
 * ============================================================================
 * CLÉ DE DÉDUPLICATION — LE FILET QUAND LA TRANSACTION MONGO N'EST PAS LÀ
 * ============================================================================
 *
 * En fonctionnement normal, le lot d'écritures part dans la même transaction
 * MongoDB que le mouvement de portefeuille : un rejeu ne peut rien dupliquer,
 * l'annulation emporte tout. Mais TX Core sait fonctionner en MODE DÉGRADÉ
 * (`canUseSharedSession() === false`, cluster sans jeu de réplicas) — et là,
 * cette protection n'existe plus. Un rejeu réseau, un redéploiement au mauvais
 * moment, et le même mouvement s'écrit deux fois : le grand livre reste
 * ÉQUILIBRÉ (les deux jambes sont doublées) donc la balance de vérification ne
 * voit rien, et pourtant le solde comptable du compte est faux du double.
 *
 * La clé rend le rejeu inoffensif : elle est DÉTERMINISTE — reconstruite à
 * l'identique par une seconde tentative du même mouvement — et l'index unique
 * partiel de `models/LedgerEntry.js` refuse alors la seconde insertion.
 *
 * `legIndex` fait partie de la clé parce que deux jambes d'un même lot peuvent
 * légitimement partager compte, sens et type : c'est le cas des frais
 * d'annulation, qui débitent puis recréditent le compte de compensation.
 *
 * ⚠️ ELLE N'EST POSÉE QUE LORSQUE L'APPELANT FOURNIT UNE PORTÉE (`dedupScope`).
 * Sans portée, pas de clé, pas de contrainte — c'est délibéré : une clé trop
 * large REFUSERAIT une opération légitime qui se répète (deux remboursements
 * partiels du même montant sur la même transaction). Un faux rejet sur le
 * chemin de l'argent est aussi grave qu'un doublon.
 */
function buildDedupKey({ transactionId, scope, legIndex }) {
  const tx = String(transactionId || "").trim();
  const sc = String(scope || "").trim();

  if (!tx || !sc) return null;
  if (!Number.isInteger(legIndex) || legIndex < 0) return null;

  return `${tx}|${sc}|${legIndex}`;
}

module.exports = {
  LEDGER_VERSION,
  BALANCE_EPSILON,
  ACCOUNT_TYPES,
  DIRECTIONS,

  userWalletAccountId,
  systemReserveAccountId,
  systemClearingAccountId,
  treasuryAccountId,

  summarizeLegs,
  checkBalanced,
  assertBalanced,
  transferLegs,
  computeTrialBalance,
  buildDedupKey,
};
