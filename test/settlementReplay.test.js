"use strict";

/**
 * ============================================================================
 * REJEU DES RÈGLEMENTS — F.4
 * ============================================================================
 *
 * Ce module DÉPLACE DE L'ARGENT. Les tests portent donc moins sur ce qu'il fait
 * que sur ce qu'il REFUSE de faire : rejouer sans identifiant, rejouer sans fin,
 * rejouer un événement qu'une autre instance tient déjà, rejouer aussitôt après
 * un échec.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const {
  MAX_ATTEMPTS,
  REASONS,
  backoffFor,
  hasUsableIdentifier,
  isReplayable,
} = require("../src/services/settlement/settlementReplayRules");

const { LEASE_MS } = require("../src/services/webhooks/webhookIdempotency");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse("2026-08-26T12:00:00.000Z");

const ago = (ms) => new Date(NOW - ms);
const opts = { now: NOW, leaseMs: LEASE_MS, maxAttempts: MAX_ATTEMPTS };

const charge = { reference: "TX-1", providerStatus: "SUCCESS" };

/* -------------------------------------------------------------------------- */
/* Ce qu'on refuse de rejouer                                                 */
/* -------------------------------------------------------------------------- */

test("un événement déjà traité n'est jamais rejoué", () => {
  const out = isReplayable({ status: "processed", payload: charge }, opts);

  assert.equal(out.eligible, false);
  assert.equal(out.reason, REASONS.ALREADY_PROCESSED);
});

test("sans identifiant exploitable, on n'essaie même pas", () => {
  /**
   * Le règlement lèverait un 404 à chaque tour et brûlerait les cinq
   * tentatives sans rien apprendre. C'est un événement à examiner, pas à
   * rejouer.
   */
  const out = isReplayable(
    { status: "failed", payload: { providerStatus: "SUCCESS" }, updatedAt: ago(3 * HOUR) },
    opts
  );

  assert.equal(out.eligible, false);
  assert.equal(out.reason, REASONS.NO_IDENTIFIER);
});

test("une charge absente est traitée comme sans identifiant, pas comme une erreur", () => {
  for (const payload of [null, undefined, {}, "texte"]) {
    assert.equal(hasUsableIdentifier(payload), false, String(payload));
  }
});

test("les trois identifiants sont acceptés indifféremment", () => {
  assert.equal(hasUsableIdentifier({ transactionId: "abc" }), true);
  assert.equal(hasUsableIdentifier({ reference: "TX-1" }), true);
  assert.equal(hasUsableIdentifier({ providerReference: "P-1" }), true);
});

test("le nombre de tentatives est BORNÉ — pas de martèlement du chemin de l'argent", () => {
  /**
   * Un événement qui échoue à cause d'un défaut de code échouerait à chaque
   * tour. Passé le compte, le silence est plus utile que l'insistance : la
   * réconciliation le signale, un humain tranche.
   */
  const out = isReplayable(
    { status: "failed", payload: charge, attempts: MAX_ATTEMPTS, updatedAt: ago(10 * HOUR) },
    opts
  );

  assert.equal(out.eligible, false);
  assert.equal(out.reason, REASONS.EXHAUSTED);
});

test("un bail encore valide interdit la reprise", () => {
  /**
   * Une autre instance travaille dessus. Le lui prendre fabriquerait la course
   * qu'on cherche justement à éviter.
   */
  const out = isReplayable(
    { status: "processing", payload: charge, startedAt: ago(MINUTE) },
    opts
  );

  assert.equal(out.eligible, false);
  assert.equal(out.reason, REASONS.LEASE_ACTIVE);
});

test("un échec tout frais attend son tour — le repli croît", () => {
  const out = isReplayable(
    { status: "failed", payload: charge, attempts: 1, updatedAt: ago(MINUTE) },
    opts
  );

  assert.equal(out.eligible, false);
  assert.equal(out.reason, REASONS.BACKOFF);
});

test("un statut inconnu n'est jamais rejoué par défaut", () => {
  // La règle ne dit jamais « oui » faute de mieux.
  const out = isReplayable({ status: "quelque_chose", payload: charge }, opts);

  assert.equal(out.eligible, false);
  assert.equal(out.reason, REASONS.UNKNOWN_STATUS);
});

test("un enregistrement absent ou sans date ne lève pas", () => {
  assert.equal(isReplayable(null, opts).eligible, false);
  assert.equal(isReplayable({ status: "processing", payload: charge }, opts).eligible, false);
  assert.equal(isReplayable({ status: "failed", payload: charge }, opts).eligible, false);
});

/* -------------------------------------------------------------------------- */
/* Ce qu'on rejoue                                                            */
/* -------------------------------------------------------------------------- */

test("un bail expiré est rejouable : le processus qui le tenait est mort", () => {
  const out = isReplayable(
    { status: "processing", payload: charge, startedAt: ago(2 * HOUR) },
    opts
  );

  assert.equal(out.eligible, true);
  assert.equal(out.reason, REASONS.OK);
});

test("un échec passé le repli est rejouable", () => {
  const out = isReplayable(
    { status: "failed", payload: charge, attempts: 1, updatedAt: ago(HOUR) },
    opts
  );

  assert.equal(out.eligible, true);
});

test("le repli double à chaque tentative et reste plafonné", () => {
  assert.equal(backoffFor(1), 5 * MINUTE);
  assert.equal(backoffFor(2), 10 * MINUTE);
  assert.equal(backoffFor(3), 20 * MINUTE);
  assert.equal(backoffFor(10), 2 * HOUR, "plafonné pour rester utile");
  assert.equal(backoffFor(0), 5 * MINUTE, "une valeur absurde retombe sur la base");
});

test("la quatrième tentative attend plus longtemps que la première", () => {
  const recent = { status: "failed", payload: charge, attempts: 4, updatedAt: ago(20 * MINUTE) };
  assert.equal(isReplayable(recent, opts).reason, REASONS.BACKOFF);

  const ancien = { ...recent, updatedAt: ago(3 * HOUR) };
  assert.equal(isReplayable(ancien, opts).eligible, true);
});

/* -------------------------------------------------------------------------- */
/* Le câblage — ce qu'aucun test unitaire ne couvre                            */
/* -------------------------------------------------------------------------- */

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const REJEU = stripComments(
  fs.readFileSync(require.resolve("../src/services/settlement/settlementReplay"), "utf8")
);

test("le rejeu appelle LE MÊME moteur que le rappel direct", () => {
  /**
   * Une seconde implémentation du règlement serait une seconde façon de
   * créditer un bénéficiaire — donc un second risque de double crédit. Et elle
   * divergerait, comme divergent toujours deux copies d'une même règle.
   */
  assert.match(REJEU, /require\("\.\.\/\.\.\/controllers\/externalSettlementController"\)/);
  assert.match(REJEU, /await settleExternalTransaction\(repris\.payload\)/);
});

test("la reprise est ATOMIQUE et reprend la condition d'éligibilité", () => {
  /**
   * Sans la condition répétée dans le filtre, deux instances constatant
   * simultanément qu'un événement est rejouable le reprendraient toutes deux.
   */
  const bloc = REJEU.slice(
    REJEU.indexOf("async function takeForReplay"),
    REJEU.indexOf("async function markProcessed")
  );

  assert.match(bloc, /findOneAndUpdate/);
  assert.match(bloc, /status: "failed"/);
  assert.match(bloc, /startedAt: \{ \$lte:/);
  assert.match(bloc, /\$inc: \{ attempts: 1 \}/);
});

test("on marque APRÈS le règlement, jamais avant", () => {
  const iReglement = REJEU.lastIndexOf("await settleExternalTransaction(repris.payload)");
  const iMarque = REJEU.lastIndexOf("await markProcessed(repris._id");

  assert.ok(iReglement > 0 && iMarque > 0, "ancres introuvables");
  assert.ok(iReglement < iMarque);
});

test("le worker de rejeu est DÉSACTIVÉ par défaut", () => {
  /**
   * Un travail de fond qui déplace de l'argent ne s'allume pas tout seul au
   * premier déploiement. C'est la propriété la plus importante du fichier.
   */
  assert.match(
    REJEU,
    /SETTLEMENT_REPLAY_WORKER \?\? "false"/,
    "le défaut doit être `false`, pas `true`"
  );
});

test("le rejeu tourne sous verrou distribué", () => {
  assert.match(REJEU, /withCronLock\(/);
  assert.match(REJEU, /JOB_NAME/);
});

test("la charge stockée par le registre suffit au règlement", () => {
  /**
   * ⚠️ COUPLAGE SUBTIL, VERROUILLÉ ICI.
   *
   * Le registre ne conserve plus le corps brut du prestataire (il portait le
   * numéro et le nom du bénéficiaire). Le rejeu part donc de la charge
   * NORMALISÉE seule. Si quelqu'un fait un jour dépendre le règlement d'un
   * champ qui ne vit que dans `raw`, le rejeu divergerait silencieusement du
   * rappel direct.
   *
   * Ce test fige la liste : tout champ que le moteur lit doit être conservé.
   */
  const {
    STORED_PAYLOAD_FIELDS,
  } = require("../src/services/webhooks/webhookEventStore");

  for (const champ of [
    "transactionId",
    "reference",
    "providerReference",
    "providerStatus",
    "status",
    "eventId",
    "amount",
    "currency",
  ]) {
    assert.ok(
      STORED_PAYLOAD_FIELDS.includes(champ),
      `${champ} est lu par le moteur de règlement : il doit être conservé`
    );
  }
});

test("le moteur lit `status` et `providerStatus`, tous deux conservés", () => {
  const MOTEUR = stripComments(
    fs.readFileSync(
      require.resolve("../src/controllers/externalSettlementController"),
      "utf8"
    )
  );

  const bloc = MOTEUR.slice(
    MOTEUR.indexOf("function mapProviderState"),
    MOTEUR.indexOf("function normalizeProviderReference")
  );

  assert.match(bloc, /payload\.status/);
  assert.match(bloc, /payload\.providerStatus/);
});
