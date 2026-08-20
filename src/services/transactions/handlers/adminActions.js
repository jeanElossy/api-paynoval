"use strict";

const createError = require("http-errors");

const {
  Transaction,
  User,
  debitReceiverFunds,
  refundSenderFunds,
  chargeCancellationFee,
  startTxSession,
  maybeSessionOpts,
  runInTransaction,
  assertTransition,
  safeCommit,
} = require("../shared/runtime");

const { sanitize, toFloat, round2, isEmailLike } = require("../shared/helpers");

const INTERNAL_FLOW = "PAYNOVAL_INTERNAL_TRANSFER";
const EXTERNAL_FLOWS = new Set([
  "MOBILEMONEY_COLLECTION_TO_PAYNOVAL",
  "PAYNOVAL_TO_MOBILEMONEY_PAYOUT",
  "BANK_TRANSFER_TO_PAYNOVAL",
  "PAYNOVAL_TO_BANK_PAYOUT",
  "CARD_TOPUP_TO_PAYNOVAL",
  "PAYNOVAL_TO_CARD_PAYOUT",
]);

function isInternalTransfer(tx) {
  return tx?.flow === INTERNAL_FLOW;
}

function isExternalFlow(tx) {
  return EXTERNAL_FLOWS.has(String(tx?.flow || ""));
}

function pickCancellationFeeInput(body = {}, tx) {
  const feeSourceAmount = round2(
    Number(
      body.cancellationFeeSourceAmount ??
        body.feeSourceAmount ??
        body.cancellationFee ??
        0
    )
  );

  const treasuryFeeAmount = round2(
    Number(
      body.treasuryFeeAmount ??
        body.cancellationTreasuryFeeAmount ??
        feeSourceAmount
    )
  );

  const senderCurrency = String(
    body.feeSourceCurrency || tx?.senderCurrencySymbol || ""
  )
    .trim()
    .toUpperCase();

  const treasuryFeeCurrency = String(
    body.treasuryFeeCurrency ||
      body.feeTreasuryCurrency ||
      tx?.pricingSnapshot?.treasuryCurrency ||
      senderCurrency
  )
    .trim()
    .toUpperCase();

  const conversionRateToTreasury = Number(
    body.conversionRateToTreasury ??
      body.feeConversionRateToTreasury ??
      0
  );

  const feeType = String(body.feeType || "fixed").trim().toLowerCase();
  const feePercent = Number(body.feePercent || 0);
  const feeId = body.feeId || null;

  return {
    feeSourceAmount: Number.isFinite(feeSourceAmount) ? feeSourceAmount : 0,
    treasuryFeeAmount: Number.isFinite(treasuryFeeAmount) ? treasuryFeeAmount : 0,
    senderCurrency,
    treasuryFeeCurrency,
    conversionRateToTreasury: Number.isFinite(conversionRateToTreasury)
      ? conversionRateToTreasury
      : 0,
    feeType: feeType === "percent" ? "percent" : "fixed",
    feePercent: Number.isFinite(feePercent) ? feePercent : 0,
    feeId,
  };
}

async function refundController(req, res, next) {
  const session = await startTxSession();

  try {
    /**
     * UNITÉ DE TRAVAIL REJOUABLE.
     *
     * ⚠️ Ce fichier DÉSTRUCTURAIT `CAN_USE_SHARED_SESSION` depuis `runtime`.
     * Or `runtime` l'expose par un accesseur, précisément pour qu'il soit évalué
     * à chaque lecture — son commentaire dit noir sur blanc « ne pas figer au
     * chargement du fichier ». Déstructurer appelle l'accesseur UNE fois et fige
     * le résultat : chargé avant la connexion, ce contrôleur de REMBOURSEMENT
     * aurait tourné sans transaction pour toujours.
     *
     * `runInTransaction` évalue la disponibilité à l'appel, et confie le rejeu
     * au pilote.
     */
    const result = await runInTransaction(session, async (activeSession) => {
      const { transactionId, reason = "Remboursement demandé" } = req.body;
      const sessOpts = maybeSessionOpts(activeSession);

      const tx = await Transaction.findById(transactionId)
        .select([
          "+reference",
          "+flow",
          "+status",
          "+sender",
          "+receiver",
          "+localAmount",
          "+localCurrencySymbol",
          "+amount",
          "+senderCurrencySymbol",
          "+beneficiaryCredited",
          "+fundsCaptured",
          "+pricingSnapshot",
        ])
        .session(sessOpts.session || null);

      if (!tx) throw createError(404, "Transaction introuvable");

      if (!isInternalTransfer(tx)) {
        throw createError(
          409,
          "Le remboursement automatique n’est supporté ici que pour les transactions internes."
        );
      }

      assertTransition(tx.status, "refunded");

      if (!tx.beneficiaryCredited || !tx.fundsCaptured) {
        throw createError(409, "Transaction non exécutable en remboursement");
      }

      const targetAmount = round2(toFloat(tx.localAmount));
      const targetCurrency = String(tx.localCurrencySymbol || "").trim().toUpperCase();
      const senderAmount = round2(toFloat(tx.amount));
      const senderCurrency = String(tx.senderCurrencySymbol || "").trim().toUpperCase();

      await debitReceiverFunds({
        transaction: tx,
        receiverId: tx.receiver,
        amount: targetAmount,
        currency: targetCurrency,
        session,
      });

      await refundSenderFunds({
        transaction: tx,
        senderId: tx.sender,
        amount: senderAmount,
        currency: senderCurrency,
        session,
      });

      let cancellationFeeResult = null;
      const feeInput = pickCancellationFeeInput(req.body, tx);

      if (
        feeInput.feeSourceAmount > 0 ||
        feeInput.treasuryFeeAmount > 0
      ) {
        cancellationFeeResult = await chargeCancellationFee({
          transaction: tx,
          senderId: tx.sender,
          senderCurrency: feeInput.senderCurrency || senderCurrency,
          feeSourceAmount: feeInput.feeSourceAmount,
          treasuryUserId: null,
          treasurySystemType: "FEES_TREASURY",
          treasuryLabel: "PayNoval Fees Treasury",
          treasuryFeeAmount: feeInput.treasuryFeeAmount,
          treasuryFeeCurrency:
            feeInput.treasuryFeeCurrency || feeInput.senderCurrency || senderCurrency,
          conversionRateToTreasury: feeInput.conversionRateToTreasury,
          feeType: feeInput.feeType,
          feePercent: feeInput.feePercent,
          feeId: feeInput.feeId,
          session,
        });
      }

      tx.status = "refunded";
      tx.refundedAt = new Date();
      tx.refundReason = sanitize(reason);
      tx.providerStatus = "REFUNDED";
      tx.reversedAt = new Date();
      tx.cancellationFeeResult = cancellationFeeResult || null;
      await tx.save(sessOpts);

      return {
        transactionId: tx._id.toString(),
        reference: tx.reference,
        flow: tx.flow,
        status: tx.status,
        providerStatus: tx.providerStatus,
        refunded: targetAmount,
        currency: targetCurrency,
        cancellationFeeResult,
      };
    });

    session.endSession();

    // Réponse écrite APRÈS la transaction, une seule fois.
    return res.json({ success: true, ...result });
  } catch (err) {
    try {
      if (session.inTransaction?.()) await session.abortTransaction();
    } catch {}
    session.endSession();
    next(err);
  }
}

/**
 * Validation manuelle d'une transaction (chemin gateway).
 *
 * ⚠️ Ce contrôleur est la **seconde porte d'entrée** vers la même opération que
 * `POST /api/v1/admin/transactions/:id/validate` du backend principal. Il était
 * nettement plus permissif : il n'interrogeait pas la machine à états et ne
 * vérifiait pas que l'argent avait bougé, si bien qu'une transaction `pending`
 * pouvait être écrite en `confirmed` alors qu'aucune écriture comptable ne
 * venait en face. Le client voyait un paiement réussi, le grand livre disait le
 * contraire.
 *
 * Les deux gardes ci-dessous rétablissent la symétrie avec l'autre chemin et
 * avec `refundController`, qui applique déjà exactement le même contrôle de
 * mouvement de fonds.
 */
async function validateController(req, res, next) {
  try {
    const { transactionId, status, adminNote } = req.body;

    const tx = await Transaction.findById(transactionId);
    if (!tx) throw createError(404, "Transaction introuvable");

    if (tx.status !== "pending" && tx.status !== "pending_review") {
      throw createError(400, "Transaction non validable");
    }

    const normalizedInput = String(status || "").toLowerCase();
    if (!["confirmed", "rejected", "pending_review"].includes(normalizedInput)) {
      throw createError(400, "Statut de validation invalide");
    }

    const normalized = normalizedInput === "rejected" ? "failed" : normalizedInput;

    if (isExternalFlow(tx) && normalized === "confirmed") {
      throw createError(
        409,
        "Un flow externe ne doit pas être confirmé manuellement sans exécution provider."
      );
    }

    // La machine à états est la seule autorité sur les transitions : la
    // court-circuiter ici produirait un état que le reste de la chaîne
    // considère comme impossible.
    assertTransition(tx.status, normalized);

    /* On ne déclare pas un succès que la comptabilité ne porte pas. Ces
       drapeaux sont posés lors du mouvement réel ; absents, l'argent n'a pas
       bougé. Même garde que `refundController` ci-dessus. */
    if (normalized === "confirmed" && (!tx.fundsCaptured || !tx.beneficiaryCredited)) {
      throw createError(
        409,
        "Confirmation refusée : les fonds n'ont pas été capturés ni le bénéficiaire crédité. " +
          "Marquer cette transaction « confirmée » afficherait au client un paiement inexistant.",
        { code: "FUNDS_NOT_SETTLED" }
      );
    }

    tx.status = normalized;
    tx.validatedAt = new Date();
    tx.adminNote = adminNote || null;
    tx.providerStatus = `ADMIN_${normalized.toUpperCase()}`;
    await tx.save();

    return res.json({
      success: true,
      transactionId: tx._id.toString(),
      status: tx.status,
      providerStatus: tx.providerStatus,
    });
  } catch (err) {
    next(err);
  }
}

async function reassignController(req, res, next) {
  const session = await startTxSession();

  try {
    // Même unité de travail rejouable que ci-dessus.
    const result = await runInTransaction(session, async (activeSession) => {
      const { transactionId, newReceiverEmail } = req.body;
      const sessOpts = maybeSessionOpts(activeSession);

      const tx = await Transaction.findById(transactionId).session(sessOpts.session || null);

      if (!tx) throw createError(404, "Transaction introuvable");

      if (!isInternalTransfer(tx)) {
        throw createError(409, "La réassignation n’est supportée que pour le flow interne.");
      }

      /**
       * ⚠️ CORRECTIF. `confirmed` figurait dans cette liste. Réassigner une
       * transaction confirmée réécrivait `tx.receiver` alors que
       * `creditReceiverFunds` avait DÉJÀ crédité le destinataire d'origine, et
       * sans produire la moindre écriture comptable en face.
       *
       * Résultat : l'argent restait chez l'ancien destinataire, le document
       * désignait le nouveau, et le grand livre contredisait définitivement la
       * transaction — une divergence qu'aucune réconciliation ne peut trancher,
       * puisque les deux sources sont « valides » de leur point de vue.
       *
       * Changer de bénéficiaire après règlement, c'est un remboursement suivi
       * d'un nouveau virement. `refundController` existe pour cela.
       */
      if (!["pending", "pending_review"].includes(tx.status)) {
        throw createError(
          400,
          "Seule une transaction en attente est réassignable. Après règlement, utiliser un remboursement puis un nouveau virement."
        );
      }

      if (tx.fundsCaptured || tx.beneficiaryCredited) {
        throw createError(
          409,
          "Les fonds ont déjà été crédités au destinataire actuel : réassignation impossible."
        );
      }

      const cleanNewEmail = String(newReceiverEmail || "").trim().toLowerCase();
      if (!isEmailLike(cleanNewEmail)) {
        throw createError(400, "Email destinataire invalide");
      }

      const newReceiver = await User.findOne({ email: cleanNewEmail })
        .select("_id fullName email")
        .session(sessOpts.session || null);

      if (!newReceiver) throw createError(404, "Nouveau destinataire introuvable");
      if (String(newReceiver._id) === String(tx.receiver)) {
        throw createError(400, "Déjà affectée à ce destinataire");
      }

      tx.receiver = newReceiver._id;
      tx.nameDestinataire = newReceiver.fullName;
      tx.recipientEmail = newReceiver.email;
      tx.reassignedAt = new Date();
      tx.providerStatus = "REASSIGNED";
      await tx.save(sessOpts);

      return {
        transactionId: tx._id.toString(),
        newReceiver: {
          id: newReceiver._id,
          email: newReceiver.email,
        },
      };
    });

    session.endSession();

    return res.json({ success: true, ...result });
  } catch (err) {
    try {
      if (session.inTransaction?.()) await session.abortTransaction();
    } catch {}
    session.endSession();
    next(err);
  }
}

async function archiveController(req, res, next) {
  try {
    const { transactionId } = req.body;

    const tx = await Transaction.findById(transactionId);
    if (!tx) throw createError(404, "Transaction non trouvée");
    if (tx.archived) throw createError(400, "Déjà archivée");

    tx.archived = true;
    tx.archivedAt = new Date();
    tx.archivedBy = req.user?.email || req.user?.id || null;
    tx.providerStatus = tx.providerStatus || "ARCHIVED";
    await tx.save();

    return res.json({
      success: true,
      transactionId: tx._id.toString(),
      archived: true,
    });
  } catch (err) {
    next(err);
  }
}

async function relaunchController(req, res, next) {
  try {
    const { transactionId } = req.body;

    const tx = await Transaction.findById(transactionId);
    if (!tx) throw createError(404, "Transaction non trouvée");

    if (!["pending", "cancelled", "locked", "failed"].includes(tx.status)) {
      throw createError(
        400,
        "Seules les transactions pending/cancelled/locked/failed peuvent être relancées"
      );
    }

    /**
     * ⚠️ CORRECTIF. Ce contrôleur écrivait `tx.status = "relaunch"` en direct,
     * sans jamais interroger la machine à états — alors que `ALLOWED` ne
     * déclarait `pending → relaunch` ni `locked → relaunch`. Deux transitions
     * s'effectuaient donc en production que le reste de la chaîne tient pour
     * impossibles.
     *
     * Les transitions manquantes ont été ajoutées explicitement dans
     * `transactionStateMachine.js` : ce sont des opérations d'administration
     * délibérées, il faut donc qu'elles soient AUTORISÉES, pas contournées.
     * `assertTransition` redevient la seule autorité.
     */
    assertTransition(tx.status, "relaunch");

    /**
     * Une transaction dont l'argent a bougé ne se relance pas : elle se
     * rembourse. Sans cette garde, `relaunch` rouvrait un chemin de
     * confirmation sur une transaction déjà réglée.
     */
    if (tx.fundsCaptured || tx.beneficiaryCredited) {
      throw createError(
        409,
        "Transaction déjà exécutée : elle ne peut pas être relancée, seulement remboursée."
      );
    }

    tx.status = "relaunch";
    tx.relaunchedAt = new Date();
    tx.relaunchedBy = req.user?.email || req.user?.id || null;
    tx.relaunchCount = (tx.relaunchCount || 0) + 1;
    tx.providerStatus = "RELAUNCH_REQUESTED";

    /**
     * Relancer une transaction `locked` sans purger le compteur ne la
     * déverrouillait pas : `attemptCount` restait au plafond, si bien que la
     * première réponse erronée re-verrouillait aussitôt. Le destinataire
     * n'avait qu'un seul essai, là où la relance est censée lui en rendre.
     */
    tx.attemptCount = 0;
    tx.lastAttemptAt = null;
    tx.lockedUntil = null;

    await tx.save();

    return res.json({
      success: true,
      transactionId: tx._id.toString(),
      relaunched: true,
      status: tx.status,
      providerStatus: tx.providerStatus,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  refundController,
  validateController,
  reassignController,
  archiveController,
  relaunchController,
};