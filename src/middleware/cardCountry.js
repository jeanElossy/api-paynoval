"use strict";

/**
 * Pays d'une carte — relu côté serveur, jamais cru du téléphone (2026-10-31).
 *
 * Le moteur exige le pays de la carte. Chez Stripe, Adyen ou Wise, il vient de
 * l'émetteur : le prestataire le déduit du BIN à l'enregistrement. Ici de même :
 * la carte enregistrée porte `issuerCountry`, et ce middleware le relit dans la
 * base Users à partir de `cardId`, compte par compte.
 *
 * Toute valeur envoyée par le client est écrasée ou retirée : sinon un téléphone
 * modifié pourrait déclarer le pays qui l'arrange et passer le contrôle de
 * corridor.
 *
 * Une carte de TEST n'a pas de BIN réel : en simulation, son pays est celui du
 * compte. Sur un compte réel, un pays inconnu reste inconnu, et le moteur refuse.
 */

const mongoose = require("mongoose");

const { ACCOUNT_MODES } = require("../utils/accountMode");
const { resoudreTypeExterne } = require("../services/transactions/shared/externalTxType");

/**
 * ⚠️ CARTE DU COMPTE OBLIGATOIRE (2026-11-04). La carte relue ici ne servait
 * qu'à lire son pays : un `cardId` qui n'était PAS une carte du compte ne
 * faisait pas refuser (en simulation, le pays du compte le remplaçait), et la
 * carte qui REÇOIT un retrait n'était pas contrôlée du tout — l'identifiant
 * du téléphone était cru. Désormais, échec en FERMETURE :
 *   - carte qui PAIE (dépôt, recharge d'un transfert) : carte enregistrée du compte ;
 *   - carte qui REÇOIT un RETRAIT : carte enregistrée du compte.
 * La carte d'un TIERS (transfert) n'est pas concernée : elle passe par le
 * lien SMS, le code et la question (`docs/architecture/transfer-claims.md`).
 */
function cardNotOwned(side) {
  return Object.assign(
    new Error(
      side === "destination"
        ? "Un retrait par carte ne peut aller que vers une carte enregistrée sur votre compte."
        : "Cette carte n'est pas une carte enregistrée sur votre compte."
    ),
    { status: 403, statusCode: 403, code: "CARD_NOT_OWNED" }
  );
}

function isWithdrawal(body = {}) {
  const declared = resoudreTypeExterne(body) || String(body.operationType || "").trim().toUpperCase();
  return declared === "WITHDRAW" || declared === "WITHDRAWAL";
}

/** Tous les chemins par lesquels le moteur lirait un pays de carte source. */
function dropClientCountry(body) {
  delete body.sourceCardCountry;
  delete body.binCountry;
  delete body.cardCountry;
  for (const holder of [body.recipientInfo, body.beneficiary, body.metadata, body.meta]) {
    if (holder && typeof holder === "object") delete holder.cardCountry;
  }
}

function isCardRail(value) {
  return ["visa_direct", "card"].includes(String(value || "").trim().toLowerCase());
}

/** Fonction pure : le pays à retenir pour la carte source. */
function sourceCountryOf({ card, mode, accountCountry }) {
  if (card?.issuerCountry) return card.issuerCountry;
  return mode === ACCOUNT_MODES.SANDBOX ? accountCountry || null : null;
}

async function loadOwnCard(userId, cardId) {
  const db = require("../services/transactions/shared/runtime").usersConn.db;

  if (!mongoose.isValidObjectId(String(userId)) || !mongoose.isValidObjectId(String(cardId))) return null;

  const owner = await db.collection("users").findOne(
    { _id: new mongoose.Types.ObjectId(String(userId)) },
    { projection: { cartes: 1 } }
  );

  return (owner?.cartes || []).find((c) => String(c?._id) === String(cardId)) || null;
}

function cardCountry({ loadCard = loadOwnCard } = {}) {
  return async function resolveCardCountry(req, _res, next) {
    const body = req.body;
    if (!body) return next();

    try {
      const userId = req.user?._id || req.user?.id;

      if (isCardRail(body.funds)) {
        dropClientCountry(body);

        const card = body.cardId ? await loadCard(userId, body.cardId) : null;
        if (!card) throw cardNotOwned("source");
        const country = sourceCountryOf({
          card,
          mode: req.user?.mode,
          accountCountry: body.fromCountry || body.country || req.user?.country,
        });

        if (country) body.sourceCardCountry = country;
      }

      // Retrait vers une carte : la SIENNE, enregistrée sur le compte.
      if (isCardRail(body.destination) && isWithdrawal(body)) {
        const card = body.cardId ? await loadCard(userId, body.cardId) : null;
        if (!card) throw cardNotOwned("destination");
        // Les quatre derniers chiffres viennent de la carte enregistrée, jamais du téléphone.
        if (card.last4) body.cardLast4 = String(card.last4);
      }

      // Carte d'un tiers : pas de carte enregistrée chez nous, le pays vient du
      // corridor en simulation, du partenaire sur un compte réel.
      if (
        isCardRail(body.destination) &&
        req.user?.mode === ACCOUNT_MODES.SANDBOX &&
        !body.cardCountry
      ) {
        body.cardCountry = body.toCountry || body.destinationCountry || body.country;
      }

      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { cardCountry, sourceCountryOf, isWithdrawal };
