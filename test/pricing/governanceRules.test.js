"use strict";

/**
 * ── Déplacé depuis l'API Gateway le 2026-09-10 ──────────────────────────────
 *
 * Ce test suit le code qu'il protège. Le laisser dans la passerelle en aurait
 * fait un test de code MORT : il aurait continué à passer, en donnant
 * l'impression de couvrir la tarification, pendant que la tarification réelle
 * — celle de Tx-Core — n'aurait été couverte par rien.
 *
 * C'est exactement le défaut trouvé le 2026-09-09 sur le chemin de l'argent des
 * cagnottes : un garde-fou qui ne couvre qu'un dépôt sur deux protège la moitié
 * du chemin en donnant l'impression de le protéger entièrement.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  assertCanApprove,
  assertVersionMatches,
  isSameActor,
} = require("../../src/services/pricing/governanceRules");

const REQUESTER = { staffId: "aaaaaaaaaaaaaaaaaaaaaaaa", email: "a@pn.io", name: "Alice" };
const OTHER = { _id: "bbbbbbbbbbbbbbbbbbbbbbbb", email: "b@pn.io", role: "admin" };
const SAME = { _id: "aaaaaaaaaaaaaaaaaaaaaaaa", email: "a@pn.io", role: "admin" };
const SUPER = { _id: "aaaaaaaaaaaaaaaaaaaaaaaa", email: "a@pn.io", role: "superadmin" };

/**
 * `assert.throws` de Node renvoie `undefined` : il ne donne pas accès à
 * l'erreur levée. Or ici le `status` HTTP fait partie du contrat testé.
 */
function catchError(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }

  assert.fail("Aucune erreur levée alors qu'une erreur était attendue.");
}

function pendingRequest(overrides = {}) {
  return {
    _id: "req1",
    status: "pending_approval",
    requestedBy: REQUESTER,
    baseVersion: 3,
    ...overrides,
  };
}

test("un second valideur peut approuver", () => {
  assert.doesNotThrow(() =>
    assertCanApprove({ request: pendingRequest(), actor: OTHER, breakGlass: null })
  );
});

test("le demandeur ne peut pas approuver sa propre demande", () => {
  const err = catchError(() =>
    assertCanApprove({ request: pendingRequest(), actor: SAME, breakGlass: null })
  );
  assert.equal(err.status, 403);
  assert.match(err.message, /demandeur/i);
});

test("un admin ne peut pas invoquer le break-glass", () => {
  const err = catchError(() =>
    assertCanApprove({
      request: pendingRequest(),
      actor: SAME,
      breakGlass: { used: true, reason: "incident de production" },
    })
  );
  assert.equal(err.status, 403);
  assert.match(err.message, /superadmin/i);
});

test("un superadmin ne peut pas invoquer le break-glass sans motif", () => {
  const err = catchError(() =>
    assertCanApprove({
      request: pendingRequest(),
      actor: SUPER,
      breakGlass: { used: true, reason: "   " },
    })
  );
  assert.equal(err.status, 403);
  assert.match(err.message, /motif/i);
});

test("un superadmin avec motif peut approuver sa propre demande", () => {
  assert.doesNotThrow(() =>
    assertCanApprove({
      request: pendingRequest(),
      actor: SUPER,
      breakGlass: { used: true, reason: "Corridor bloqué un dimanche, seul admin joignable." },
    })
  );
});

test("une demande déjà traitée ne peut plus être approuvée", () => {
  const err = catchError(() =>
    assertCanApprove({
      request: pendingRequest({ status: "applied" }),
      actor: OTHER,
      breakGlass: null,
    })
  );
  assert.equal(err.status, 409);
});

test("la version de base doit encore correspondre", () => {
  assert.doesNotThrow(() =>
    assertVersionMatches({ request: pendingRequest(), rule: { currentVersion: 3 } })
  );

  const err = catchError(() =>
    assertVersionMatches({ request: pendingRequest(), rule: { currentVersion: 4 } })
  );
  assert.equal(err.status, 409);
  assert.match(err.message, /modifiée depuis/i);
});

test("une création n'a pas de version de base à contrôler", () => {
  assert.doesNotThrow(() =>
    assertVersionMatches({
      request: pendingRequest({ baseVersion: null }),
      rule: null,
    })
  );
});

test("isSameActor compare les identifiants quelle que soit leur forme", () => {
  assert.equal(isSameActor({ staffId: "abc" }, { _id: "abc" }), true);
  assert.equal(isSameActor({ staffId: "abc" }, { id: "abc" }), true);
  assert.equal(isSameActor({ staffId: "abc" }, { _id: "def" }), false);
  assert.equal(isSameActor(null, { _id: "abc" }), false);
});
