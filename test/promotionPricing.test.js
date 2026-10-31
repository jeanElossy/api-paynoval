"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { applyDiscountToBundle, computeDiscount } = require("../src/services/promotions/promotionPricing");
const { previewPromotion, reservePromotion } = require("../src/services/promotions/promotionRedemption");
const { normalizePricingSnapshot, buildTreasuryRevenueBreakdown } = require("../src/services/pricingSnapshotNormalizer");

const bundle = () => ({
  grossFrom: 100000,
  fee: 2000,
  netFrom: 98000,
  netTo: 98000,
  treasuryRevenue: null,
  pricingSnapshot: {
    request: { fromCurrency: "XOF", toCurrency: "XOF" },
    result: {
      fee: 2000,
      grossFrom: 100000,
      netTo: 98000,
      feeRevenue: {
        amount: 2000,
        sourceCurrency: "XOF",
        amountInTreasuryCurrency: 4,
        treasuryCurrency: "CAD",
        conversionRateToTreasury: 0.002,
      },
    },
  },
});

test("la réduction suit le pourcentage, le plafond et ne dépasse jamais les frais", () => {
  assert.equal(computeDiscount({ fee: 2000, percent: 20, cap: 5000, currency: "XOF" }), 400);
  assert.equal(computeDiscount({ fee: 2000, percent: 50, cap: 300, currency: "XOF" }), 300);
  assert.equal(computeDiscount({ fee: 2000, percent: 100, cap: 9000, currency: "XOF" }), 2000);
});

test("sans plafond pour la devise, le code ne s'applique pas", () => {
  assert.equal(computeDiscount({ fee: 2000, percent: 20, cap: undefined, currency: "XOF" }), 0);
  assert.equal(computeDiscount({ fee: 2000, percent: 20, cap: 0, currency: "XOF" }), 0);
  assert.equal(computeDiscount({ fee: 0, percent: 20, cap: 100, currency: "XOF" }), 0);
});

test("le destinataire reçoit le même montant et l'expéditeur paie moins", () => {
  const applied = applyDiscountToBundle(bundle(), 400, "XOF");
  assert.equal(applied.netTo, 98000);
  assert.equal(applied.netFrom, 98000);
  assert.equal(applied.grossFrom, 99600);
  assert.equal(applied.fee, 1600);
});

test("le débit reste égal au net plus les frais", () => {
  const applied = applyDiscountToBundle(bundle(), 400, "XOF");
  assert.equal(applied.grossFrom, applied.netFrom + applied.fee);
});

test("la trésorerie encaisse la somme réellement payée, pas les frais pleins", () => {
  const applied = applyDiscountToBundle(bundle(), 400, "XOF");
  const revenue = buildTreasuryRevenueBreakdown(applied.pricingSnapshot);
  assert.equal(revenue.feeRevenue.sourceAmount, 1600);
  assert.equal(revenue.feeRevenue.treasuryAmount, 3.2);
});

test("le montant survit à la normalisation écrite sur la transaction", () => {
  const applied = applyDiscountToBundle(bundle(), 400, "XOF");
  const stored = normalizePricingSnapshot(applied.pricingSnapshot);
  assert.equal(buildTreasuryRevenueBreakdown(stored).feeRevenue.sourceAmount, 1600);
});

test("un résultat déséquilibré arrête le transfert", () => {
  const broken = { ...bundle(), netFrom: 90000 };
  assert.throws(() => applyDiscountToBundle(broken, 400, "XOF"), /incohérente/);
});

function fakeDb(promotion) {
  const redemptions = new Map();
  const promotionsCol = {
    findOne: async () => promotion,
    updateOne: async (filter, update) => {
      if (update.$inc) {
        if (filter.$or && promotion.maxUses !== null && (promotion.uses || 0) >= promotion.maxUses) {
          return { modifiedCount: 0 };
        }
        promotion.uses = (promotion.uses || 0) + update.$inc.uses;
      }
      return { modifiedCount: 1 };
    },
  };
  const redemptionsCol = {
    insertOne: async (doc) => {
      if (redemptions.has(doc._id)) throw Object.assign(new Error("dup"), { code: 11000 });
      redemptions.set(doc._id, doc);
    },
    updateOne: async (filter, { $set }) => {
      const doc = redemptions.get(filter._id);
      if (!doc || (filter.status && doc.status !== filter.status)) return { modifiedCount: 0 };
      Object.assign(doc, $set);
      return { modifiedCount: 1 };
    },
    deleteOne: async ({ _id }) => redemptions.delete(_id),
  };
  return { collection: (name) => (name === "promotions" ? promotionsCol : redemptionsCol) };
}

const activePromo = (over = {}) => ({
  _id: "p1",
  code: "BIENVENUE",
  status: "active",
  discountPercent: 20,
  maxDiscount: { XOF: 1000 },
  maxUses: null,
  uses: 0,
  ...over,
});

const reserve = (db, userId = "u1") =>
  reservePromotion({ code: "bienvenue", userId, bundle: bundle(), currency: "XOF", db });

test("sans code, le prix reste strictement inchangé", async () => {
  const input = bundle();
  const out = await reservePromotion({ code: "", userId: "u1", bundle: input, currency: "XOF" });
  assert.equal(out.bundle, input);
  assert.equal(out.record, null);
});

test("un code valide réduit les frais et compte une utilisation", async () => {
  const promo = activePromo();
  const out = await reserve(fakeDb(promo));
  assert.equal(out.record.discount, 400);
  assert.equal(out.bundle.fee, 1600);
  assert.equal(promo.uses, 1);
});

test("un client n'utilise pas deux fois le même code", async () => {
  const db = fakeDb(activePromo());
  await reserve(db);
  await assert.rejects(reserve(db), { code: "PROMO_ALREADY_USED" });
});

test("un transfert échoué rend le code au client", async () => {
  const promo = activePromo();
  const db = fakeDb(promo);
  const first = await reserve(db);
  await first.release();
  assert.equal(promo.uses, 0);
  assert.equal((await reserve(db)).record.discount, 400);
});

test("le nombre total d'utilisations est tenu", async () => {
  const db = fakeDb(activePromo({ maxUses: 1 }));
  await reserve(db, "u1");
  await assert.rejects(reserve(db, "u2"), { code: "PROMO_EXHAUSTED" });
});

test("un code inconnu, en pause ou expiré arrête le transfert, sans prix plein surprise", async () => {
  await assert.rejects(reserve(fakeDb(null)), { code: "PROMO_INVALID" });
  await assert.rejects(reserve(fakeDb(activePromo({ status: "paused" }))), { code: "PROMO_INVALID" });
  await assert.rejects(
    reserve(fakeDb(activePromo({ validUntil: new Date("2020-01-01") }))),
    { code: "PROMO_EXPIRED" }
  );
});

test("une devise sans plafond est refusée", async () => {
  await assert.rejects(reserve(fakeDb(activePromo({ maxDiscount: { EUR: 3 } }))), { code: "PROMO_NOT_ELIGIBLE" });
});

test("le transfert interne applique la réduction et rend le code en cas d'échec", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const read = (file) => fs.readFileSync(path.join(__dirname, "../src", file), "utf8");
  const handler = read("services/transactions/handlers/initiateInternal.js");

  assert.match(handler, /bundle: extractPricingBundle\(pricingPayload, pricingInput\)/);
  assert.match(handler, /\} = promotion\.bundle;/);
  assert.match(handler, /await promotion\?\.release\(\)/);
  assert.match(handler, /promotion: promotion\.record/);
  assert.match(read("services/transactions/handlers/cancelTransaction.js"), /restorePromotion\(promotionToRestore\)/);
  assert.match(read("services/transactionAutoCancelService.js"), /restorePromotion\(promotionToRestore\)/);
});

test("un autre rail refuse le code à voix haute", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const external = fs.readFileSync(
    path.join(__dirname, "../src/services/transactions/handlers/initiateExternalTransactions.js"),
    "utf8"
  );
  assert.match(external, /if \(body\.promoCode\)/);
});

test("la prévisualisation annonce la réduction sans rien réserver", async () => {
  const promo = activePromo();
  const db = fakeDb(promo);
  db.collection("promotion_redemptions").findOne = async () => null;
  const out = await previewPromotion({ code: "bienvenue", userId: "u1", fee: 2000, currency: "xof", db });
  assert.deepEqual(out, { code: "BIENVENUE", discount: 400, currency: "XOF", feeAfter: 1600 });
  assert.equal(promo.uses, 0);
});

test("la prévisualisation refuse un code déjà utilisé par ce client", async () => {
  const db = fakeDb(activePromo());
  const redemptions = db.collection("promotion_redemptions");
  redemptions.findOne = async () => ({ status: "reserved" });
  await assert.rejects(
    previewPromotion({ code: "bienvenue", userId: "u1", fee: 2000, currency: "XOF", db }),
    { code: "PROMO_ALREADY_USED" }
  );
});
