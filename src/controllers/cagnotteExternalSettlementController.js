"use strict";

/**
 * ============================================================================
 * RÈGLEMENT D'UNE PARTICIPATION PAR LIEN PUBLIC — LE PAYEUR N'A PAS DE COMPTE
 * ============================================================================
 *
 * Jumeau externe de `cagnotteSettlementController.js`. Même contrat, mêmes
 * garanties, UNE différence : il n'y a aucun portefeuille à débiter.
 *
 * ── Le défaut que ce contrôleur ferme (trouvé le 2026-09-09) ────────────────
 *
 * Le chemin public ne bookait rien. Le rappel prestataire
 * (`cagnotteController.externalPaymentCallback`, backend principal) créditait le
 * coffre par un `$inc: { balance: netToVault }` nu — aucun appel à TX Core,
 * aucune `LedgerEntry`. Les invariants 2 (le grand livre fait foi) et 4
 * (auditabilité) tombaient ensemble.
 *
 * C'est EXACTEMENT le défaut corrigé le 2026-09-09 sur le chemin AUTHENTIFIÉ.
 * Son jumeau externe vit 2 400 lignes plus bas dans le même contrôleur et avait
 * été manqué. La leçon vaut d'être écrite : **deux chemins qui font la même
 * chose métier doivent appeler la même primitive comptable**, sinon l'un des
 * deux dérive — et c'est toujours celui qu'on regarde le moins.
 *
 * ── Ce qu'il fait ───────────────────────────────────────────────────────────
 *
 *   DEBIT  clearing PROVIDER_INBOUND:<RAIL>   montant encaissé
 *   CREDIT clearing CAGNOTTE_VAULT            montant encaissé
 *   DEBIT  clearing CAGNOTTE_VAULT   frais            ┐ si frais
 *   CREDIT treasury CAGNOTTE_FEES    frais            ┘
 *
 * plus le crédit du portefeuille système de trésorerie, dans la même
 * transaction. La jambe de retour ne change pas : le retrait du coffre vide la
 * compensation cagnotte vers le bénéficiaire, que l'argent soit venu d'un
 * utilisateur PayNoval ou d'un inconnu. Le coffre n'a pas à savoir d'où il vient.
 *
 * ── Ce qu'il ne fait PAS ────────────────────────────────────────────────────
 *
 * Il ne vérifie aucune signature et ne parle à aucun prestataire. Il est appelé
 * APRÈS que le rappel a été authentifié — par le backend principal, sur le
 * réseau privé, jeton interne à l'appui. Poser une seconde vérification ici
 * créerait une seconde vérité sur « ce rappel est-il valable ».
 *
 * Il n'enregistre AUCUNE donnée personnelle du payeur : ni téléphone, ni nom
 * porteur, ni corps de rappel brut (règle B.4). Ce qui sert au rapprochement,
 * c'est `providerReference`.
 */

const asyncHandler = require("express-async-handler");

const { getTxConn, getUsersConn } = require("../config/db");
const buildTxSystemBalanceModel = require("../models/TxSystemBalance");
const buildCagnotteExternalSettlementModel = require("../models/CagnotteExternalSettlement");
const { runWithTransaction } = require("../utils/transactionRunner");
const { canUseSharedSession } = require("../utils/sharedSession");
const {
  settlementObjectIdFromReference,
  postCagnotteExternalParticipationEntries,
  normalizeTreasurySystemType,
  getTreasuryUserIdBySystemType,
} = require("../services/ledgerService");
const logger = require("../utils/logger");

const CAGNOTTE_TREASURY_SYSTEM_TYPE = "CAGNOTTE_FEES_TREASURY";
const CAGNOTTE_TREASURY_LABEL = "Cagnotte Fees Treasury";

/** Rails autorisés. Table CLOSE — alignée sur `CagnotteExternalSettlement`. */
const RAILS = Object.freeze({
  mobilemoney: Object.freeze(["wave", "orange", "mtn", "moov"]),
  card: Object.freeze(["visa_direct"]),
});

function normalizeCurrencyCode(raw) {
  return String(raw || "").trim().toUpperCase();
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function low(v) {
  return String(v || "").trim().toLowerCase();
}

/**
 * Crédite le portefeuille système de trésorerie. Copié sur le contrôleur
 * jumeau plutôt que factorisé : les deux fichiers doivent pouvoir diverger si
 * les règles de trésorerie divergent un jour, et une factorisation prématurée
 * entre deux chemins d'argent est un couplage qu'on regrette.
 */
async function creditTreasurySystemWallet({
  TxSystemBalance,
  treasuryUserId,
  treasurySystemType,
  treasuryLabel,
  currency,
  amount,
  session,
}) {
  const cur = normalizeCurrencyCode(currency);
  const amt = round2(amount);

  if (!(amt > 0)) return null;

  const doc = await TxSystemBalance.credit(
    treasuryUserId,
    normalizeTreasurySystemType(treasurySystemType),
    cur,
    amt,
    { session }
  );

  if (!doc) {
    throw new Error(
      `Crédit de trésorerie impossible (${treasurySystemType} / ${cur}).`
    );
  }

  return {
    walletId: String(doc._id),
    systemType: doc.systemType,
    currency: cur,
    label: treasuryLabel,
  };
}

/**
 * POST /internal/cagnottes/external-participation/settle
 *
 * Corps attendu :
 *   reference          identifiant PayNoval du règlement (unique, dérive le _id)
 *   idempotencyKey     clé du rappel
 *   rail               "mobilemoney" | "card"
 *   provider           wave | orange | mtn | moov | visa_direct
 *   providerReference  référence du prestataire (clé de rapprochement)
 *   cagnotteId         cagnotte créditée
 *   collected          { amount, currency }  ce que le participant a payé
 *   feeCredit          { amount, currency }  facultatif
 */
const settleExternalParticipation = asyncHandler(async (req, res) => {
  const txConn = getTxConn();
  const TxSystemBalance = buildTxSystemBalanceModel(txConn);
  const CagnotteExternalSettlement =
    buildCagnotteExternalSettlementModel(txConn);

  const {
    reference,
    idempotencyKey,
    rail: railBrut,
    provider: providerBrut,
    providerReference,
    cagnotteId,
    vaultId,
    collected,
    feeCredit,
    meta,
  } = req.body || {};

  const ref = String(reference || "").trim();
  const idem = String(idempotencyKey || "").trim();
  const rail = low(railBrut);
  const provider = low(providerBrut).replace(/-/g, "_");
  const cagnotte = String(cagnotteId || "").trim();

  const collectedAmount = round2(collected?.amount);
  const collectedCurrency = normalizeCurrencyCode(collected?.currency);

  const feeAmount = round2(feeCredit?.amount || 0);
  const feeCurrency = normalizeCurrencyCode(feeCredit?.currency);

  /* ── Validation : tout est FERMÉ, rien ne prend de valeur par défaut ────── */

  if (!ref || !idem || !cagnotte) {
    return res.status(400).json({
      success: false,
      error: "reference, idempotencyKey et cagnotteId sont requis.",
    });
  }

  if (!RAILS[rail]) {
    return res.status(400).json({
      success: false,
      code: "UNKNOWN_RAIL",
      error: `Rail « ${railBrut} » inconnu. Le rail décide du compte de ` +
        "compensation d'entrée, donc du relevé auquel ce règlement sera rapproché.",
      accepted: Object.keys(RAILS),
    });
  }

  if (!RAILS[rail].includes(provider)) {
    return res.status(400).json({
      success: false,
      code: "UNKNOWN_PROVIDER",
      error: `Opérateur « ${providerBrut} » inconnu sur le rail ${rail}.`,
      accepted: RAILS[rail],
    });
  }

  if (!collectedCurrency || !(collectedAmount > 0)) {
    return res.status(400).json({
      success: false,
      error: "collected.amount doit être positif et collected.currency présente.",
    });
  }

  if (feeAmount > 0 && !feeCurrency) {
    return res.status(400).json({
      success: false,
      error: "feeCredit.currency est requis dès lors que feeCredit.amount > 0.",
    });
  }

  /**
   * ⚠️ Les frais ne peuvent pas dépasser l'encaissement QUAND ILS SONT DANS LA
   * MÊME DEVISE. Dans une devise différente, la comparaison n'a aucun sens —
   * on ne compare pas des XOF à des CAD — et c'est précisément pour cela que le
   * lot « frais » est séparé du lot « débit » au grand livre.
   */
  const netToVaultAmount =
    feeAmount > 0 && feeCurrency === collectedCurrency
      ? round2(collectedAmount - feeAmount)
      : collectedAmount;

  if (netToVaultAmount <= 0) {
    return res.status(400).json({
      success: false,
      code: "FEE_EXCEEDS_COLLECTED",
      error:
        "Les frais absorbent la totalité de l'encaissement : le coffre ne " +
        "recevrait rien. Un règlement qui ne crédite pas la cagnotte n'est pas " +
        "un règlement.",
    });
  }

  let treasuryUserId = "";

  if (feeAmount > 0) {
    treasuryUserId = getTreasuryUserIdBySystemType(CAGNOTTE_TREASURY_SYSTEM_TYPE);

    if (!treasuryUserId) {
      return res.status(500).json({
        success: false,
        code: "TREASURY_UNCONFIGURED",
        error:
          "Trésorerie cagnotte non configurée (CAGNOTTE_FEES_TREASURY_USER_ID). " +
          "Des frais sans compte de destination ne s'encaissent pas « quelque part ».",
      });
    }
  }

  /**
   * ⚠️ REFUS EN FERMETURE SANS SESSION ATOMIQUE — identique au jumeau.
   *
   * `postDoubleEntry` ne transmet la session au grand livre que si
   * `canUseSharedSession()` est vrai. Sans elle, les écritures partiraient HORS
   * de la transaction qui porte le crédit de trésorerie : une annulation
   * laisserait des écritures fantômes en face d'un solde remis en état. Un
   * grand livre faux est pire qu'un grand livre absent — on lui fait confiance.
   */
  if (!canUseSharedSession(getUsersConn, getTxConn)) {
    logger.error(
      "[cagnotte][participation-externe] REFUS : session atomique indisponible",
      {
        reference: ref,
        rail,
        provider,
        consequence:
          "le grand livre s'écrirait hors transaction ; aucun mouvement n'a eu lieu",
      }
    );

    return res.status(503).json({
      success: false,
      code: "ATOMIC_SESSION_UNAVAILABLE",
      error:
        "Règlement refusé : les deux bases ne partagent pas de session Mongo, " +
        "l'écriture au grand livre et le crédit de trésorerie ne peuvent donc " +
        "pas être atomiques. Vérifier MONGO_SHARE_CLIENT.",
    });
  }

  /**
   * Identifiant DÉTERMINISTE dérivé de la référence : un rejeu réinsère le même
   * `_id` et se heurte à la clé primaire, et surtout le `dedupKey` du grand
   * livre reste stable d'une tentative à l'autre. L'idempotence ne repose donc
   * pas sur la seule disponibilité de la transaction Mongo.
   */
  const settlementId = settlementObjectIdFromReference(
    ref,
    "cagnotte.participation.external"
  );

  const existing = await CagnotteExternalSettlement.findOne({
    reference: ref,
  }).lean();

  if (existing) {
    return res.status(200).json({
      success: true,
      alreadyProcessed: true,
      data: existing,
    });
  }

  const result = await (async () => {
    const session = await txConn.startSession();

    try {
      return await runWithTransaction(session, async () => {
        const dejaLa = await CagnotteExternalSettlement.findOne({
          reference: ref,
        }).session(session);

        if (dejaLa) {
          return {
            statusCode: 200,
            body: {
              success: true,
              alreadyProcessed: true,
              data: dejaLa.toObject ? dejaLa.toObject() : dejaLa,
            },
          };
        }

        let treasuryWalletAfter = null;

        if (feeAmount > 0) {
          treasuryWalletAfter = await creditTreasurySystemWallet({
            TxSystemBalance,
            treasuryUserId,
            treasurySystemType: CAGNOTTE_TREASURY_SYSTEM_TYPE,
            treasuryLabel: CAGNOTTE_TREASURY_LABEL,
            currency: feeCurrency,
            amount: feeAmount,
            session,
          });
        }

        const docs = await CagnotteExternalSettlement.create(
          [
            {
              _id: settlementId,
              reference: ref,
              idempotencyKey: idem,
              rail,
              provider,
              providerReference: String(providerReference || "").trim(),
              cagnotteId: cagnotte,
              vaultId: String(vaultId || "").trim(),
              collected: {
                amount: collectedAmount,
                currency: collectedCurrency,
              },
              feeCredit: {
                amount: feeAmount,
                currency: feeAmount > 0 ? feeCurrency : "",
              },
              netToVault: {
                amount: netToVaultAmount,
                currency: collectedCurrency,
              },
              treasuryUserId: feeAmount > 0 ? treasuryUserId : "",
              treasurySystemType:
                feeAmount > 0 ? CAGNOTTE_TREASURY_SYSTEM_TYPE : "",
              treasuryLabel: feeAmount > 0 ? CAGNOTTE_TREASURY_LABEL : "",
              status: "confirmed",
              treasuryWalletAfter,
              meta: {
                ...(meta && typeof meta === "object" ? meta : {}),
                settlementKind: "cagnotte_external_participation_settlement",
              },
            },
          ],
          { session }
        );

        const settlement = docs[0];

        /**
         * ⚠️ LE GRAND LIVRE, DANS LA MÊME TRANSACTION.
         *
         * C'est la ligne qui manquait au chemin public. Poser l'écriture après
         * la transaction ne vaudrait pas mieux : un échec entre les deux
         * laisserait la trésorerie créditée sans contrepartie comptable.
         */
        await postCagnotteExternalParticipationEntries({
          settlementId: settlement._id,
          reference: ref,
          rail,
          amount: collectedAmount,
          currency: collectedCurrency,
          feeCredit:
            feeAmount > 0
              ? {
                  treasuryUserId,
                  treasurySystemType: CAGNOTTE_TREASURY_SYSTEM_TYPE,
                  amount: feeAmount,
                  currency: feeCurrency,
                }
              : null,
          metadata: {
            settlementKind: "cagnotte_external_participation_settlement",
            cagnotteId: cagnotte,
            vaultId: String(vaultId || "").trim() || null,
            provider,
            providerReference: String(providerReference || "").trim() || null,
          },
          session,
        });

        return {
          statusCode: 201,
          body: {
            success: true,
            data: settlement.toObject ? settlement.toObject() : settlement,
          },
        };
      });
    } finally {
      try {
        session.endSession();
      } catch {}
    }
  })();

  return res.status(result.statusCode).json(result.body);
});

module.exports = {
  settleExternalParticipation,
  RAILS,
};
