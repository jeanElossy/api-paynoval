"use strict";

/**
 * Parrainage — durcissement du 2026-09-17.
 *
 * Chaque test ici échoue si l'on réintroduit le défaut qu'il verrouille :
 *   C2  un filleul payé deux fois (lien de parrainage modifié) ;
 *   E2  un doublon d'index déclaré « déjà payé » sans preuve ;
 *   E3  un refus 401/429 du principal traité comme définitif (bonus perdu) ;
 *   M3  un versement hors partie double (invisible à la balance) ;
 *   E1  un remboursement qui n'annonce rien (bonus indûment acquis).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");

const {
  validateBeneficiaryRoles,
  classifyPayoutDuplicate,
  isPermanentTransferFailure,
  buildClawbackIdempotencyKey,
  buildPayoutIdempotencyKey,
} = require("../src/services/referral/referralKeys");

const {
  buildReferralPayoutLots,
  buildReferralClawbackLots,
} = require("../src/services/ledger/referralLegs");

const { checkBalanced } = require("../src/services/ledger/doubleEntry");

const {
  isPermanentHttpStatus,
  resolveDeliveryTarget,
} = require("../src/services/referral/referralDelivery");

const RACINE = path.join(__dirname, "..");
const lire = (rel) => fs.readFileSync(path.join(RACINE, rel), "utf8");

const SPONSOR = "5f1111111111111111111111";
const REFEREE = "5f2222222222222222222222";
const TREASURY = "5f9999999999999999999999";

/* -------------------------------------------------------------------------- */
/* C2 — un bonus de bienvenue par personne, à vie                             */
/* -------------------------------------------------------------------------- */

test("C2 : le registre interdit un second bonus filleul pour la même personne", () => {
  const ReferralPayout = require("../src/models/ReferralPayout")(mongoose);
  const indexes = ReferralPayout.schema.indexes();

  const lifetime = indexes.find(
    ([keys, opts]) =>
      keys.beneficiaryId === 1 &&
      opts?.unique === true &&
      opts?.partialFilterExpression?.beneficiaryRole === "referee"
  );

  assert.ok(
    lifetime,
    "sans cet index, modifier le parrain d'un filleul déjà payé crée un nouveau " +
      "rewardId, donc une nouvelle clé, donc un second bonus"
  );

  const perRole = indexes.find(
    ([keys, opts]) => keys.rewardId === 1 && keys.beneficiaryRole === 1 && opts?.unique === true
  );
  assert.ok(perRole, "une récompense ne paie qu'un parrain et qu'un filleul");
});

test("la clé de reprise est distincte de la clé de versement, et déterministe", () => {
  const a = buildClawbackIdempotencyKey("r1", REFEREE);
  assert.equal(a, `REFERRAL_CLAWBACK:r1:${REFEREE}`);
  assert.equal(a, buildClawbackIdempotencyKey("r1", REFEREE));
  assert.notEqual(a, buildPayoutIdempotencyKey("r1", REFEREE));
});

/* -------------------------------------------------------------------------- */
/* Forme d'une demande de versement                                           */
/* -------------------------------------------------------------------------- */

test("un parrain et un filleul distincts : demande valide", () => {
  const r = validateBeneficiaryRoles(
    [
      { userId: SPONSOR, role: "sponsor" },
      { userId: REFEREE, role: "referee" },
    ],
    { treasuryUserId: TREASURY }
  );
  assert.deepEqual(r, { ok: true });
});

test("le parrain et le filleul ne peuvent pas être la même personne", () => {
  const r = validateBeneficiaryRoles([
    { userId: REFEREE, role: "sponsor" },
    { userId: REFEREE, role: "referee" },
  ]);
  assert.equal(r.code, "SELF_REFERRAL_PAYOUT");
  assert.ok(isPermanentTransferFailure(r.code));
});

test("deux filleuls dans une même demande sont refusés", () => {
  const r = validateBeneficiaryRoles([
    { userId: SPONSOR, role: "referee" },
    { userId: REFEREE, role: "referee" },
  ]);
  assert.equal(r.code, "DUPLICATE_BENEFICIARY_ROLE");
});

test("un rôle inconnu et la trésorerie bénéficiaire sont refusés", () => {
  assert.equal(
    validateBeneficiaryRoles([{ userId: SPONSOR, role: "admin" }]).code,
    "INVALID_BENEFICIARY_ROLE"
  );
  assert.equal(
    validateBeneficiaryRoles([{ userId: TREASURY, role: "sponsor" }], {
      treasuryUserId: TREASURY,
    }).code,
    "TREASURY_AS_BENEFICIARY"
  );
});

/* -------------------------------------------------------------------------- */
/* E2 — jamais « payé » sans preuve                                           */
/* -------------------------------------------------------------------------- */

test("E2 : un doublon d'index SANS preuve de versement n'est pas un succès", () => {
  const verdict = classifyPayoutDuplicate({
    settledCount: 0,
    refereePaidElsewhere: false,
    legacyTransactionCount: 0,
    beneficiaryCount: 2,
  });

  assert.equal(
    verdict,
    "unexplained",
    "l'ancien code répondait ok:true ALREADY_PAID_LEGACY : la transaction Mongo " +
      "était annulée, aucun argent n'avait bougé, et la récompense passait « payée »"
  );
});

test("E2 : une seule transaction héritée sur deux bénéficiaires ne prouve rien", () => {
  assert.equal(
    classifyPayoutDuplicate({ legacyTransactionCount: 1, beneficiaryCount: 2 }),
    "unexplained"
  );
  assert.equal(
    classifyPayoutDuplicate({ legacyTransactionCount: 2, beneficiaryCount: 2 }),
    "legacy_paid"
  );
});

test("E2 : le registre prime, puis le filleul déjà récompensé ailleurs", () => {
  assert.equal(
    classifyPayoutDuplicate({ settledCount: 1, refereePaidElsewhere: true }),
    "replay"
  );
  assert.equal(
    classifyPayoutDuplicate({ refereePaidElsewhere: true, legacyTransactionCount: 2, beneficiaryCount: 2 }),
    "referee_already_rewarded"
  );
  assert.ok(isPermanentTransferFailure("REFEREE_ALREADY_REWARDED"));
  assert.equal(isPermanentTransferFailure("DUPLICATE_KEY_UNEXPLAINED"), false);
  assert.equal(isPermanentTransferFailure("REFERRAL_TREASURY_INSUFFICIENT_FUNDS"), false);
});

/* -------------------------------------------------------------------------- */
/* M3 — partie double                                                         */
/* -------------------------------------------------------------------------- */

const base = {
  treasuryUserId: TREASURY,
  treasurySystemType: "REFERRAL_TREASURY",
  beneficiaryId: REFEREE,
};

function allLegs(lots) {
  return lots.flatMap((l) => l.legs);
}

test("M3 : un versement en même devise est un lot unique, équilibré", () => {
  const lots = buildReferralPayoutLots({
    ...base,
    treasuryCurrency: "CAD",
    treasuryAmount: 5,
    beneficiaryCurrency: "CAD",
    beneficiaryAmount: 5,
  });

  assert.equal(lots.length, 1);
  assert.equal(lots[0].entryType, "REFERRAL_PAYOUT");
  assert.ok(checkBalanced(lots[0].legs).ok);

  const debit = lots[0].legs.find((l) => l.direction === "DEBIT");
  const credit = lots[0].legs.find((l) => l.direction === "CREDIT");
  assert.equal(debit.accountId, `treasury:REFERRAL_TREASURY:${TREASURY}:CAD`);
  assert.equal(credit.accountId, `user_wallet:${REFEREE}:CAD`);
});

test("M3 : un versement converti passe par la compensation de change", () => {
  const lots = buildReferralPayoutLots({
    ...base,
    treasuryCurrency: "CAD",
    treasuryAmount: 2.25,
    beneficiaryCurrency: "XOF",
    beneficiaryAmount: 1000,
  });

  assert.equal(lots.length, 2);
  for (const lot of lots) assert.ok(checkBalanced(lot.legs).ok, lot.scope);

  const accounts = allLegs(lots).map((l) => `${l.direction}:${l.accountId}`);
  assert.deepEqual(accounts, [
    `DEBIT:treasury:REFERRAL_TREASURY:${TREASURY}:CAD`,
    "CREDIT:system_clearing:FX_CONVERSION:CAD",
    "DEBIT:system_clearing:FX_CONVERSION:XOF",
    `CREDIT:user_wallet:${REFEREE}:XOF`,
  ]);
});

test("M3 : la reprise est l'image miroir exacte du versement", () => {
  const input = {
    ...base,
    treasuryCurrency: "CAD",
    treasuryAmount: 2.25,
    beneficiaryCurrency: "XOF",
    beneficiaryAmount: 1000,
  };

  const payout = allLegs(buildReferralPayoutLots(input));
  const clawback = allLegs(buildReferralClawbackLots(input));

  const net = new Map();
  for (const leg of [...payout, ...clawback]) {
    const sign = leg.direction === "DEBIT" ? 1 : -1;
    const k = `${leg.accountId}|${leg.currency}`;
    net.set(k, (net.get(k) || 0) + sign * leg.amount);
  }

  for (const [k, v] of net) {
    assert.ok(Math.abs(v) < 1e-9, `${k} doit revenir à zéro après reprise (reste ${v})`);
  }

  for (const lot of buildReferralClawbackLots(input)) {
    assert.equal(lot.entryType, "REVERSAL", "une correction est une contre-écriture (invariant 4)");
  }
});

test("M3 : même devise, montants divergents = argent créé ou perdu, refusé", () => {
  assert.throws(
    () =>
      buildReferralPayoutLots({
        ...base,
        treasuryCurrency: "CAD",
        treasuryAmount: 5,
        beneficiaryCurrency: "CAD",
        beneficiaryAmount: 6,
      }),
    { code: "REFERRAL_LEGS_INCONSISTENT" }
  );

  assert.throws(
    () =>
      buildReferralPayoutLots({
        ...base,
        treasuryCurrency: "CAD",
        treasuryAmount: 0,
        beneficiaryCurrency: "CAD",
        beneficiaryAmount: 0,
      }),
    { code: "REFERRAL_LEGS_INVALID" }
  );
});

test("M3 : le service de versement n'écrit plus en partie simple", () => {
  const source = lire("src/services/internalReferralTransferService.js").replace(
    /\/\*[\s\S]*?\*\//g,
    ""
  );
  assert.doesNotMatch(source, /createLedgerEntry\s*\(/, "écriture v1 non équilibrée");
  assert.match(source, /postDoubleEntry\s*\(/);
  assert.doesNotMatch(
    source,
    /ledger:skipped:no-transaction-id/,
    "un versement sans transaction rattachable doit lever, pas « sauter » le grand livre"
  );
});

test("M4 : la session du versement vient de la connexion des transactions", () => {
  for (const rel of [
    "src/services/internalReferralTransferService.js",
    "src/services/internalReferralClawbackService.js",
  ]) {
    const source = lire(rel).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(source, /mongoose\.startSession\s*\(/, rel);
    assert.match(source, /getTxConn\(\)\.startSession\s*\(/, rel);
  }
});

/* -------------------------------------------------------------------------- */
/* E3 — un refus passager ne fait pas perdre un bonus                         */
/* -------------------------------------------------------------------------- */

test("E3 : jeton désaligné et limitation de débit se rejouent", () => {
  for (const status of [401, 403, 408, 409, 425, 429, 500, 502, 503]) {
    assert.equal(isPermanentHttpStatus(status), false, `HTTP ${status} doit être rejoué`);
  }
  for (const status of [400, 404, 410, 422]) {
    assert.equal(isPermanentHttpStatus(status), true, `HTTP ${status} est définitif`);
  }
});

test("chaque événement de parrainage a sa route, et un inconnu est refusé", () => {
  assert.equal(
    resolveDeliveryTarget("referral.activity.confirmed.v1", { refereeId: REFEREE, triggerTxId: "t" }).path,
    "/api/v1/internal/referral/award-bonus"
  );

  const reversed = resolveDeliveryTarget("referral.activity.reversed.v1", {
    refereeId: REFEREE,
    reversedTxId: "t",
    bonusAmount: 999999,
  });
  assert.equal(reversed.path, "/api/v1/internal/referral/activity-reversed");
  assert.deepEqual(
    Object.keys(reversed.body).sort(),
    ["refereeId", "reversedTxId"],
    "aucun montant ne transite : l'événement est un fait, pas un ordre"
  );

  assert.throws(() => resolveDeliveryTarget("referral.pay.now.v1", {}), {
    code: "REFERRAL_EVENT_UNKNOWN",
  });
});

/* -------------------------------------------------------------------------- */
/* E1 — un remboursement s'annonce                                            */
/* -------------------------------------------------------------------------- */

test("E1 : tout chemin qui passe une transaction en `refunded` publie l'événement de reprise", () => {
  const fichiers = [];
  const parcourir = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) parcourir(p);
      else if (e.name.endsWith(".js")) fichiers.push(p);
    }
  };
  parcourir(path.join(RACINE, "src"));

  const ecrivains = fichiers.filter((f) =>
    /\.status\s*=\s*["']refunded["']/.test(fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""))
  );

  assert.ok(ecrivains.length >= 1, "le remboursement doit rester détectable par ce test");

  for (const f of ecrivains) {
    assert.match(
      fs.readFileSync(f, "utf8"),
      /referral\.activity\.reversed\.v1/,
      `${path.relative(RACINE, f)} rembourse sans annoncer la reprise possible d'un bonus`
    );
  }
});

test("E1 : le contrat d'événement de reprise refuse tout montant", () => {
  const { buildPayload } = require("../src/services/events/contract");

  assert.throws(
    () =>
      buildPayload("referral.activity.reversed.v1", {
        refereeId: REFEREE,
        reversedTxId: "5f3333333333333333333333",
        bonusAmount: 2000,
      }),
    { code: "EVENT_FIELD_UNDECLARED" },
    "un montant glissé dans l'événement en ferait un ordre de reprise"
  );

  const charge = buildPayload("referral.activity.reversed.v1", {
    refereeId: REFEREE,
    reversedTxId: "5f3333333333333333333333",
  });
  assert.equal(charge.refereeId, REFEREE);
});

/* ═══════════ DEUX BARÈMES, DEUX DEVISES (2026-09-22) ═══════════ */

const { normalizeBeneficiaries } = require("../src/services/referral/referralKeys");

test("chaque bénéficiaire porte SA devise de barème, et l'arrondi la suit", () => {
  /*
   * Depuis que chaque partie est récompensée au barème de son pays, les deux
   * montants ne sont plus dans la même unité. Une seule devise d'entrée pour
   * tout le monde aurait converti 5,00 CAD comme s'il s'agissait de 5 XOF.
   */
  const list = normalizeBeneficiaries(
    [
      { userId: "s1", role: "sponsor", amount: 5.004, bonusCurrency: "CAD", payoutCurrency: "CAD" },
      { userId: "r1", role: "referee", amount: 1000.4, bonusCurrency: "XOF", payoutCurrency: "XOF" },
    ],
    "CAD"
  );

  const parrain = list.find((b) => b.role === "sponsor");
  const filleul = list.find((b) => b.role === "referee");

  assert.equal(parrain.bonusCurrency, "CAD");
  assert.equal(parrain.amount, 5); // deux décimales

  assert.equal(filleul.bonusCurrency, "XOF");
  assert.equal(filleul.amount, 1000); // le XOF n'a pas de sous-unité
});

test("un appelant qui n'envoie pas `bonusCurrency` garde l'ancien comportement", () => {
  // Compatibilité : la devise d'entrée reste le repli, à l'identique.
  const [b] = normalizeBeneficiaries(
    [{ userId: "s1", role: "sponsor", amount: 12.345 }],
    "EUR"
  );

  assert.equal(b.bonusCurrency, "EUR");
  assert.equal(b.payoutCurrency, "EUR");
  assert.equal(b.amount, 12.35);
});

test("la devise du PORTEFEUILLE reste distincte de celle du barème", () => {
  // Un bonus libellé en CAD crédité sur un portefeuille en XOF : la
  // conversion est le travail de `buildMovement`, pas de la normalisation.
  const [b] = normalizeBeneficiaries(
    [{ userId: "s1", role: "sponsor", amount: 5, bonusCurrency: "CAD", payoutCurrency: "XOF" }],
    "CAD"
  );

  assert.equal(b.bonusCurrency, "CAD");
  assert.equal(b.payoutCurrency, "XOF");
  assert.equal(b.amount, 5);
});

test("le montant nominal est converti depuis la devise du bénéficiaire", () => {
  // Garde de source : `buildMovement` recevait `inputBonusCurrency` pour tous.
  const source = fs.readFileSync(
    path.join(RACINE, "src", "services", "internalReferralTransferService.js"),
    "utf8"
  );

  assert.match(source, /nominalBonusCurrency: beneficiary\.bonusCurrency/);
  assert.doesNotMatch(source, /nominalBonusCurrency: inputBonusCurrency/);
});
