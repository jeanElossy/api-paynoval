"use strict";

/**
 * ============================================================================
 * INITIER UN ENCAISSEMENT — POINT D'ENTRÉE HTTP
 * ============================================================================
 *
 * Appelé par la passerelle pour le compte d'un payeur SANS COMPTE PayNoval :
 * quelqu'un qui reçoit un lien de cagnotte et paie par mobile money ou par
 * carte.
 *
 * ⚠️ Rendre 200 ici ne veut pas dire « payé ». Cela veut dire « le prestataire
 * a accepté de prélever ». La confirmation arrive par un rappel signé, et c'est
 * elle seule qui écrit au grand livre (règle B.3).
 *
 * La réponse le dit explicitement — `status: "pending"` et non `"succeeded"` —
 * pour qu'aucun appelant ne puisse se tromper en lisant un code HTTP.
 */

const logger = require("../logger");
const {
  CollectionError,
  initiateCollection,
} = require("../services/collections/collectionService");

/**
 * La clé d'idempotence vient de l'en-tête, avec repli sur le corps.
 *
 * L'en-tête est la forme canonique (Stripe : `Idempotency-Key`), et c'est celle
 * que la passerelle relaie depuis le 2026-09-09. Le repli sur le corps existe
 * parce qu'un appelant qui n'en pose aucune ne doit pas être servi en silence
 * avec une clé inventée — il doit être REFUSÉ, et l'être de façon lisible.
 */
function extraireCleIdempotence(req) {
  const entetes = req?.headers || {};

  for (const attendu of ["idempotency-key", "x-idempotency-key"]) {
    for (const nom of Object.keys(entetes)) {
      if (String(nom).toLowerCase() !== attendu) continue;
      const brut = entetes[nom];
      const valeur = Array.isArray(brut) ? brut[0] : brut;
      const propre = String(valeur ?? "").trim();
      if (propre) return propre;
    }
  }

  return String(req?.body?.idempotencyKey ?? "").trim();
}

async function initiate(req, res) {
  const corps = req.body || {};

  try {
    // `getTxConn` résolu à l'appel. ⚠️ `getTransactionsConnection` n'a jamais
    // existé dans `config/db.js` : l'appel levait `TypeError` (2026-09-17).
    // Garde : `test/configDbImports.test.js`.
    const { getTxConn } = require("../config/db");
    const conn = getTxConn();

    const { intent, replayed } = await initiateCollection(conn, {
      idempotencyKey: extraireCleIdempotence(req),
      rail: corps.rail,
      provider: corps.provider,
      amount: corps.amount,
      currency: corps.currency,
      purpose: corps.purpose,
      target: corps.target,
      payer: corps.payer,
      cardToken: corps.cardToken,
      requestId: String(req.headers["x-request-id"] || "").trim(),
    });

    return res.status(replayed ? 200 : 201).json({
      success: true,
      replayed,
      collection: {
        reference: intent.reference,
        status: intent.status,
        rail: intent.rail,
        provider: intent.provider,
        amount: intent.amount,
        currency: intent.currency,
        providerReference: intent.providerReference || null,
      },
      /**
       * Dit en toutes lettres ce que le code HTTP ne dit pas. Une page de
       * paiement qui lit « succeeded » là où l'argent n'est pas encore prélevé
       * afficherait un remerciement pour un paiement qui peut encore échouer.
       */
      message:
        intent.status === "pending"
          ? "Prélèvement demandé au prestataire. La confirmation arrivera par rappel."
          : "Encaissement enregistré.",
    });
  } catch (err) {
    if (err instanceof CollectionError) {
      /**
       * ⚠️ On journalise le CODE, jamais le corps de la requête : il peut porter
       * un numéro de téléphone, et — le temps que la page publique soit
       * corrigée — encore un numéro de carte (règle B.4).
       */
      logger.warn("[collection] initiation refusée", {
        code: err.code,
        statusCode: err.statusCode,
        rail: String(corps.rail || ""),
        provider: String(corps.provider || ""),
        requestId: String(req.headers["x-request-id"] || ""),
      });

      return res.status(err.statusCode).json({
        success: false,
        code: err.code,
        error: err.message,
      });
    }

    logger.error("[collection] initiation en erreur", {
      error: err?.message,
      requestId: String(req.headers["x-request-id"] || ""),
    });

    return res.status(500).json({
      success: false,
      code: "COLLECTION_INTERNAL_ERROR",
      error: "Encaissement impossible.",
    });
  }
}

module.exports = { initiate, extraireCleIdempotence };
