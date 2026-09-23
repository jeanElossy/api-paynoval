"use strict";

/**
 * ============================================================================
 * LE STEP-UP CLIENT — prévenir, demander, reprendre ou annuler
 * ============================================================================
 *
 * Le test le plus important de ce fichier est celui qui vérifie qu'on ne dit
 * JAMAIS au client quelle règle s'est déclenchée. C'est contre-intuitif — on
 * aimerait être transparent — mais « votre virement a été retenu car vous
 * dépassez 5 opérations par heure » est un mode d'emploi pour le contourner.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_DEADLINE_HOURS,
  MOTIFS_SANS_DEMANDE,
  REQUIRED_DOCUMENTS,
  requiredDocumentsFor,
  clientCategoryFor,
  buildStepUpRecords,
  openStepUpReview,
} = require("../src/services/risk/stepUpReview");

const { computeRiskScore } = require("../src/services/risk/riskScore");

/* ========================================================================== */
/* QUELLE PIÈCE POUR QUEL MOTIF                                               */
/* ========================================================================== */

test("un KYC incomplet appelle une pièce d'identité", () => {
  assert.deepEqual(requiredDocumentsFor([{ code: "KYC_INSUFFICIENT" }]), ["identity"]);
});

test("un montant hors habitude appelle une justification d'origine des fonds", () => {
  assert.deepEqual(
    requiredDocumentsFor([{ code: "AMOUNT_FAR_ABOVE_CUSTOMER_HABIT" }]),
    ["source_of_funds"]
  );
});

test("une rafale appelle l'objet du paiement, pas une pièce d'identité", () => {
  // ⚠️ On demande le MINIMUM qui répond à la question posée. Réclamer trois
  // pièces à chaque dossier ferait abandonner des clients honnêtes.
  assert.deepEqual(
    requiredDocumentsFor([{ code: "VELOCITY_COUNT_BURST" }]),
    ["purpose_of_payment"]
  );
});

test("les pièces ne se répètent pas et gardent un ordre stable", () => {
  const a = requiredDocumentsFor([
    { code: "KYC_INSUFFICIENT" },
    { code: "NEW_ACCOUNT" },
    { code: "VELOCITY_COUNT_BURST" },
    { code: "NEW_BENEFICIARY" },
  ]);

  assert.deepEqual(a, ["identity", "purpose_of_payment"]);

  // Ordre d'entrée inversé : même sortie. Un dossier doit être comparable à
  // un autre, donc reproductible.
  const b = requiredDocumentsFor([
    { code: "NEW_BENEFICIARY" },
    { code: "VELOCITY_COUNT_BURST" },
    { code: "NEW_ACCOUNT" },
    { code: "KYC_INSUFFICIENT" },
  ]);

  assert.deepEqual(a, b);
});

test("NOTRE panne ne déclenche aucune demande au client", () => {
  /**
   * ⚠️ LE DÉFAUT VISÉ. `SIGNAL_UNAVAILABLE` dit que NOUS n'avons pas pu lire
   * une donnée. Réclamer une pièce d'identité parce que notre cache Redis
   * était coupé serait absurde — et la première chose qu'un client
   * raconterait autour de lui.
   */
  for (const code of MOTIFS_SANS_DEMANDE) {
    assert.deepEqual(requiredDocumentsFor([{ code }]), [], `${code} ne doit rien demander`);
  }
});

test("un code inconnu ne demande rien plutôt que n'importe quoi", () => {
  assert.deepEqual(requiredDocumentsFor([{ code: "CODE_QUI_N_EXISTE_PAS" }]), []);
  assert.deepEqual(requiredDocumentsFor(null), []);
  assert.deepEqual(requiredDocumentsFor([]), []);
});

test("toute pièce demandée appartient à la liste fermée", () => {
  // Une chaîne libre permettrait de réclamer n'importe quoi sans contrôle.
  const tous = requiredDocumentsFor(
    Object.keys(require("../src/services/risk/stepUpReview").DOCUMENTS_PAR_MOTIF).map(
      (code) => ({ code })
    )
  );

  for (const doc of tous) {
    assert.ok(REQUIRED_DOCUMENTS.includes(doc), `${doc} hors liste fermée`);
  }
});

test("la catégorie montrée au client reste grossière", () => {
  assert.equal(clientCategoryFor(["identity"]), "verification_identite");
  assert.equal(clientCategoryFor(["purpose_of_payment"]), "verification_operation");
  assert.equal(clientCategoryFor([]), "verification_complementaire");
});

/* ========================================================================== */
/* CE QUI PART VERS LE CLIENT                                                 */
/* ========================================================================== */

const tx = {
  _id: "64f0c0ffee001122",
  sender: "69dad0c0ffee1234",
  reference: "PN-A1B2C3",
  amount: 250000,
  currency: "XOF",
  recipientEmail: "mamadou@exemple.com",
};

const verdict = computeRiskScore({
  amount: 250000,
  singleTxLimit: 100000,
  velocity: { countLastHour: 9, amountLast24h: 900000, sameDestinationLast10min: 0 },
  accountAgeDays: 2,
  kycLevel: "basic",
  baseline: null,
});

test("le client ne reçoit AUCUN code de motif interne", () => {
  /**
   * ⚠️ LE TEST LE PLUS IMPORTANT DE CE FICHIER. Dire à un client quelle règle
   * s'est déclenchée lui apprend à l'éviter. Aucun établissement sérieux ne
   * le fait.
   */
  const { notification, outbox } = buildStepUpRecords({ tx, verdict });

  const versClient = JSON.stringify([notification.data, outbox.payload]);

  for (const code of verdict.reasons.map((r) => r.code)) {
    assert.ok(!versClient.includes(code), `le code ${code} ne doit pas sortir`);
  }

  assert.ok(!versClient.includes("riskScore"));
  assert.ok(!/\bscore\b/i.test(versClient));
});

test("le client ne reçoit ni montant, ni devise, ni bénéficiaire", () => {
  // ⚠️ Règle B.4 : cette charge part par e-mail ET par push. Elle traverse des
  // services tiers et atterrit sur des téléphones.
  const { notification, outbox } = buildStepUpRecords({ tx, verdict });
  const versClient = JSON.stringify([notification.data, outbox.payload]);

  for (const interdit of ["250000", "XOF", "mamadou@exemple.com"]) {
    assert.ok(!versClient.includes(interdit), `${interdit} ne doit pas sortir`);
  }
});

test("le client reçoit SA référence, la catégorie, les pièces et le délai", () => {
  // Sans quoi la notification ne lui apprend rien d'actionnable.
  const { notification } = buildStepUpRecords({ tx, verdict });

  assert.equal(notification.data.reference, "PN-A1B2C3");
  assert.ok(notification.data.category);
  assert.ok(Array.isArray(notification.data.requiredDocuments));
  assert.ok(notification.data.deadlineAt);
});

test("le dossier de l'OPÉRATEUR porte les codes, lui", () => {
  const { reviewCase } = buildStepUpRecords({ tx, verdict });

  assert.ok(reviewCase.riskReasonCodes.includes("AMOUNT_OVER_SINGLE_LIMIT"));
  assert.equal(typeof reviewCase.riskScore, "number");
});

test("le dossier ne porte NI montant NI bénéficiaire", () => {
  // Ils vivent sur la transaction, qui a ses propres gardes. Les recopier
  // créerait une seconde source de vérité financière.
  const { reviewCase } = buildStepUpRecords({ tx, verdict });
  const texte = JSON.stringify(reviewCase);

  assert.ok(!texte.includes("250000"));
  assert.ok(!texte.includes("mamadou@exemple.com"));
});

test("le dossier porte un délai explicite", () => {
  /**
   * ⚠️ Sans délai, un dossier sans réponse retient des fonds réservés
   * indéfiniment : le client ne peut ni dépenser ni récupérer son argent, et
   * personne ne s'en aperçoit parce que rien n'échoue.
   */
  const now = new Date("2026-09-23T10:00:00.000Z");
  const { reviewCase } = buildStepUpRecords({ tx, verdict, now });

  const heures = (reviewCase.deadlineAt - now) / 3600000;
  assert.equal(heures, DEFAULT_DEADLINE_HOURS);
});

test("la mise en file est idempotente par transaction", () => {
  /**
   * ⚠️ Un client qui reçoit deux fois la même demande de pièces pense à une
   * tentative d'hameçonnage — et il a raison de s'en méfier.
   */
  const a = buildStepUpRecords({ tx, verdict });
  const b = buildStepUpRecords({ tx, verdict });

  assert.equal(a.outbox.idempotencyKey, b.outbox.idempotencyKey);
  assert.match(a.outbox.idempotencyKey, /64f0c0ffee001122/);
});

test("la notification part en HIGH, jamais en CRITICAL", () => {
  // `CRITICAL` est réservé à la sécurité et à l'accès au compte : le garder
  // rare est ce qui le garde utile.
  const { outbox } = buildStepUpRecords({ tx, verdict });
  assert.equal(outbox.priority, 2);
});

/* ========================================================================== */
/* L'OUVERTURE DU DOSSIER                                                     */
/* ========================================================================== */

function collectionsFactices({ upserted = true, leve = null } = {}) {
  const ecrits = { cases: [], notifications: [], outbox: [] };

  return {
    ecrits,
    ReviewCase: {
      async updateOne(filtre, update) {
        if (leve) throw leve;
        ecrits.cases.push({ filtre, update });
        return upserted ? { upsertedCount: 1, upsertedId: "x" } : { upsertedCount: 0 };
      },
    },
    Notification: {
      async create(docs) {
        ecrits.notifications.push(...docs);
      },
    },
    NotificationOutbox: {
      async insertMany(docs) {
        ecrits.outbox.push(...docs);
      },
    },
  };
}

test("un dossier neuf : ouverture, notification et mise en file", async () => {
  const f = collectionsFactices();

  const out = await openStepUpReview({ tx, verdict, ...f });

  assert.deepEqual(out, { ok: true, created: true, error: null });
  assert.equal(f.ecrits.cases.length, 1);
  assert.equal(f.ecrits.notifications.length, 1);
  assert.equal(f.ecrits.outbox.length, 1);
});

test("un dossier DÉJÀ ouvert n'est pas réécrit et ne renotifie pas", async () => {
  /**
   * ⚠️ `$setOnInsert`, et pas `$set`. Le délai, la date d'ouverture et une
   * éventuelle décision d'opérateur doivent survivre à un rejeu : les remettre
   * à zéro rendrait du temps à un fraudeur.
   */
  const f = collectionsFactices({ upserted: false });

  const out = await openStepUpReview({ tx, verdict, ...f });

  assert.deepEqual(out, { ok: true, created: false, error: null });
  assert.equal(f.ecrits.notifications.length, 0);
  assert.equal(f.ecrits.outbox.length, 0);

  const update = f.ecrits.cases[0].update;
  assert.ok(update.$setOnInsert, "le dossier doit s'écrire en $setOnInsert");
  assert.ok(!update.$set, "aucun $set : un dossier ouvert ne se réécrit pas");
});

test("une panne d'écriture ne lève JAMAIS — mais elle se voit", async () => {
  /**
   * ⚠️ Appelée après le commit : lever ici rendrait un 500 pour un virement
   * réussi, ce qui pousserait le client à rejouer. Et se taire laisserait un
   * virement retenu sans que personne ne sache pourquoi (règle B.1).
   */
  const f = collectionsFactices({ leve: new Error("mongo indisponible") });
  const erreurs = [];

  const out = await openStepUpReview({
    tx,
    verdict,
    ...f,
    logger: { error: (m, d) => erreurs.push({ m, d }) },
  });

  assert.equal(out.ok, false);
  assert.equal(erreurs.length, 1);
  assert.equal(erreurs[0].d.marqueur, "REVIEW_CASE_LOST");
});

test("le journal d'échec ne divulgue ni montant ni bénéficiaire", async () => {
  const f = collectionsFactices({ leve: new Error("mongo indisponible") });
  const erreurs = [];

  await openStepUpReview({
    tx,
    verdict,
    ...f,
    logger: { error: (m, d) => erreurs.push(JSON.stringify(d)) },
  });

  assert.ok(!erreurs[0].includes("250000"));
  assert.ok(!erreurs[0].includes("mamadou@exemple.com"));
});

test("sans transaction ni titulaire, rien n'est écrit", async () => {
  const f = collectionsFactices();

  const out = await openStepUpReview({ tx: {}, verdict, ...f });

  assert.equal(out.ok, false);
  assert.equal(f.ecrits.cases.length, 0);
});

test("un verdict absent n'empêche pas d'ouvrir le dossier", async () => {
  /**
   * ⚠️ Le verdict voyage sur `req` : s'il manque, le virement est QUAND MÊME
   * en `pending_review`. Ne pas ouvrir de dossier le laisserait retenu sans
   * que personne ne sache qu'il attend quelque chose.
   */
  const f = collectionsFactices();

  const out = await openStepUpReview({ tx, verdict: null, ...f });

  assert.equal(out.ok, true);
  assert.equal(f.ecrits.cases.length, 1);
});

/* ========================================================================== */
/* LE DÉPÔT DU CLIENT, LA DÉCISION, L'ÉCHÉANCE                                */
/* ========================================================================== */

const {
  OPERATOR_DECISIONS,
  recordCustomerSubmission,
  recordOperatorDecision,
  expireOverdueCases,
} = require("../src/services/risk/stepUpReview");

function dossierFactice({ modifie = 1, leve = null, trouves = [] } = {}) {
  const appels = [];

  return {
    appels,
    ReviewCase: {
      async updateOne(filtre, update) {
        if (leve) throw leve;
        appels.push({ op: "updateOne", filtre, update });
        return { modifiedCount: modifie };
      },
      async updateMany(filtre, update) {
        if (leve) throw leve;
        appels.push({ op: "updateMany", filtre, update });
        return { modifiedCount: trouves.length };
      },
      find(filtre) {
        appels.push({ op: "find", filtre });
        return {
          limit(n) {
            appels.push({ op: "limit", n });
            return { lean: async () => (leve ? Promise.reject(leve) : trouves) };
          },
        };
      },
    },
  };
}

test("le dépôt du client ne rouvre QUE les dossiers en attente de lui", async () => {
  /**
   * ⚠️ LE DÉFAUT VISÉ : sans ce filtre, un client pourrait rouvrir un dossier
   * déjà tranché en renvoyant un document — donc remettre indéfiniment une
   * décision en cause.
   */
  const f = dossierFactice();
  await recordCustomerSubmission({ transactionId: "T1", ...f });

  assert.equal(f.appels[0].filtre.status, "awaiting_customer");
  assert.equal(f.appels[0].update.$set.status, "awaiting_operator");
});

test("aucune pièce n'est stockée dans le dossier", async () => {
  // ⚠️ Le contenu d'une pièce d'identité est une donnée KYC : il vit dans le
  // circuit KYC, qui a ses propres gardes. Le dupliquer ici créerait une
  // seconde surface à protéger.
  const f = dossierFactice();
  await recordCustomerSubmission({ transactionId: "T1", ...f });

  const champs = Object.keys(f.appels[0].update.$set);
  assert.deepEqual(champs.sort(), ["status", "submittedAt"]);
});

test("une décision sans auteur est refusée", async () => {
  // Une décision sans auteur n'est pas auditable, et c'est la première chose
  // qu'un contrôle réclame.
  const f = dossierFactice();

  const out = await recordOperatorDecision({
    transactionId: "T1",
    decision: "approved",
    operatorId: "",
    ...f,
  });

  assert.equal(out.ok, false);
  assert.match(out.error, /auteur/);
  assert.equal(f.appels.length, 0);
});

test("une issue inventée est refusée", async () => {
  const f = dossierFactice();

  const out = await recordOperatorDecision({
    transactionId: "T1",
    decision: "peut_etre",
    operatorId: "staff-1",
    ...f,
  });

  assert.equal(out.ok, false);
  assert.equal(f.appels.length, 0);
  assert.deepEqual([...OPERATOR_DECISIONS], ["approved", "rejected"]);
});

test("une seconde décision n'écrase pas la première", async () => {
  /**
   * ⚠️ Sans ce filtre d'état, l'identité du véritable décideur disparaîtrait
   * du dossier — remplacée par celle du dernier passant.
   */
  const f = dossierFactice();

  await recordOperatorDecision({
    transactionId: "T1",
    decision: "approved",
    operatorId: "staff-1",
    ...f,
  });

  assert.deepEqual(f.appels[0].filtre.status.$in, [
    "awaiting_customer",
    "awaiting_operator",
  ]);
});

test("la décision enregistre son auteur et sa date", async () => {
  const f = dossierFactice();
  const now = new Date("2026-09-23T12:00:00.000Z");

  await recordOperatorDecision({
    transactionId: "T1",
    decision: "rejected",
    operatorId: "staff-7",
    note: "pièce illisible",
    now,
    ...f,
  });

  const set = f.appels[0].update.$set;
  assert.equal(set.status, "rejected");
  assert.equal(set.decidedBy, "staff-7");
  assert.equal(set.decidedAt, now);
});

test("la note d'opérateur est bornée en longueur", async () => {
  // Un champ de texte libre non borné dans une collection financière finit
  // par contenir des copier-coller de pièces d'identité.
  const f = dossierFactice();

  await recordOperatorDecision({
    transactionId: "T1",
    decision: "approved",
    operatorId: "staff-1",
    note: "x".repeat(5000),
    ...f,
  });

  assert.equal(f.appels[0].update.$set.operatorNote.length, 2000);
});

test("le balayage des échus est BORNÉ", async () => {
  /**
   * ⚠️ Un balayage non borné sur une collection qui a grossi pendant un
   * incident bloquerait la base au pire moment possible.
   */
  const f = dossierFactice({ trouves: [{ _id: "a" }, { _id: "b" }] });

  const out = await expireOverdueCases({ limit: 50, ...f });

  assert.equal(out.expired, 2);
  assert.ok(f.appels.some((a) => a.op === "limit" && a.n === 50));
});

test("le balayage ne touche QUE les dossiers encore ouverts et échus", async () => {
  const f = dossierFactice({ trouves: [{ _id: "a" }] });
  const now = new Date("2026-09-23T12:00:00.000Z");

  await expireOverdueCases({ now, ...f });

  const filtre = f.appels[0].filtre;
  assert.deepEqual(filtre.status.$in, ["awaiting_customer", "awaiting_operator"]);
  assert.equal(filtre.deadlineAt.$lte, now);
  // Un dossier sans délai ne doit jamais expirer tout seul.
  assert.equal(filtre.deadlineAt.$ne, null);
});

test("aucun dossier échu : aucune écriture", async () => {
  const f = dossierFactice({ trouves: [] });

  const out = await expireOverdueCases({ ...f });

  assert.equal(out.expired, 0);
  assert.ok(!f.appels.some((a) => a.op === "updateMany"));
});

test("une panne de balayage ne lève jamais", async () => {
  const f = dossierFactice({ leve: new Error("mongo indisponible") });

  const out = await expireOverdueCases({ ...f });

  assert.equal(out.ok, false);
  assert.equal(out.expired, 0);
});
