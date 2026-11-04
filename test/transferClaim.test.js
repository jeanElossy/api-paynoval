"use strict";

/**
 * Réclamation d'un transfert par son destinataire (2026-11-04).
 *
 * Un transfert PayNoval → portefeuille mobile money ou carte partait chez le
 * prestataire dès l'envoi : la question de sécurité était exigée, hachée, et
 * jamais vérifiée. Le destinataire doit désormais fournir le code SMS ET la
 * réponse ; l'argent ne part qu'après, sous verrou.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const rules = require("../src/services/transferClaims/claimRules");

const src = (rel) => fs.readFileSync(path.join(__dirname, "..", "src", rel), "utf8");

/* ------------------------------------------------------------------ règles */

test("jeton : 256 bits d'aléa, seule son empreinte est stockée", () => {
  const a = rules.newClaimToken();
  const b = rules.newClaimToken();
  assert.notEqual(a, b);
  assert.equal(rules.isWellFormedToken(a), true);
  assert.equal(a.length, 43);
  assert.match(rules.hashClaimToken(a), /^[0-9a-f]{64}$/);
  assert.notEqual(rules.hashClaimToken(a), a);
  for (const bad of ["", "abc", "x".repeat(42), "x".repeat(44), "a/b".padEnd(43, "c")]) {
    assert.equal(rules.isWellFormedToken(bad), false, bad);
  }
});

test("code SMS : six chiffres, tiré par un générateur cryptographique", () => {
  for (let i = 0; i < 50; i += 1) assert.match(rules.newOtp(), /^\d{6}$/);
  assert.equal(rules.newOtp(() => 42), "000042");
  assert.equal(rules.isWellFormedOtp("12345"), false);
  assert.equal(rules.isWellFormedOtp("12a456"), false);
});

test("numéro E.164 d'un destinataire de carte (Europe, Amérique)", () => {
  assert.equal(rules.normalizeE164("+33 6 12 34 56 78"), "+33612345678");
  assert.equal(rules.normalizeE164("+1 (514) 555-0100"), "+15145550100");
  for (const bad of ["0612345678", "+0612345678", "+12", "", null]) assert.equal(rules.normalizeE164(bad), null, String(bad));
  assert.equal(rules.phoneLast4("+33612345678"), "5678");
});

test("le lien se ferme avec la transaction, quel que soit son propre état", () => {
  const open = { status: "open", expiresAt: new Date(Date.now() + 60_000) };
  assert.equal(rules.claimBlocker({ claim: open, txStatus: "pending" }), null);
  assert.equal(rules.claimBlocker({ claim: open, txStatus: "cancelled" }), "CLAIM_CLOSED");
  assert.equal(rules.claimBlocker({ claim: open, txStatus: "processing" }), "CLAIM_CLOSED");
  assert.equal(rules.claimBlocker({ claim: open, txStatus: "pending_review" }), "CLAIM_UNDER_REVIEW");
  assert.equal(rules.claimBlocker({ claim: { ...open, status: "claimed" }, txStatus: "pending" }), "CLAIM_ALREADY_USED");
  assert.equal(rules.claimBlocker({ claim: { ...open, status: "locked" }, txStatus: "pending" }), "CLAIM_LOCKED");
  assert.equal(rules.claimBlocker({ claim: { ...open, status: "refused" }, txStatus: "pending" }), "CLAIM_REFUSED");
  assert.equal(rules.claimBlocker({ claim: { ...open, expiresAt: new Date(Date.now() - 1) }, txStatus: "pending" }), "CLAIM_EXPIRED");
  assert.equal(rules.claimBlocker({ claim: null, txStatus: "pending" }), "CLAIM_NOT_FOUND");
});

test("envois de code bornés : une minute d'écart, cinq au plus", () => {
  const now = Date.now();
  assert.equal(rules.otpSendBlocker({ claim: { otpSendCount: 0 }, now }), null);
  assert.equal(rules.otpSendBlocker({ claim: { otpSendCount: 1, otpLastSentAt: new Date(now - 30_000) }, now }), "OTP_COOLDOWN");
  assert.equal(rules.otpSendBlocker({ claim: { otpSendCount: 1, otpLastSentAt: new Date(now - 61_000) }, now }), null);
  assert.equal(rules.otpSendBlocker({ claim: { otpSendCount: 5 }, now }), "OTP_SEND_LIMIT");
});

test("essais : trois échecs au plus (décision du 2026-11-04), et le code expire en dix minutes", () => {
  assert.equal(rules.MAX_FAILED_ATTEMPTS, 3);
  assert.equal(rules.remainingAfterFailure(0), 2);
  assert.equal(rules.remainingAfterFailure(2), 0);
  const now = Date.now();
  assert.equal(rules.otpExpired({ claim: { otpHash: "x", otpExpiresAt: new Date(now + 1000) }, now }), false);
  assert.equal(rules.otpExpired({ claim: { otpHash: "x", otpExpiresAt: new Date(now - 1) }, now }), true);
  assert.equal(rules.otpExpired({ claim: { otpHash: null }, now }), true);
});

test("le destinataire ne voit que le prénom de l'expéditeur", () => {
  assert.equal(rules.firstNameOf("Awa Koné Diallo"), "Awa");
  assert.equal(rules.firstNameOf(""), "");
});

/* --------------------------------------------------------- deux preuves */

test("il faut le code ET la réponse : l'un sans l'autre ne libère rien", () => {
  const { hashSecurityAnswer } = require("../src/services/transactions/shared/helpers");
  const { _proofsMatch } = require("../src/services/transferClaims/claimService");
  const now = Date.now();
  const claim = { otpHash: hashSecurityAnswer("123456"), otpExpiresAt: new Date(now + 60_000) };
  const tx = { securityAnswerHash: hashSecurityAnswer("bleu") };

  assert.equal(_proofsMatch({ claim, tx, answer: "bleu", code: "123456", now }), true);
  assert.equal(_proofsMatch({ claim, tx, answer: "rouge", code: "123456", now }), false);
  assert.equal(_proofsMatch({ claim, tx, answer: "bleu", code: "654321", now }), false);
  assert.equal(_proofsMatch({ claim, tx, answer: "bleu", code: "", now }), false);
  // Code expiré : refusé même juste.
  assert.equal(_proofsMatch({ claim: { ...claim, otpExpiresAt: new Date(now - 1) }, tx, answer: "bleu", code: "123456", now }), false);
  // Transaction sans réponse enregistrée : jamais acceptée.
  assert.equal(_proofsMatch({ claim, tx: {}, answer: "", code: "123456", now }), false);
});

/* ------------------------------------------------- gardes sur le code source */

test("initiation : le lien naît dans la transaction de la réserve, le prestataire n'est pas appelé", () => {
  const s = src("services/transactions/handlers/initiateExternalTransactions.js");
  const reserve = s.indexOf("tx.fundsReserved = true;");
  const create = s.indexOf("claimToken = await claimService.createClaim({");
  assert.ok(reserve > -1 && create > reserve, "le lien est créé après la réserve, dans la même unité");
  assert.match(s, /if \(claimToken\) \{[\s\S]*?sendLinkAfterCommit[\s\S]*?\} else \{[\s\S]*?submitExternalExecution/);
  // Refus AVANT toute réserve sans numéro ni base de lien.
  assert.ok(s.indexOf('code: "RECIPIENT_PHONE_REQUIRED"') < reserve);
  assert.ok(s.indexOf('code: "CLAIM_LINK_UNCONFIGURED"') < reserve);
});

test("l'expéditeur ne confirme plus lui-même un transfert vers un tiers", () => {
  assert.match(src("services/transactions/handlers/confirmTransaction.js"), /CONFIRM_BY_RECIPIENT_LINK/);
});

test("aucun versement non réclamé ne part chez le prestataire, quel que soit l'appelant", () => {
  const s = src("services/transactions/handlers/submitExternalExecution.js");
  const guard = s.indexOf('if (tx.providerStatus === "AWAITING_RECIPIENT_CLAIM")');
  const call = s.indexOf("await resolved.execute(");
  assert.ok(guard > -1 && guard < call);
});

test("réclamation : preuves vérifiées, PUIS verrou conditionnel, PUIS versement", () => {
  const s = src("services/transferClaims/claimService.js");
  const fn = s.slice(s.indexOf("async function claim({"));
  const proofs = fn.indexOf("proofsMatch(");
  const lock = fn.indexOf('status: "pending",\n      providerStatus: "AWAITING_RECIPIENT_CLAIM"');
  const release = fn.indexOf("await release(");
  assert.ok(proofs > -1 && lock > proofs && release > lock);
  assert.match(fn, /status: "processing", providerStatus: "CLAIMED_BY_RECIPIENT"/);
  // `release` relit l'état et refuse s'il a changé (annulation passée entre-temps).
  assert.match(s, /current\?\.status !== "processing" \|\| current\?\.providerStatus !== "CLAIMED_BY_RECIPIENT"/);
});

test("une annulation est refusée une fois le versement accepté", () => {
  assert.match(src("services/transactions/handlers/cancelTransaction.js"), /tx\.providerStatus === "CLAIMED_BY_RECIPIENT"[\s\S]{0,200}ALREADY_CLAIMED/);
});

test("jeton, code et réponse ne sont jamais journalisés ni renvoyés hors simulation", () => {
  const s = src("services/transferClaims/claimService.js");
  for (const m of s.matchAll(/logger\.(?:error|warn|info)\(([\s\S]*?)\);/g)) {
    // Les variables elles-mêmes (pas une propriété comme `err.code`).
    assert.doesNotMatch(m[1], /(?<![.\w])(token|code|answer|otp)\b/, m[1].slice(0, 80));
  }
  // Le code n'est rendu qu'en simulation.
  assert.match(s, /\.\.\.\(sandbox \? \{ sandboxCode: code \} : \{\}\)/);
  assert.match(src("models/TransferClaim.js"), /sandboxOtp interdit hors simulation/);
});
