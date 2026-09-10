"use strict";

/**
 * ============================================================================
 * CONTRÔLE AML D'UN ENCAISSEMENT PUBLIC — LE PAYEUR N'A PAS DE COMPTE
 * ============================================================================
 *
 * ── Pourquoi ce contrôle est distinct de `middleware/aml.js` ────────────────
 *
 * `middleware/aml.js` commence par exiger un utilisateur authentifié. Ce
 * chemin-ci sert exactement le cas contraire : quelqu'un qui reçoit un lien de
 * cagnotte et n'a PAS de compte PayNoval. Y rendre l'utilisateur facultatif
 * affaiblirait un contrôle en vigueur sur tous ses appelants, présents et
 * futurs, pour servir un cas qui n'est pas le sien.
 *
 * ── Pourquoi il vit dans Tx-Core et non au bord ─────────────────────────────
 *
 * Il a été écrit dans la passerelle le 2026-09-10, puis descendu ici le même
 * jour avec le reste de l'AML. La raison est la même pour les deux : un
 * contrôle de conformité au bord ne protège que ce qui passe par le bord.
 * Ici, il est sur la route qui crée l'intention d'encaissement — c'est-à-dire
 * devant le seul endroit d'où l'argent peut entrer.
 *
 * Conséquence directe et voulue : le jour où un second appelant (un partenaire,
 * un back-office) atteindra `/api/v1/collections/initiate`, il sera criblé sans
 * que personne ait à y penser. C'est ce qu'une garde au bord ne pouvait pas
 * promettre.
 *
 * ── Ce qui remplace les contrôles fondés sur l'utilisateur ──────────────────
 *
 * Sans compte, il n'y a ni historique, ni niveau de KYC, ni cumul glissant. Il
 * reste trois prises, et ce sont celles que les prestataires de collecte
 * utilisent eux-mêmes :
 *
 *   1. un PLAFOND par contribution — au-dessus, on exige un compte ;
 *   2. le CRIBLAGE du nom déclaré par le contributeur ;
 *   3. la LIMITE PAR ADRESSE IP, portée par le limiteur de la route au bord.
 *
 * ⚠️ Ce n'est pas équivalent au contrôle authentifié, et il ne faut pas le
 * présenter comme tel. Un contributeur anonyme peut fractionner ses versements
 * sous le plafond. La contrepartie est assumée : le plafond est bas, et le
 * rapprochement prestataire — `PROVIDER_INBOUND:<RAIL>` — donne la vue par
 * relevé qui permet de repérer un fractionnement après coup.
 */

const logger = require("../utils/logger");
const {
  screenTransactionCounterparties,
} = require("../services/risk/sanctionsScreening");

/**
 * Plafond d'une contribution anonyme.
 *
 * ⚠️ Une valeur par défaut existe DÉLIBÉRÉMENT, et elle est basse. La règle B.2
 * dit qu'une donnée financière absente arrête l'opération ; ici l'absence de
 * réglage ne doit pas ouvrir un plafond infini, ce qui serait le repli
 * silencieux le plus coûteux du fichier. Le défaut est donc restrictif, et il
 * s'annonce au premier appel.
 */
const PLAFOND_DEFAUT = 250000;

let plafondAnnonce = false;

function plafond() {
  const brut = String(process.env.PUBLIC_COLLECTION_MAX_AMOUNT || "").trim();
  const valeur = Number(brut);
  const configure = brut !== "" && Number.isFinite(valeur) && valeur > 0;
  const retenu = configure ? valeur : PLAFOND_DEFAUT;

  if (!plafondAnnonce) {
    plafondAnnonce = true;

    /**
     * Règle B.6 : les journaux disent la vérité, avec la conséquence. Un
     * plafond hérité d'un défaut doit être visible, pas deviné.
     */
    logger[configure ? "info" : "warn"](
      configure
        ? `[collections][aml] plafond de contribution publique : ${retenu}`
        : `[collections][aml] PUBLIC_COLLECTION_MAX_AMOUNT non réglée — ` +
            `plafond par défaut de ${retenu} appliqué. Toute contribution ` +
            `au-dessus sera REFUSÉE.`
    );
  }

  return retenu;
}

async function publicCollectionAml(req, res, next) {
  const corps = req.body || {};
  const montant = Number(corps.amount);
  const limite = plafond();

  if (!Number.isFinite(montant) || montant <= 0) {
    return res.status(400).json({
      success: false,
      code: "INVALID_AMOUNT",
      error: "Montant invalide.",
    });
  }

  if (montant > limite) {
    logger.warn("[collections][aml] contribution au-dessus du plafond public", {
      limite,
      devise: String(corps.currency || ""),
    });

    return res.status(403).json({
      success: false,
      code: "PUBLIC_COLLECTION_LIMIT",
      error:
        "Cette contribution dépasse le plafond applicable sans compte " +
        "PayNoval. Créez un compte pour poursuivre.",
    });
  }

  const nom = String(corps.donorName || corps.recipientName || "").trim();

  /**
   * ⚠️ ÉCHEC EN FERMETURE. Si le criblage est configuré mais tombe en panne, on
   * refuse. Laisser passer « parce que le service ne répond pas » revient à
   * désactiver le contrôle au moment précis où on ne peut plus le vérifier —
   * et personne ne s'en apercevrait, puisque le paiement, lui, aboutirait.
   *
   * Le criblage DÉSACTIVÉ est un autre cas : il rend `enabled: false`, ce qui
   * est un état connu et annoncé au démarrage, pas une panne.
   */
  let criblage;

  try {
    criblage = await screenTransactionCounterparties({
      user: {
        fullName: nom,
        phone: String(corps.phoneNumber || ""),
        country: String(corps.country || ""),
      },
      body: corps,
      phoneNumber: String(corps.phoneNumber || ""),
      destinationCountryISO: String(corps.country || ""),
    });
  } catch (err) {
    logger.error("[collections][aml] criblage indisponible — refusé", {
      error: err?.message,
    });

    return res.status(503).json({
      success: false,
      code: "SCREENING_UNAVAILABLE",
      error: "Contrôle de conformité indisponible. Merci de réessayer.",
    });
  }

  if (criblage?.blocked) {
    /**
     * ⚠️ On journalise la DÉCISION et le motif, jamais le nom criblé ni les
     * correspondances : ce sont des données personnelles, et une liste de
     * correspondances de sanctions dans un journal applicatif est une fuite
     * doublée d'un risque de diffamation (règle B.4).
     */
    logger.warn("[collections][aml] contribution bloquée par le criblage", {
      reason: criblage.reason || "SANCTIONS_HIT",
      nbHits: Array.isArray(criblage.hits) ? criblage.hits.length : 0,
    });

    return res.status(403).json({
      success: false,
      code: "SCREENING_BLOCKED",
      error: "Cette contribution ne peut pas être acceptée.",
    });
  }

  req.publicCollectionScreening = {
    enabled: Boolean(criblage?.enabled),
    checked: Boolean(criblage?.checked),
    reason: criblage?.reason || "",
  };

  return next();
}

module.exports = publicCollectionAml;
module.exports.PLAFOND_DEFAUT = PLAFOND_DEFAUT;
