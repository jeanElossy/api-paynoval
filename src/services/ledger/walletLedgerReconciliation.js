"use strict";

/**
 * ============================================================================
 * LE PORTEFEUILLE CONFRONTÉ AU GRAND LIVRE — CŒUR PUR
 * ============================================================================
 *
 * CE QUI MANQUAIT
 * ---------------
 * Deux contrôles existaient, et aucun ne posait cette question-ci :
 *
 *   • `checkWalletBalances` (reconciliation/transactionReconciliationService.js)
 *     vérifie qu'un portefeuille est cohérent AVEC LUI-MÊME :
 *     `amount = availableAmount + reservedAmount`.
 *
 *   • `computeTrialBalance` (ledger/doubleEntry.js) vérifie que le grand livre
 *     est équilibré AVEC LUI-MÊME : `Σ DEBIT = Σ CREDIT`, par devise.
 *
 * Un solde qui aurait dérivé du cumul de ses écritures **tout en restant
 * cohérent avec lui-même** passe les deux. Le grand livre serait équilibré, le
 * portefeuille serait cohérent, et le solde serait faux.
 *
 * C'est le contrôle qui découle le plus directement de l'invariant 2 :
 *
 *     « Le grand livre fait foi pour l'état financier. Le solde d'un
 *       portefeuille est une projection, jamais la référence. »
 *
 * Une projection qui n'est jamais comparée à sa source n'est pas une
 * projection : c'est une seconde vérité.
 *
 * ═══ CE QUE LE CUMUL REPRODUIT — ÉTABLI EN LISANT LE CODE ════════════════
 *
 * La question n'est pas rhétorique : le portefeuille porte TROIS champs
 * (`amount`, `reservedAmount`, `availableAmount`) et se tromper de cible rend
 * le contrôle pire qu'inexistant. La réponse se lit en mettant côte à côte
 * chaque primitive de `models/TxWalletBalance.js` et l'écriture que
 * `services/ledgerService.js` pose au même moment :
 *
 *  ┌──────────────────────┬────────┬───────────┬──────────┬─────────────────────────────┐
 *  │ primitive            │ Δamount│ Δavailable│ Δreserved│ jambes du grand livre       │
 *  ├──────────────────────┼────────┼───────────┼──────────┼─────────────────────────────┤
 *  │ credit()             │  +n    │   +n      │    0     │ CREDIT user_wallet   n      │
 *  │ debit()              │  −n    │   −n      │    0     │ DEBIT  user_wallet   n      │
 *  │ reserve()            │   0    │   −n      │   +n     │ DEBIT  user_wallet   n      │
 *  │                      │        │           │          │ CREDIT system_reserve n     │
 *  │ releaseReserve()     │   0    │   +n      │   −n     │ DEBIT  system_reserve n     │
 *  │                      │        │           │          │ CREDIT user_wallet   n      │
 *  │ captureReserve()     │  −n    │    0      │   −n     │ DEBIT  system_reserve n     │
 *  │                      │        │           │          │ CREDIT system_clearing n    │
 *  └──────────────────────┴────────┴───────────┴──────────┴─────────────────────────────┘
 *
 * (`credit` → ledgerService.js:897 `creditReceiverFunds` et :994 `refundSenderFunds` ·
 *  `debit` → :944 `debitReceiverFunds` et :1288 `chargeCancellationFee` ·
 *  `reserve` → :752 · `releaseReserve` → :851 · `captureReserve` → :802.)
 *
 * Colonne par colonne, la conclusion est **nette** — ce n'est pas une hypothèse
 * de repli :
 *
 *     Σ(CREDIT − DEBIT) sur `user_wallet:<user>:<devise>`     ⟹  availableAmount
 *     Σ(CREDIT − DEBIT) sur `system_reserve:<user>:<devise>`  ⟹  reservedAmount
 *     la somme des deux                                        ⟹  amount
 *
 * Le point qui tranche est `captureReserve` : elle diminue `amount` sans poser
 * la moindre jambe sur `user_wallet`. Si le cumul du compte `user_wallet`
 * reproduisait `amount`, ce mouvement le mettrait immédiatement en défaut. Il
 * reproduit `availableAmount`, et la part gelée vit sur `system_reserve` — d'où
 * l'identité `amount = available + reserved`, qui est exactement l'invariant
 * local que `checkWalletBalances` vérifie de son côté. Les deux contrôles se
 * rejoignent sans se recouvrir : l'un dit que la somme est cohérente, l'autre
 * dit qu'elle est la BONNE.
 *
 * ⚠️ `cancelReservedWithFee` (TxWalletBalance.js:489) déplace elle aussi les
 * trois champs, mais **elle n'a aucun appelant dans le dépôt** (vérifié par
 * recherche sur l'ensemble du workspace le 2026-09-01). Elle ne peut donc pas
 * produire d'écart aujourd'hui. Le jour où on la branche, sa contrepartie
 * comptable devra poser `RESERVE_RELEASE` (part remboursée) **et**
 * `RESERVE_CAPTURE` (part de frais) pour que le tableau ci-dessus tienne.
 *
 * ═══ LES STATUTS RETENUS ═════════════════════════════════════════════════
 *
 * `LedgerEntry.status` déclare `PENDING | POSTED | REVERSED` (LedgerEntry.js:100).
 * **Vérification faite dans le code, et non supposée** : les deux seules voies
 * d'écriture du dépôt — `createLedgerEntry` (ledgerService.js:516) et
 * `postDoubleEntry` (ledgerService.js:599) — posent `status: "POSTED"` en dur,
 * et n'acceptent aucun paramètre de statut. Aucun code du dépôt n'écrit
 * `PENDING` ni `REVERSED` (recherche sur `src/` le 2026-09-01).
 *
 * Le cumul retient donc **`POSTED` seul**, pour la raison de fond :
 *   • `REVERSED` désigne une écriture annulée — la compter ferait mentir le
 *     cumul dans le sens le plus dangereux, en y remettant de l'argent retiré ;
 *   • `PENDING` désigne une écriture pas encore effective — le portefeuille ne
 *     l'a, par définition, pas encore projetée.
 *
 * Mais l'hypothèse « il n'y en a jamais » ne se transforme pas en silence : une
 * écriture d'un autre statut est **écartée du cumul ET signalée**
 * (`UNEXPECTED_ENTRY_STATUS`). Le jour où quelqu'un écrit un `REVERSED`, ce
 * contrôle le dit au lieu de changer d'avis tout seul.
 *
 * ═══ LES VERSIONS D'ÉCRITURE — POURQUOI ON NE FILTRE PAS COMME LA BALANCE ═
 *
 * `computeTrialBalance` ignore les écritures antérieures à la partie double
 * (`metadata.ledgerVersion < 2`) : elle vérifie un ÉQUILIBRE, et des écritures
 * en partie simple ne s'équilibrent pas.
 *
 * Ici, la question est différente. On cumule le NET d'un compte, et une
 * écriture en partie simple posée sur `user_wallet` a bel et bien déplacé ce
 * solde. L'ignorer fabriquerait un écart de toutes pièces. Le cumul retient
 * donc **toutes les versions par défaut**, et le rapport dit combien
 * d'écritures de chaque version il a comptées — pour qu'un écart sur un compte
 * ancien soit attribuable sans refaire le travail à la main.
 *
 * Cas concret déjà présent : `internalReferralTransferService.js` écrit ses
 * bonus de parrainage en partie simple, sans `ledgerVersion` (décision
 * documentée à sa ligne 206). Ces `CREDIT user_wallet` sont invisibles pour la
 * balance de vérification ; ils sont visibles ici, et ils DOIVENT l'être,
 * puisqu'ils ont crédité le portefeuille.
 *
 * ═══ CE CONTRÔLE NE CORRIGE RIEN, JAMAIS ═════════════════════════════════
 *
 * Il constate et il rapporte. Corriger un solde d'office reviendrait à écrire
 * de l'argent sans écriture comptable — l'inverse exact de l'invariant 2, et la
 * fin de l'auditabilité (invariant 4). Une divergence se corrige par une
 * CONTRE-ÉCRITURE (`REVERSAL` / `ADJUSTMENT`) décidée par un humain qui en a
 * compris la cause.
 *
 * ═══ PURETÉ ══════════════════════════════════════════════════════════════
 *
 * Ce module ne lit aucune base et n'ouvre aucune connexion : il reçoit un
 * portefeuille et ses écritures. C'est ce qui le rend testable dans `npm test`,
 * qui doit rester sans base. La lecture Mongo vit dans
 * `services/reconciliation/walletLedgerReconciliationService.js`.
 */

const D = require("./decimalMoney");

const {
  userWalletAccountId,
  systemReserveAccountId,
} = require("./doubleEntry");

const ANOMALIES = Object.freeze({
  /** Le disponible stocké ne vaut pas le cumul de `user_wallet`. */
  AVAILABLE_DRIFT: "WALLET_LEDGER_AVAILABLE_DRIFT",
  /** Le réservé stocké ne vaut pas le cumul de `system_reserve`. */
  RESERVED_DRIFT: "WALLET_LEDGER_RESERVED_DRIFT",
  /** Le total stocké ne vaut pas la somme des deux cumuls. */
  TOTAL_DRIFT: "WALLET_LEDGER_TOTAL_DRIFT",
  /** Un montant est illisible : le verdict est INDÉTERMINÉ, pas « OK ». */
  UNREADABLE_AMOUNT: "WALLET_LEDGER_UNREADABLE_AMOUNT",
  /** Une écriture porte un statut que ce contrôle ne sait pas interpréter. */
  UNEXPECTED_ENTRY_STATUS: "WALLET_LEDGER_UNEXPECTED_ENTRY_STATUS",
  /** Une écriture ne vise ni `user_wallet` ni `system_reserve` du portefeuille. */
  UNEXPECTED_ACCOUNT: "WALLET_LEDGER_UNEXPECTED_ACCOUNT",
});

/** Voir l'en-tête : seul `POSTED` est effectif sur la projection. */
const COUNTED_STATUSES = Object.freeze(["POSTED"]);

/**
 * Tolérance par défaut, en unités monétaires — **une chaîne, pas un flottant**.
 *
 * Un demi-centime : la même valeur que `BALANCE_EPSILON` de `doubleEntry.js`,
 * délibérément, pour que deux contrôles du même grand livre ne se contredisent
 * pas sur ce qui compte comme un écart.
 *
 * Elle ne sert PAS ici à absorber une erreur de flottant — le cumul est exact,
 * il n'y en a pas. Elle absorbe l'arrondi de représentation : `$inc` applique
 * un `Number` sur un champ `Decimal128`, et la conversion peut laisser
 * quelques décimales de queue sur un total. Un demi-centime est très en dessous
 * de toute erreur financière réelle et très au-dessus de ce résidu.
 */
const DEFAULT_TOLERANCE = "0.005";

const VERDICTS = Object.freeze({
  OK: "OK",
  DRIFT: "DRIFT",
  INDETERMINATE: "INDETERMINATE",
});

function normCurrency(v) {
  return String(v || "").trim().toUpperCase();
}

function normId(v) {
  return String(v || "").trim();
}

/**
 * Cumule le NET d'un compte : `Σ CREDIT − Σ DEBIT`, exactement.
 *
 * Le sens porte le signe (les montants du grand livre sont toujours positifs,
 * `doubleEntry.checkBalanced` le refuse autrement), donc le net se lit
 * directement comme la variation du solde projeté.
 *
 * ⚠️ FERMETURE SUR MONTANT ILLISIBLE. Un montant qu'on ne sait pas lire n'est
 * pas zéro : il est recensé dans `unreadable` et le cumul devient
 * INEXPLOITABLE. Substituer 0 transformerait une donnée corrompue en « rien ne
 * bouge », donc en portefeuille sain (règle B.2).
 */
function accumulateAccount(entries) {
  let credit = D.zero();
  let debit = D.zero();

  const unreadable = [];
  let counted = 0;

  for (const e of entries) {
    const amount = D.parseDecimal(e?.amount);

    if (amount === null) {
      unreadable.push({
        entryId: e?._id ? String(e._id) : null,
        direction: String(e?.direction || "").toUpperCase() || null,
        reason: "montant illisible",
      });
      continue;
    }

    if (String(e?.direction || "").toUpperCase() === "DEBIT") {
      debit = D.add(debit, amount);
    } else {
      credit = D.add(credit, amount);
    }

    counted += 1;
  }

  return { net: D.sub(credit, debit), credit, debit, counted, unreadable };
}

/**
 * Trie les écritures fournies par compte, en écartant — et en signalant — ce
 * qui ne doit pas entrer dans le cumul.
 */
function partitionEntries(entries, { walletAccountId, reserveAccountId, statuses }) {
  const allowed = new Set(statuses.map((s) => String(s).toUpperCase()));

  const wallet = [];
  const reserve = [];
  const skippedByStatus = [];
  const unexpectedAccount = [];
  const byVersion = Object.create(null);

  for (const e of entries) {
    const accountId = normId(e?.accountId);

    /**
     * Un statut ABSENT est lu comme `POSTED` — et c'est le seul repli de ce
     * module, assumé et borné : `LedgerEntry.status` porte `default: "POSTED"`
     * et les deux voies d'écriture le posent en dur, donc aucune écriture du
     * dépôt n'en est dépourvue. Ce repli ne couvre qu'un document antérieur au
     * champ ; le lire comme « inconnu » rendrait tout l'historique indéterminé.
     *
     * ⚠️ Un statut PRÉSENT mais non compté n'est jamais replié : il est écarté
     * et signalé. Le repli porte sur l'absence, pas sur une valeur.
     */
    const status = String(e?.status || "").toUpperCase() || "POSTED";

    const isWallet = accountId === walletAccountId;
    const isReserve = accountId === reserveAccountId;

    if (!isWallet && !isReserve) {
      unexpectedAccount.push({
        entryId: e?._id ? String(e._id) : null,
        accountId,
      });
      continue;
    }

    if (!allowed.has(status)) {
      skippedByStatus.push({
        entryId: e?._id ? String(e._id) : null,
        accountId,
        status,
      });
      continue;
    }

    const version = Number(e?.metadata?.ledgerVersion || 1);
    const versionKey = Number.isFinite(version) ? String(version) : "1";
    byVersion[versionKey] = (byVersion[versionKey] || 0) + 1;

    (isWallet ? wallet : reserve).push(e);
  }

  return { wallet, reserve, skippedByStatus, unexpectedAccount, byVersion };
}

/**
 * Confronte UN portefeuille au cumul de ses écritures.
 *
 * @param {object} params
 * @param {object} params.wallet    Document `TxWalletBalance` (lean ou non).
 * @param {Array}  params.entries   Écritures des comptes `user_wallet:` et
 *   `system_reserve:` de ce couple (utilisateur, devise). L'appelant les lit ;
 *   cette fonction ne lit rien.
 * @param {string} [params.tolerance] Tolérance décimale, en chaîne.
 * @param {string[]} [params.statuses] Statuts comptés. Défaut : `POSTED` seul.
 * @param {number} [params.minLedgerVersion] Version minimale d'écriture
 *   retenue. Défaut `0` : toutes. Voir l'en-tête — filtrer comme la balance de
 *   vérification fabriquerait des écarts.
 */
function reconcileWallet({
  wallet,
  entries = [],
  tolerance = DEFAULT_TOLERANCE,
  statuses = COUNTED_STATUSES,
  minLedgerVersion = 0,
} = {}) {
  if (!wallet) throw new Error("reconcileWallet: portefeuille requis");

  const userId = normId(wallet.user);
  const currency = normCurrency(wallet.currency);

  if (!userId) throw new Error("reconcileWallet: portefeuille sans utilisateur");
  if (!currency) throw new Error("reconcileWallet: portefeuille sans devise");

  const tol = D.parseDecimal(tolerance);
  if (tol === null) {
    throw new Error(`reconcileWallet: tolérance illisible (${tolerance})`);
  }

  const walletAccountId = userWalletAccountId(userId, currency);
  const reserveAccountId = systemReserveAccountId(userId, currency);

  const retained =
    minLedgerVersion > 0
      ? entries.filter(
          (e) => Number(e?.metadata?.ledgerVersion || 1) >= minLedgerVersion
        )
      : entries;

  const skippedByVersion = entries.length - retained.length;

  const parts = partitionEntries(retained, {
    walletAccountId,
    reserveAccountId,
    statuses,
  });

  const walletSide = accumulateAccount(parts.wallet);
  const reserveSide = accumulateAccount(parts.reserve);

  const storedAvailable = D.parseDecimal(wallet.availableAmount);
  const storedReserved = D.parseDecimal(wallet.reservedAmount);
  const storedAmount = D.parseDecimal(wallet.amount);

  const projectedAvailable = walletSide.net;
  const projectedReserved = reserveSide.net;
  const projectedAmount = D.add(projectedAvailable, projectedReserved);

  const anomalies = [];

  const identity = {
    walletId: wallet._id ? String(wallet._id) : null,
    userId,
    currency,
  };

  /* ── Montants illisibles : on refuse de conclure ───────────────────────── */

  const unreadableStored = [];
  if (storedAvailable === null) unreadableStored.push("availableAmount");
  if (storedReserved === null) unreadableStored.push("reservedAmount");
  if (storedAmount === null) unreadableStored.push("amount");

  const unreadableEntries = [...walletSide.unreadable, ...reserveSide.unreadable];

  if (unreadableStored.length || unreadableEntries.length) {
    anomalies.push({
      type: ANOMALIES.UNREADABLE_AMOUNT,
      ...identity,
      storedFields: unreadableStored,
      entryCount: unreadableEntries.length,
      entries: unreadableEntries.slice(0, 10),
      detail:
        "montant illisible — le portefeuille ne peut pas être déclaré " +
        "réconcilié : verdict INDÉTERMINÉ, pas « OK »",
    });
  }

  /* ── Signaux de contexte : statut inattendu, compte hors périmètre ─────── */

  if (parts.skippedByStatus.length) {
    const byStatus = Object.create(null);
    for (const s of parts.skippedByStatus) {
      byStatus[s.status] = (byStatus[s.status] || 0) + 1;
    }

    anomalies.push({
      type: ANOMALIES.UNEXPECTED_ENTRY_STATUS,
      ...identity,
      countedStatuses: [...statuses],
      /* Étalé dans un littéral : `Object.create(null)` sort de l'agrégation
         sans prototype, ce qui surprend tout consommateur du rapport. */
      skipped: { ...byStatus },
      detail:
        "écriture(s) d'un statut non compté — aucune voie d'écriture du dépôt " +
        "ne produit autre chose que POSTED : l'hypothèse de ce contrôle ne " +
        "tient plus et le cumul est peut-être incomplet",
    });
  }

  if (parts.unexpectedAccount.length) {
    anomalies.push({
      type: ANOMALIES.UNEXPECTED_ACCOUNT,
      ...identity,
      expectedAccounts: [walletAccountId, reserveAccountId],
      count: parts.unexpectedAccount.length,
      sample: parts.unexpectedAccount.slice(0, 10),
      detail:
        "écriture(s) fournie(s) ne visant aucun des deux comptes du " +
        "portefeuille — filtre de lecture incorrect côté appelant",
    });
  }

  /* ── Les trois comparaisons ────────────────────────────────────────────── */

  const comparisons = [
    {
      field: "availableAmount",
      account: walletAccountId,
      type: ANOMALIES.AVAILABLE_DRIFT,
      stored: storedAvailable,
      projected: projectedAvailable,
      side: walletSide,
      detail: "availableAmount ≠ Σ(CREDIT − DEBIT) sur user_wallet",
    },
    {
      field: "reservedAmount",
      account: reserveAccountId,
      type: ANOMALIES.RESERVED_DRIFT,
      stored: storedReserved,
      projected: projectedReserved,
      side: reserveSide,
      detail: "reservedAmount ≠ Σ(CREDIT − DEBIT) sur system_reserve",
    },
    {
      field: "amount",
      account: `${walletAccountId} + ${reserveAccountId}`,
      type: ANOMALIES.TOTAL_DRIFT,
      stored: storedAmount,
      projected: projectedAmount,
      side: {
        counted: walletSide.counted + reserveSide.counted,
        credit: D.add(walletSide.credit, reserveSide.credit),
        debit: D.add(walletSide.debit, reserveSide.debit),
      },
      detail: "amount ≠ cumul de user_wallet + system_reserve",
    },
  ];

  const gaps = {};

  for (const c of comparisons) {
    if (c.stored === null) {
      // Déjà signalé en UNREADABLE_AMOUNT. On ne fabrique pas un écart à
      // partir d'une valeur qu'on n'a pas su lire.
      gaps[c.field] = null;
      continue;
    }

    const gap = D.sub(c.stored, c.projected);
    gaps[c.field] = D.format(gap);

    if (!D.exceeds(gap, tol)) continue;

    anomalies.push({
      type: c.type,
      ...identity,
      field: c.field,
      account: c.account,
      /* Les chiffres exacts, en chaîne — un rapport qui dit « incohérence
         détectée » sans eux oblige à tout refaire à la main. */
      stored: D.format(c.stored),
      projected: D.format(c.projected),
      gap: D.format(gap),
      ledgerCredit: D.format(c.side.credit),
      ledgerDebit: D.format(c.side.debit),
      entriesCounted: c.side.counted,
      tolerance,
      /* Doublons numériques pour la lecture humaine — jamais pour une
         décision : la décision est prise sur les chaînes exactes ci-dessus. */
      storedNumber: D.toNumber(c.stored),
      projectedNumber: D.toNumber(c.projected),
      gapNumber: D.toNumber(gap),
      detail: c.detail,
    });
  }

  /**
   * ═══ QUAND LE CONTRÔLE NE SAIT PAS, IL LE DIT ═══════════════════════════
   *
   * Les trois signaux ci-dessous ne prouvent pas un écart — ils prouvent que
   * **les hypothèses de ce contrôle ne tiennent plus** :
   *
   *   • un montant illisible : le cumul est incomplet ;
   *   • une écriture d'un statut non compté : rien dans le dépôt n'écrit autre
   *     chose que `POSTED`, donc personne n'a jamais tranché ce qu'un
   *     `REVERSED` doit faire à la projection — l'exclure est un choix, pas une
   *     certitude ;
   *   • une écriture hors des deux comptes : le filtre de lecture est faux.
   *
   * Dans ces cas, rendre « OK » serait affirmer une conformité qu'on n'a pas
   * vérifiée — le mode de défaillance le plus cher d'un contrôle financier.
   * On rend INDÉTERMINÉ, et `healthy` est faux : quelqu'un doit regarder.
   */
  const indeterminate = anomalies.some(
    (a) =>
      a.type === ANOMALIES.UNREADABLE_AMOUNT ||
      a.type === ANOMALIES.UNEXPECTED_ENTRY_STATUS ||
      a.type === ANOMALIES.UNEXPECTED_ACCOUNT
  );

  const drifted = anomalies.some(
    (a) =>
      a.type === ANOMALIES.AVAILABLE_DRIFT ||
      a.type === ANOMALIES.RESERVED_DRIFT ||
      a.type === ANOMALIES.TOTAL_DRIFT
  );

  /**
   * Quand les deux se produisent, `DRIFT` l'emporte : un écart chiffré est plus
   * actionnable qu'un doute, et les deux restent de toute façon dans
   * `anomalies`. Aucun des deux ne vaut « sain » — `summarize().healthy` les
   * refuse l'un comme l'autre.
   */
  let verdict = VERDICTS.OK;
  if (drifted) verdict = VERDICTS.DRIFT;
  else if (indeterminate) verdict = VERDICTS.INDETERMINATE;

  return {
    ...identity,
    verdict,
    accounts: { wallet: walletAccountId, reserve: reserveAccountId },
    stored: {
      amount: storedAmount === null ? null : D.format(storedAmount),
      availableAmount: storedAvailable === null ? null : D.format(storedAvailable),
      reservedAmount: storedReserved === null ? null : D.format(storedReserved),
    },
    projected: {
      amount: D.format(projectedAmount),
      availableAmount: D.format(projectedAvailable),
      reservedAmount: D.format(projectedReserved),
    },
    gaps,
    entries: {
      supplied: entries.length,
      counted: walletSide.counted + reserveSide.counted,
      onWalletAccount: walletSide.counted,
      onReserveAccount: reserveSide.counted,
      skippedByStatus: parts.skippedByStatus.length,
      skippedByVersion,
      unexpectedAccount: parts.unexpectedAccount.length,
      unreadable: unreadableEntries.length,
      byLedgerVersion: { ...parts.byVersion },
    },
    anomalies,
  };
}

/**
 * Agrège des verdicts individuels en un rapport d'ensemble.
 *
 * `healthy` exige l'absence d'écart ET l'absence d'indétermination : un
 * portefeuille qu'on n'a pas su lire n'est pas un portefeuille sain.
 */
function summarize(results = []) {
  const anomalies = [];
  const byVerdict = { OK: 0, DRIFT: 0, INDETERMINATE: 0 };
  const byType = Object.create(null);

  let countedEntries = 0;

  for (const r of results) {
    byVerdict[r.verdict] = (byVerdict[r.verdict] || 0) + 1;
    countedEntries += r.entries?.counted || 0;

    for (const a of r.anomalies) {
      anomalies.push(a);
      byType[a.type] = (byType[a.type] || 0) + 1;
    }
  }

  return {
    healthy: byVerdict.DRIFT === 0 && byVerdict.INDETERMINATE === 0,
    checked: { wallets: results.length, ledgerEntries: countedEntries },
    byVerdict,
    byType,
    anomalies,
  };
}

module.exports = {
  ANOMALIES,
  COUNTED_STATUSES,
  DEFAULT_TOLERANCE,
  VERDICTS,
  accumulateAccount,
  partitionEntries,
  reconcileWallet,
  summarize,
};
