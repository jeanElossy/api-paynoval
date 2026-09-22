"use strict";

/**
 * ============================================================================
 * PROVISIONNEMENT D'UN COMPTE INTERNE — TX-CORE EST LE SEUL ÉCRIVAIN
 * ============================================================================
 *
 * ── Le défaut fermé le 2026-09-22 ─────────────────────────────────────────
 *
 * `txsystembalances` appartient à Tx-Core, mais le backend principal y écrivait
 * DIRECTEMENT (`services/systemTreasuryTxCoreService.js`), avec son propre
 * schéma Mongoose sur la même collection — exactement le défaut déjà fermé
 * pour `tx_wallet_balances` (voir `internalWallets.controller.js`).
 *
 * Conséquences concrètes de ce second écrivain :
 *   - deux schémas contradictoires sur les mêmes documents. Tx-Core stocke
 *     désormais les soldes en `Decimal128` ; le backend écrivait des `Number`,
 *     donc réintroduisait des flottants dans la collection tout juste migrée ;
 *   - le seed **créditait** des soldes initiaux (`REFERRAL_TREASURY_INITIAL_CAD`
 *     = 10 000 par défaut) par simple écriture de champ : de l'argent apparu
 *     sans la moindre écriture comptable.
 *
 * ── Ce que fait ce point d'entrée ─────────────────────────────────────────
 *
 * Le backend DEMANDE, Tx-Core écrit — avec le schéma du propriétaire, son index
 * unique et sa validation (invariant 12).
 *
 * ⚠️ Il ne crée qu'un compte À ZÉRO, et n'accepte AUCUN montant. Approvisionner
 * une trésorerie est un mouvement d'argent : il passe par le grand livre
 * (`scripts/postTreasuryOpeningBalances.js`), jamais par une route de
 * provisionnement.
 */

const mongoose = require("mongoose");

const logger = require("../logger");

const SYSTEM_TYPES = [
  "REFERRAL_TREASURY",
  "FEES_TREASURY",
  "OPERATIONS_TREASURY",
  "CAGNOTTE_FEES_TREASURY",
  "FX_MARGIN_TREASURY",
];

const MONEY_FIELDS = ["amount", "amounts", "balance", "balances", "credit", "initialBalances"];

function norm(v) {
  return String(v ?? "").trim();
}

async function ensureTreasury(req, res) {
  const userId = norm(req.body?.userId);
  const systemType = norm(req.body?.systemType).toUpperCase();
  const currency = norm(req.body?.currency).toUpperCase();
  const managedCurrency = norm(req.body?.managedCurrency).toUpperCase();

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return res.status(400).json({
      success: false,
      code: "INVALID_USER_ID",
      error: "Identifiant utilisateur invalide.",
    });
  }

  if (!SYSTEM_TYPES.includes(systemType)) {
    return res.status(400).json({
      success: false,
      code: "INVALID_SYSTEM_TYPE",
      error: "Type de compte interne inconnu.",
    });
  }

  if (currency.length < 3 || currency.length > 4) {
    // Aucune devise par défaut : un compte interne ouvert dans une devise que
    // l'appelant n'a pas choisie serait invisible au moteur (règle B.2).
    return res.status(400).json({
      success: false,
      code: "INVALID_CURRENCY",
      error: "Devise absente ou invalide.",
    });
  }

  const porteurDeMontant = MONEY_FIELDS.filter((f) => req.body?.[f] !== undefined);

  if (porteurDeMontant.length) {
    logger.warn("[internal/treasuries] montant REFUSÉ sur une route de provisionnement", {
      systemType,
      champs: porteurDeMontant,
      requestId: norm(req.headers["x-request-id"]),
    });

    return res.status(400).json({
      success: false,
      code: "AMOUNT_NOT_ALLOWED",
      error:
        "Cette route ne provisionne qu'un compte à zéro. Approvisionner une " +
        "trésorerie est un mouvement d'argent : il passe par le grand livre.",
    });
  }

  try {
    const { getTxConn, getUsersConn } = require("../config/db");

    const owner = await getUsersConn()
      .db.collection("users")
      .findOne(
        { _id: new mongoose.Types.ObjectId(userId) },
        { projection: { isSystem: 1, systemType: 1 } }
      );

    if (!owner) {
      return res.status(404).json({
        success: false,
        code: "USER_NOT_FOUND",
        error: "Compte introuvable : aucun compte interne ouvert.",
      });
    }

    // Le propriétaire DOIT être le compte système de ce type. Sans ce contrôle,
    // une variable d'environnement périmée rouvrirait une trésorerie orpheline,
    // le défaut corrigé le 2026-09-22 (`services/treasuryRegistry.js`).
    if (owner.isSystem !== true || norm(owner.systemType).toUpperCase() !== systemType) {
      return res.status(409).json({
        success: false,
        code: "NOT_A_SYSTEM_ACCOUNT",
        error: "Ce compte n'est pas le compte système de ce type.",
      });
    }

    const conn = getTxConn();
    const TxSystemBalance = require("../models/TxSystemBalance")(conn);

    const wallet = await TxSystemBalance.ensureSystemWallet(userId, systemType, currency, {
      allowCreate: true,
      managedCurrency: managedCurrency || undefined,
      fullName: norm(req.body?.fullName) || systemType,
      email: norm(req.body?.email).toLowerCase(),
      metadata: { source: "internal/treasuries/ensure" },
    });

    logger.info("[internal/treasuries] compte interne assuré", {
      systemType,
      currency,
      requestId: norm(req.headers["x-request-id"]),
    });

    /**
     * On rend la FORME, pas les soldes : l'appelant n'a pas à recopier chez lui
     * l'état d'un compte dont il n'est pas propriétaire. Les soldes se lisent
     * par les chemins de lecture prévus.
     */
    return res.status(200).json({
      success: true,
      treasury: {
        id: String(wallet._id),
        systemType: wallet.systemType,
        defaultCurrency: wallet.defaultCurrency,
        managedCurrency: wallet.managedCurrency,
        isActive: wallet.isActive !== false,
      },
    });
  } catch (err) {
    logger.error("[internal/treasuries] provisionnement impossible", {
      systemType,
      currency,
      error: err?.message,
      code: err?.code,
    });

    return res.status(503).json({
      success: false,
      code: "TREASURY_ENSURE_FAILED",
      error: "Provisionnement du compte interne impossible.",
    });
  }
}

module.exports = { SYSTEM_TYPES, ensureTreasury };
