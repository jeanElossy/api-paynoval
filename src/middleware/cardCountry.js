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

const CLIENT_FIELDS = Object.freeze(["sourceCardCountry", "binCountry"]);

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
      if (isCardRail(body.funds)) {
        for (const field of CLIENT_FIELDS) delete body[field];

        const card = body.cardId ? await loadCard(req.user?._id || req.user?.id, body.cardId) : null;
        const country = sourceCountryOf({
          card,
          mode: req.user?.mode,
          accountCountry: body.fromCountry || body.country || req.user?.country,
        });

        if (country) body.sourceCardCountry = country;
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

module.exports = { cardCountry, sourceCountryOf };
