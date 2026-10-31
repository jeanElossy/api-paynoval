"use strict";

const mongoose = require("mongoose");

const { getUsersConn } = require("../../config/db");
const { applyDiscountToBundle, computeDiscount } = require("./promotionPricing");

const PROMOTIONS = "promotions";
const REDEMPTIONS = "promotion_redemptions";

function refusal(code, message, status = 400) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function assertUsable(promotion, now) {
  if (!promotion || promotion.status !== "active") {
    throw refusal("PROMO_INVALID", "Ce code promotionnel n'est pas valide.");
  }
  if (promotion.validFrom && new Date(promotion.validFrom) > now) {
    throw refusal("PROMO_NOT_STARTED", "Ce code n'est pas encore valable.");
  }
  if (promotion.validUntil && new Date(promotion.validUntil) < now) {
    throw refusal("PROMO_EXPIRED", "Ce code a expiré.");
  }
}

/** Puts a used code back, for a transfer that did not happen. Never throws. */
async function releaseRedemption({ redemptionId, promotionId, db, logger = console }) {
  try {
    const database = db || getUsersConn().db;
    const released = await database
      .collection(REDEMPTIONS)
      .updateOne({ _id: redemptionId, status: "reserved" }, { $set: { status: "released", releasedAt: new Date() } });

    if (released.modifiedCount) {
      await database.collection(PROMOTIONS).updateOne({ _id: promotionId }, { $inc: { uses: -1 } });
    }
  } catch (err) {
    // The client lost one use of a code; no money is involved.
    logger.error?.("[promotion] code non restitué", { redemptionId, message: err?.message });
  }
}

/** Gives a cancelled transfer's code back to the client. */
function restorePromotion(record) {
  if (!record?.redemptionId) return Promise.resolve();
  return releaseRedemption({
    redemptionId: record.redemptionId,
    promotionId: new mongoose.Types.ObjectId(String(record.promotionId)),
  });
}

/**
 * Reserves one use of a code and returns the discounted pricing bundle. One use
 * per client is held by the redemption `_id`, so it needs no index to be true.
 * Any refusal stops the transfer: a client who entered a code must never pay
 * full price without knowing it.
 */
async function reservePromotion({ code, userId, bundle, currency, db, now = new Date() }) {
  const clean = String(code || "").trim().toUpperCase();
  if (!clean) return { bundle, record: null, release: async () => {} };

  const database = db || getUsersConn().db;
  const promotions = database.collection(PROMOTIONS);
  const redemptions = database.collection(REDEMPTIONS);

  let promotion;
  try {
    promotion = await promotions.findOne({ code: clean });
  } catch (err) {
    throw refusal("PROMO_UNAVAILABLE", "Vérification du code indisponible, réessayez.", 503);
  }

  assertUsable(promotion, now);

  const iso = String(currency || "").toUpperCase();
  const cap = promotion.maxDiscount?.[iso];
  const discount = computeDiscount({ fee: bundle.fee, percent: promotion.discountPercent, cap, currency: iso });
  if (discount <= 0) throw refusal("PROMO_NOT_ELIGIBLE", "Ce code ne s'applique pas à ce transfert.");

  const applied = applyDiscountToBundle(bundle, discount, iso);

  const redemptionId = `${promotion._id}:${userId}`;
  const record = {
    promotionId: String(promotion._id),
    code: clean,
    percent: promotion.discountPercent,
    discount,
    currency: iso,
    feeBefore: bundle.fee,
    redemptionId,
  };

  try {
    await redemptions.insertOne({
      _id: redemptionId,
      promotionId: promotion._id,
      userId: String(userId),
      code: clean,
      discount,
      currency: iso,
      status: "reserved",
      createdAt: now,
    });
  } catch (err) {
    if (err?.code !== 11000) {
      throw refusal("PROMO_UNAVAILABLE", "Vérification du code indisponible, réessayez.", 503);
    }
    // A cancelled transfer gave the code back: it can be used again.
    const reused = await redemptions.updateOne(
      { _id: redemptionId, status: "released" },
      { $set: { status: "reserved", discount, currency: iso, createdAt: now } }
    );
    if (!reused.modifiedCount) throw refusal("PROMO_ALREADY_USED", "Vous avez déjà utilisé ce code.", 409);
  }

  const counted = await promotions.updateOne(
    {
      _id: promotion._id,
      status: "active",
      $or: [{ maxUses: null }, { $expr: { $lt: [{ $ifNull: ["$uses", 0] }, "$maxUses"] } }],
    },
    { $inc: { uses: 1 } }
  );

  if (!counted.modifiedCount) {
    await redemptions.deleteOne({ _id: redemptionId });
    throw refusal("PROMO_EXHAUSTED", "Ce code a atteint sa limite d'utilisation.", 409);
  }

  const release = () => releaseRedemption({ redemptionId, promotionId: promotion._id, db: database });
  return { bundle: applied, record, release };
}

module.exports = { releaseRedemption, reservePromotion, restorePromotion };
