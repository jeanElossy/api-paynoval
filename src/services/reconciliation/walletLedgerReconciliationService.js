"use strict";

/**
 * ============================================================================
 * PORTEFEUILLE ↔ GRAND LIVRE — LA COUCHE DE LECTURE
 * ============================================================================
 *
 * Le raisonnement comptable, la table des correspondances entre primitives de
 * portefeuille et jambes du grand livre, le choix des statuts et des versions
 * d'écriture : tout cela vit dans `../ledger/walletLedgerReconciliation.js`,
 * qui est **pur** et testé sans base.
 *
 * Ce fichier-ci ne fait qu'une chose : aller chercher les documents et les lui
 * passer. La séparation n'est pas cosmétique — c'est elle qui permet de tester
 * le cumul, la comparaison et la tolérance dans `npm test`, qui n'ouvre aucune
 * connexion.
 *
 * ═══ LECTURE SEULE, SANS EXCEPTION ═══════════════════════════════════════
 *
 * Aucune écriture, nulle part, sous aucune option. Corriger un solde d'office
 * reviendrait à créer de l'argent sans écriture comptable. Une divergence se
 * corrige par une contre-écriture décidée par un humain.
 *
 * ═══ CE QUI EST EXCLU DU BALAYAGE, ET POURQUOI ═══════════════════════════
 *
 * Les portefeuilles `isSandbox: true` sont écartés PAR DÉFAUT. Ce n'est pas du
 * confort : `services/sandboxTransaction.service.js:539` mute directement
 * `amount` et `availableAmount` du portefeuille de revue Apple et **n'écrit
 * aucune écriture comptable** (vérifié le 2026-09-01 : le fichier ne mentionne
 * ni `ledger` ni `LedgerEntry`). C'est délibéré — ce parcours n'engage aucun
 * argent réel — mais ces portefeuilles divergeraient donc systématiquement de
 * leur cumul.
 *
 * Les signaler serait crier au loup, et un contrôle qui crie au loup finit par
 * ne plus être lu. C'est exactement le raisonnement déjà tenu par
 * `transactionReconciliationService.js` avec son prédicat `NOT_SANDBOX`.
 *
 * `--include-sandbox` les réintègre pour qui veut regarder. Et le rapport dit
 * toujours combien ont été écartés : **un contrôle sauté se dit**, sinon
 * « 0 écart » se lit comme « tout va bien » alors que la question n'a pas été
 * posée.
 *
 * ═══ ✅ LA DIVERGENCE DE NORMALISATION DE DEVISE EST FERMÉE ══════════════
 *
 * Les identifiants de compte sont reconstruits À PARTIR DE LA DEVISE STOCKÉE
 * sur le portefeuille. Jusqu'au 2026-09-03 les deux côtés ne normalisaient pas
 * de la même façon : le modèle traduisait les alias (`FCFA` → `XOF`), le grand
 * livre se contentait de mettre en majuscules. Un appel portant `FCFA`
 * produisait un portefeuille en `XOF` et des écritures sur
 * `user_wallet:<user>:FCFA` — ce contrôle aurait cherché `…:XOF`, n'aurait rien
 * trouvé, et aurait rapporté une dérive de la TOTALITÉ du solde.
 *
 * Les deux délèguent désormais à `utils/currency.js` (`normalizeAccountCurrency`),
 * qui applique les alias et **lève** sur une devise vide ou illisible.
 *
 * ⚠️ Ce qui reste : des écritures ANCIENNES peuvent encore vivre sur des
 * comptes mal nommés, écrites avant le correctif. Elles se liront comme une
 * perte totale plutôt que comme un problème de nommage. Ce n'est pas un faux
 * positif — ces écritures vivent réellement sur un compte que plus personne ne
 * réconcilie — mais il faut le savoir avant de conclure à un vol.
 *
 * ═══ RIEN DE SENSIBLE NE SORT (règle B.4) ════════════════════════════════
 *
 * Le journal ne reçoit que des COMPTES et des TYPES d'écart — jamais un
 * montant, jamais un identifiant. Les chiffres vivent dans l'objet rendu, que
 * l'appelant affiche s'il en a le droit. Aucun nom, aucun courriel, aucun
 * numéro : le contrôle ne lit que `user`, `currency` et les trois montants.
 *
 * ═══ BALAYAGE TOURNANT — LA COUVERTURE EST GARANTIE, PAS LA FRAÎCHEUR ════
 *
 * Ce service est le troisième axe du planificateur depuis le 2026-09-03. Il
 * balaie des portefeuilles entiers et toutes leurs écritures : c'est lourd, et
 * on ne peut pas tout regarder à chaque tour.
 *
 * D'où `after` : le tour reprend là où le précédent s'est arrêté, et le
 * rapport dit s'il a atteint la fin (`cursor.exhausted`). L'appelant persiste
 * `cursor.lastSeen` et le repasse au tour suivant ; à la fin, il repart de
 * zéro. Une population de N portefeuilles est donc **entièrement couverte en
 * ⌈N / limit⌉ tours**, et le rapport porte de quoi le vérifier
 * (`population.matching`, `cursor.rotationCompleted`).
 *
 * ⚠️ Sans curseur persistant, la pagination par clé repart de `null` à chaque
 * exécution : le balayage rebalaie indéfiniment les `limit` plus petits `_id`
 * et le reste n'est JAMAIS vérifié. C'était le cas jusqu'au 2026-09-03 — 5 000
 * sur 20 000 portefeuilles, toujours les mêmes.
 *
 * Il s'exécute aussi à la demande par `npm run reconcile:wallet-ledger`, où
 * l'absence d'`after` et une `limit` haute donnent un balayage complet.
 */

const mongoose = require("mongoose");

const { getTxConn } = require("../../config/db");

const {
  ANOMALIES,
  COUNTED_STATUSES,
  DEFAULT_TOLERANCE,
  VERDICTS,
  reconcileWallet,
  summarize,
} = require("../ledger/walletLedgerReconciliation");

const {
  userWalletAccountId,
  systemReserveAccountId,
} = require("../ledger/doubleEntry");

let logger = console;
try {
  logger = require("../../logger");
} catch {}

/**
 * Portefeuilles traités par tour.
 *
 * Chaque tour fait DEUX requêtes, pas 2×N : une pour les portefeuilles, une
 * pour toutes leurs écritures via `accountId: { $in: [...] }` — servi par
 * l'index `accountId` de `LedgerEntry`. 200 portefeuilles = 400 identifiants de
 * compte dans le `$in`, ce qui reste très en dessous des limites du pilote.
 */
const DEFAULT_BATCH_SIZE = 200;

function model(name) {
  const conn = getTxConn();
  if (!conn.models[name]) throw new Error(`Modèle ${name} non enregistré`);
  return conn.models[name];
}

function normCurrency(v) {
  return String(v || "").trim().toUpperCase();
}

/**
 * Lit le point de reprise. **Lève** sur une valeur illisible.
 *
 * Repartir du début en silence serait le pire des deux : le balayage aurait
 * l'air de tourner et recouvrirait indéfiniment les mêmes portefeuilles — le
 * défaut exact que ce curseur ferme. Un contrôle qui ne peut pas savoir où il
 * en est doit le DIRE (règle B.2).
 */
function parseAfter(after) {
  if (after === null || after === undefined || after === "") return null;

  if (after instanceof mongoose.Types.ObjectId) return after;

  const brut = String(after).trim();
  if (!mongoose.Types.ObjectId.isValid(brut)) {
    throw new Error(
      `Point de reprise illisible pour le balayage portefeuille ↔ grand livre : ` +
        `« ${brut} ». Aucun repli n'est appliqué — repartir du début ferait ` +
        `rebalayer les mêmes portefeuilles sans que rien ne le signale.`
    );
  }
  return new mongoose.Types.ObjectId(brut);
}

/**
 * Balaie les portefeuilles et confronte chacun au cumul de ses écritures.
 *
 * @param {object}   [options]
 * @param {string}   [options.userId]        Restreint à un utilisateur.
 * @param {string}   [options.currency]      Restreint à une devise.
 * @param {number}   [options.limit]         Plafond de portefeuilles examinés.
 * @param {number}   [options.batchSize]
 * @param {string}   [options.tolerance]     Décimal en chaîne, jamais un flottant.
 * @param {string[]} [options.statuses]      Statuts comptés. Défaut : `POSTED`.
 * @param {number}   [options.minLedgerVersion] Défaut 0 — toutes les versions.
 * @param {boolean}  [options.includeSandbox]
 * @param {function} [options.onWallet]      Rappel par portefeuille, pour
 *   afficher au fil de l'eau sans garder 100 000 verdicts en mémoire.
 * @param {boolean}  [options.keepResults]   Défaut `true`. À `false`, seuls les
 *   écarts sont conservés — un balayage complet ne doit pas saturer la mémoire
 *   pour rendre des verdicts « OK » que personne ne lira.
 * @param {string|object} [options.after] Reprend le balayage APRÈS cet `_id`.
 *   C'est ce qui rend la couverture complète par rotation : sans lui, chaque
 *   exécution rebalaie les mêmes `limit` premiers portefeuilles et le reste
 *   n'est jamais vu. Un `after` illisible **lève** — repartir silencieusement
 *   du début rendrait la lacune invisible, ce qui est exactement le défaut
 *   qu'on ferme ici (règle B.2).
 */
async function reconcileWalletsAgainstLedger({
  userId = null,
  currency = null,
  limit = 5000,
  batchSize = DEFAULT_BATCH_SIZE,
  tolerance = DEFAULT_TOLERANCE,
  statuses = COUNTED_STATUSES,
  minLedgerVersion = 0,
  includeSandbox = false,
  onWallet = null,
  keepResults = true,
  after = null,
} = {}) {
  const TxWalletBalance = model("TxWalletBalance");
  const LedgerEntry = model("LedgerEntry");

  const startAfter = parseAfter(after);

  const filter = {};
  if (userId) filter.user = userId;
  if (currency) filter.currency = normCurrency(currency);
  if (!includeSandbox) filter.isSandbox = { $ne: true };

  const startedAt = Date.now();

  const kept = [];
  const drifted = [];
  const byVerdict = { OK: 0, DRIFT: 0, INDETERMINATE: 0 };
  const byType = Object.create(null);

  let scanned = 0;
  let countedEntries = 0;

  /**
   * Pagination par CLÉ, pas par `skip`.
   *
   * `skip(n)` fait parcourir puis jeter n documents à chaque tour : le coût
   * devient quadratique et un balayage de 100 000 portefeuilles s'écroule sur
   * les derniers lots. `_id > dernier vu` s'appuie sur l'index primaire et
   * coûte le même prix au premier lot qu'au millième.
   */
  let lastId = startAfter;

  /**
   * Vrai si le balayage s'est arrêté faute de portefeuilles, et non faute de
   * budget. C'est LE signal qui permet à l'appelant de savoir qu'une rotation
   * complète est terminée et qu'il peut repartir du début.
   */
  let exhausted = false;

  /* Combien de portefeuilles la restriction sandbox a écartés : un contrôle
     sauté se dit, il ne se devine pas. */
  let sandboxExcluded = 0;
  if (!includeSandbox) {
    const sandboxFilter = { isSandbox: true };
    if (userId) sandboxFilter.user = userId;
    if (currency) sandboxFilter.currency = normCurrency(currency);
    sandboxExcluded = await TxWalletBalance.countDocuments(sandboxFilter);
  }

  /**
   * Combien de portefeuilles entrent dans le filtre, EN TOUT — indépendamment
   * du curseur.
   *
   * Sans ce chiffre, « 5 000 portefeuilles vérifiés » ne veut rien dire : c'est
   * excellent sur 5 200, c'est un quart de la population sur 20 000. Le rapport
   * doit permettre de lire sa propre couverture.
   */
  const population = await TxWalletBalance.countDocuments(filter);

  while (scanned < limit) {
    const take = Math.min(batchSize, limit - scanned);

    const pageFilter = lastId ? { ...filter, _id: { $gt: lastId } } : filter;

    const wallets = await TxWalletBalance.find(pageFilter)
      .select("_id user currency amount availableAmount reservedAmount isSandbox")
      /* Tri stable sur la clé primaire : sans lui, deux tours peuvent rendre
         deux fois le même document et en sauter un autre. Un portefeuille
         sauté, c'est un écart non vu. */
      .sort({ _id: 1 })
      .limit(take)
      .lean();

    if (!wallets.length) {
      exhausted = true;
      break;
    }

    lastId = wallets[wallets.length - 1]._id;
    scanned += wallets.length;

    /** accountId → portefeuille auquel il appartient. */
    const accountIds = [];
    const ownerByAccount = new Map();

    for (const w of wallets) {
      const uid = String(w.user || "").trim();
      const cur = normCurrency(w.currency);
      if (!uid || !cur) continue;

      const walletAccount = userWalletAccountId(uid, cur);
      const reserveAccount = systemReserveAccountId(uid, cur);

      accountIds.push(walletAccount, reserveAccount);
      ownerByAccount.set(walletAccount, String(w._id));
      ownerByAccount.set(reserveAccount, String(w._id));
    }

    const entries = accountIds.length
      ? await LedgerEntry.find({ accountId: { $in: accountIds } })
          .select("_id accountId direction amount currency status metadata")
          .lean()
      : [];

    const entriesByWallet = new Map();
    for (const e of entries) {
      const owner = ownerByAccount.get(String(e.accountId || "").trim());
      if (!owner) continue;
      if (!entriesByWallet.has(owner)) entriesByWallet.set(owner, []);
      entriesByWallet.get(owner).push(e);
    }

    for (const w of wallets) {
      const result = reconcileWallet({
        wallet: w,
        entries: entriesByWallet.get(String(w._id)) || [],
        tolerance,
        statuses,
        minLedgerVersion,
      });

      byVerdict[result.verdict] = (byVerdict[result.verdict] || 0) + 1;
      countedEntries += result.entries.counted;

      for (const a of result.anomalies) {
        byType[a.type] = (byType[a.type] || 0) + 1;
      }

      if (result.verdict !== VERDICTS.OK) drifted.push(result);
      if (keepResults) kept.push(result);

      if (typeof onWallet === "function") onWallet(result);
    }

    if (wallets.length < take) {
      exhausted = true;
      break;
    }
  }

  const anomalies = drifted.flatMap((r) => r.anomalies);

  const report = {
    healthy: byVerdict.DRIFT === 0 && byVerdict.INDETERMINATE === 0,
    scope: {
      userId: userId ? String(userId) : null,
      currency: currency ? normCurrency(currency) : null,
      limit,
      tolerance,
      statuses: [...statuses],
      minLedgerVersion,
      includeSandbox,
    },
    checked: { wallets: scanned, ledgerEntries: countedEntries },

    /**
     * Où en est la rotation. `lastSeen` est ce que l'appelant doit persister et
     * repasser en `after` au tour suivant ; quand `exhausted` est vrai, la
     * population a été entièrement parcourue et le tour suivant repart de zéro.
     */
    cursor: {
      startedAfter: startAfter ? String(startAfter) : null,
      lastSeen: lastId ? String(lastId) : null,
      exhausted,
      rotationCompleted: exhausted,
    },

    /**
     * ⚠️ À LIRE AVEC `checked.wallets`. `matching` est la population entière ;
     * un balayage tournant n'en voit qu'une tranche par tour. `sweepsToCover`
     * dit combien de tours il faut pour tout voir une fois.
     */
    population: {
      matching: population,
      sweepsToCover: limit > 0 ? Math.ceil(population / limit) : null,
    },
    /* ⚠️ Se lit AVEC le nombre d'écarts : « 0 écart » sur un balayage qui a
       écarté 40 portefeuilles ne veut pas dire que ces 40 vont bien. */
    excluded: { sandboxWallets: sandboxExcluded },
    byVerdict,
    byType,
    /** Seuls les portefeuilles en écart ou indéterminés — avec leurs chiffres. */
    divergent: drifted,
    anomalies,
    results: keepResults ? kept : null,
    durationMs: Date.now() - startedAt,
  };

  /**
   * Journal : des COMPTES, jamais des montants ni des identifiants (règle B.4).
   *
   * La COUVERTURE y figure toujours. « aucun écart » sur 5 000 portefeuilles
   * d'une population de 20 000 n'est pas « tout va bien » : c'est « rien vu sur
   * le quart regardé ». Un journal qui tait sa portée ment par omission
   * (règle B.6).
   */
  if (report.healthy) {
    logger.info?.(
      exhausted
        ? "[RECONCILE][WALLET-LEDGER] aucun écart — rotation COMPLÈTE"
        : "[RECONCILE][WALLET-LEDGER] aucun écart sur la tranche balayée",
      {
        wallets: report.checked.wallets,
        population,
        sweepsToCover: report.population.sweepsToCover,
        rotationCompleted: exhausted,
        ledgerEntries: report.checked.ledgerEntries,
        sandboxExcluded,
      }
    );
  } else {
    logger.warn?.("[RECONCILE][WALLET-LEDGER] écarts détectés", {
      wallets: report.checked.wallets,
      population,
      rotationCompleted: exhausted,
      divergent: drifted.length,
      types: Object.keys(byType),
    });
  }

  return report;
}

/**
 * Un seul portefeuille. Même contrôle, même verdict, sans balayage.
 *
 * Rend `null` si le portefeuille n'existe pas — l'appelant décide si c'est une
 * anomalie ; ce service ne l'invente pas.
 */
async function reconcileOneWallet({
  userId,
  currency,
  tolerance = DEFAULT_TOLERANCE,
  statuses = COUNTED_STATUSES,
  minLedgerVersion = 0,
} = {}) {
  if (!userId) throw new Error("reconcileOneWallet: userId requis");

  const cur = normCurrency(currency);
  if (!cur) throw new Error("reconcileOneWallet: currency requise");

  const TxWalletBalance = model("TxWalletBalance");
  const LedgerEntry = model("LedgerEntry");

  const wallet = await TxWalletBalance.findOne({ user: userId, currency: cur })
    .select("_id user currency amount availableAmount reservedAmount isSandbox")
    .lean();

  if (!wallet) return null;

  const uid = String(wallet.user || "").trim();

  const entries = await LedgerEntry.find({
    accountId: {
      $in: [userWalletAccountId(uid, cur), systemReserveAccountId(uid, cur)],
    },
  })
    .select("_id accountId direction amount currency status metadata")
    .lean();

  return reconcileWallet({
    wallet,
    entries,
    tolerance,
    statuses,
    minLedgerVersion,
  });
}

module.exports = {
  ANOMALIES,
  DEFAULT_BATCH_SIZE,
  DEFAULT_TOLERANCE,
  VERDICTS,
  reconcileWalletsAgainstLedger,
  reconcileOneWallet,
  summarize,
  // Exporté pour les tests : c'est la garde qui refuse un point de reprise illisible.
  parseAfter,
};
