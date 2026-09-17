"use strict";

/**
 * ============================================================================
 * PROVISIONNEMENT D'UN PORTEFEUILLE — TX-CORE EST LE SEUL ÉCRIVAIN
 * ============================================================================
 *
 * ── Ce que ce point d'entrée corrige ────────────────────────────────────────
 *
 * `tx_wallet_balances` appartient à Tx-Core. Le backend principal y écrivait
 * pourtant directement, à l'inscription, via
 * `authController.ensureInitialTxWallet` — avec SON PROPRE schéma Mongoose sur
 * la même collection. Et les deux schémas se contredisent :
 *
 *   ┌──────────────────┬─────────────────────┬──────────────────────┐
 *   │ champ            │ Tx-Core (propriétaire)│ backend principal   │
 *   ├──────────────────┼─────────────────────┼──────────────────────┤
 *   │ amount           │ Decimal128, requis  │ Number, défaut 0     │
 *   │ availableAmount  │ Decimal128, requis  │ Number, défaut 0     │
 *   │ reservedAmount   │ Decimal128, requis  │ Number, défaut 0     │
 *   │ user             │ ObjectId, requis    │ Mixed                │
 *   │ {user, currency} │ index UNIQUE        │ index non unique ×4  │
 *   └──────────────────┴─────────────────────┴──────────────────────┘
 *
 * Mongoose caste selon le schéma LOCAL au moment de l'écriture. Toute écriture
 * passant par le modèle du backend stocke donc un `double` là où le moteur
 * d'argent lit un `Decimal128` — et un `double` ne représente pas 0,10
 * exactement. Sur un solde, cet écart ne se voit pas au premier centime : il se
 * voit au moment où les comptes ne tombent plus juste, des mois plus tard, sans
 * qu'aucune erreur n'ait jamais été levée.
 *
 * Le piège n'avait pas encore mordu parce que l'unique écrivain convertissait
 * explicitement en Decimal128. Autrement dit : la correction financière tenait
 * à ce que quelqu'un s'en soit souvenu. Ce n'est pas une garantie, c'est une
 * chance.
 *
 * ── Ce qui change ───────────────────────────────────────────────────────────
 *
 * Le backend demande, Tx-Core écrit — avec le schéma du propriétaire, ses
 * types, son index unique et sa validation (invariant 12).
 *
 * ⚠️ Ce point d'entrée ne crée qu'un portefeuille À ZÉRO. Il n'accepte aucun
 * montant, et ne doit jamais en accepter : créditer un portefeuille est un
 * mouvement d'argent, qui passe par le grand livre et non par une route de
 * provisionnement.
 */

const mongoose = require("mongoose");

const logger = require("../logger");

function norm(v) {
  return String(v ?? "").trim();
}

async function ensureWallet(req, res) {
  const userId = norm(req.body?.userId);
  const currency = norm(req.body?.currency).toUpperCase();

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return res.status(400).json({
      success: false,
      code: "INVALID_USER_ID",
      error: "Identifiant utilisateur invalide.",
    });
  }

  if (currency.length < 3 || currency.length > 4) {
    /**
     * ⚠️ AUCUN DÉFAUT DE DEVISE. Le modèle en déclare un (`CAD`) pour ses
     * documents existants, mais l'accepter ICI reviendrait à ouvrir un
     * portefeuille dans une devise que l'appelant n'a pas choisie — et un
     * portefeuille dans la mauvaise devise est invisible au moteur, qui filtre
     * sur `{user, currency}` (règle B.2).
     */
    return res.status(400).json({
      success: false,
      code: "INVALID_CURRENCY",
      error: "Devise absente ou invalide.",
    });
  }

  try {
    /**
     * `getTxConn` résolu À L'APPEL (même motif que `services/aml.js`).
     *
     * ⚠️ Défaut fermé le 2026-09-17 : ce fichier importait
     * `getTransactionsConnection`, qui n'a JAMAIS existé dans `config/db.js`.
     * Chaque appel levait `TypeError`, attrapé ici en `500
     * WALLET_ENSURE_FAILED` ; le backend annulait alors l'utilisateur créé.
     * Mesuré en production : AUCUNE inscription n'aboutissait depuis
     * `6feb096` (2026-09-10). Garde : `test/configDbImports.test.js`.
     */
    const { getTxConn } = require("../config/db");
    const conn = getTxConn();
    const TxWalletBalance = conn.models.TxWalletBalance;

    if (!TxWalletBalance) {
      return res.status(503).json({
        success: false,
        code: "MODEL_UNAVAILABLE",
        error: "TxWalletBalance non enregistré.",
      });
    }

    const wallet = await TxWalletBalance.ensureWallet(userId, currency);

    if (!wallet) {
      return res.status(500).json({
        success: false,
        code: "WALLET_NOT_CREATED",
        error: "Portefeuille non créé.",
      });
    }

    logger.info("[internal/wallets] portefeuille assuré", {
      userId,
      currency,
      requestId: norm(req.headers["x-request-id"]),
    });

    /**
     * On rend la FORME, pas le solde en clair d'un document que l'appelant n'a
     * pas à recopier chez lui. Le solde se lit par les chemins de lecture
     * prévus, qui appliquent les mêmes conversions.
     */
    return res.status(200).json({
      success: true,
      wallet: {
        id: String(wallet._id),
        currency: wallet.currency,
        status: wallet.status,
      },
    });
  } catch (err) {
    logger.error("[internal/wallets] échec du provisionnement", {
      userId,
      currency,
      error: err?.message,
    });

    return res.status(500).json({
      success: false,
      code: "WALLET_ENSURE_FAILED",
      error: "Provisionnement du portefeuille impossible.",
    });
  }
}

module.exports = { ensureWallet };
