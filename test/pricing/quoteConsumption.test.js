"use strict";

/**
 * ============================================================================
 * LE DEVIS ENGAGE LE PRIX — ET IL NE S'UTILISE QU'UNE FOIS
 * ============================================================================
 *
 * ── Le défaut que ces tests figent ──────────────────────────────────────────
 *
 * `lockQuote` écrivait un `PricingQuote`, et RIEN ne le relisait : l'initiation
 * recalculait le prix, `quoteId` n'était qu'une métadonnée. Le verrou de prix
 * ne verrouillait rien, et l'utilisateur pouvait voir un montant puis en
 * recevoir un autre — sans qu'aucune ligne de journal ne le signale.
 *
 * ── La propriété la moins évidente, et la plus importante ───────────────────
 *
 * Un devis qui ne correspond PAS à la demande ne doit pas être consommé. La
 * tentation est de consommer d'abord et de comparer ensuite : une divergence
 * brûlerait alors un devis valide, et l'utilisateur perdrait son prix à cause
 * d'une erreur d'appel. Les champs engageants sont donc dans le FILTRE.
 *
 * Le test « un devis non conforme n'est pas brûlé » est celui qui tombe si
 * quelqu'un réintroduit l'ordre naïf.
 *
 * Tests **purs** : aucun serveur, aucune connexion. Le modèle est injecté.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CHAMPS_ENGAGEANTS,
  comparerRequete,
  construireFiltreConsommation,
  diagnostiquerEchec,
  devisEstExige,
  regimeDevis,
} = require("../../src/services/pricing/quoteConsumption");

const { consumeQuote } = require("../../src/services/pricing/quoteService");

const MAINTENANT = new Date("2026-09-16T12:00:00Z");

const REQUETE = Object.freeze({
  txType: "TRANSFER",
  method: "INTERNAL",
  amount: 10000,
  fromCurrency: "XOF",
  toCurrency: "XOF",
  country: "CI",
  fromCountry: "CI",
  toCountry: "CI",
  provider: "paynoval",
  operator: null,
});

/**
 * ⚠️ L'EXPIRATION S'ANCRE SUR L'HORLOGE COURANTE, JAMAIS SUR UNE DATE FIGÉE.
 *
 * Première version : `MAINTENANT.getTime() + 5 min`, avec `MAINTENANT` fixé au
 * 2026-09-16 à 12 h 00 UTC. Or `consumeQuote` lit l'horloge RÉELLE — ces tests
 * ne passaient donc que pendant les cinq minutes suivant midi, et ont commencé
 * à échouer en `QUOTE_EXPIRED` une heure plus tard, le jour même de leur
 * écriture.
 *
 * Une date en dur dans une fixture d'expiration est une bombe à retardement :
 * le test finit par échouer sans qu'aucune ligne de code n'ait bougé, et le
 * prochain lecteur cherche un défaut dans le produit.
 *
 * `MAINTENANT` reste utilisé par les tests de diagnostic PURS, à qui l'on passe
 * explicitement l'horloge — là, une date figée est au contraire ce qu'il faut.
 */
const DANS_CINQ_MINUTES = () => new Date(Date.now() + 5 * 60 * 1000);

function devisActif(overrides = {}) {
  return {
    quoteId: "q-1",
    userId: "u-1",
    status: "ACTIVE",
    expiresAt: DANS_CINQ_MINUTES(),
    request: { ...REQUETE },
    result: {
      grossFrom: 10000,
      fee: 100,
      netFrom: 9900,
      netTo: 9900,
      appliedRate: 1,
      marketRate: null,
    },
    usedAt: null,
    usedByReference: null,
    usedByIdempotencyKey: null,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Un modèle Mongo minimal, qui honore réellement le filtre                    */
/* -------------------------------------------------------------------------- */

/**
 * Sans cette petite évaluation de filtre, le faux modèle accepterait tout et
 * les tests passeraient à vide — exactement le défaut trouvé sur le détecteur
 * de réseau de `pricingIsInProcess.test.js`.
 */
function correspond(doc, filtre) {
  for (const [cle, attendu] of Object.entries(filtre)) {
    const valeur = cle.startsWith("request.")
      ? doc.request?.[cle.slice("request.".length)]
      : doc[cle];

    if (attendu && typeof attendu === "object" && !(attendu instanceof Date)) {
      if ("$gt" in attendu) {
        if (!(new Date(valeur).getTime() > new Date(attendu.$gt).getTime())) {
          return false;
        }
        continue;
      }

      if ("$in" in attendu) {
        const normalisee = valeur === undefined ? null : valeur;
        if (!attendu.$in.includes(normalisee)) return false;
        continue;
      }
    }

    if (String(valeur ?? "") !== String(attendu ?? "")) return false;
  }

  return true;
}

function fauxModele(doc) {
  const etat = { doc };

  return {
    etat,

    async findOneAndUpdate(filtre, update) {
      if (!etat.doc || !correspond(etat.doc, filtre)) return null;

      etat.doc = { ...etat.doc, ...update.$set };
      return etat.doc;
    },

    findOne(requete) {
      const trouve =
        etat.doc && etat.doc.quoteId === requete.quoteId ? etat.doc : null;

      return { lean: async () => trouve };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Comparaison des paramètres                                                 */
/* -------------------------------------------------------------------------- */

test("le montant fait partie des champs engageants", () => {
  assert.ok(CHAMPS_ENGAGEANTS.includes("amount"));
  assert.ok(CHAMPS_ENGAGEANTS.includes("fromCurrency"));
  assert.ok(CHAMPS_ENGAGEANTS.includes("toCurrency"));
});

test("une demande identique ne présente aucune différence", () => {
  assert.deepEqual(comparerRequete(REQUETE, { ...REQUETE }), {
    ok: true,
    differences: [],
  });
});

test("un montant différent est signalé nommément", () => {
  const out = comparerRequete(REQUETE, { ...REQUETE, amount: 1000000 });

  assert.equal(out.ok, false);
  assert.equal(out.differences[0].champ, "amount");
});

test("« non précisé » s'écrit null, undefined ou chaîne vide, sans différence", () => {
  const out = comparerRequete(
    { ...REQUETE, operator: null },
    { ...REQUETE, operator: "" }
  );

  assert.equal(out.ok, true);
});

test("la casse d'une devise ne crée pas de divergence", () => {
  const out = comparerRequete(REQUETE, { ...REQUETE, fromCurrency: "xof" });
  assert.equal(out.ok, true);
});

/* -------------------------------------------------------------------------- */
/* Le filtre porte bien les garanties                                         */
/* -------------------------------------------------------------------------- */

test("le filtre exige le propriétaire, l'état actif, la fraîcheur et le montant", () => {
  const filtre = construireFiltreConsommation({
    quoteId: "q-1",
    userId: "u-1",
    requete: REQUETE,
    maintenant: MAINTENANT,
  });

  assert.equal(filtre.quoteId, "q-1");
  assert.equal(filtre.userId, "u-1");
  assert.equal(filtre.status, "ACTIVE");
  assert.deepEqual(filtre.expiresAt, { $gt: MAINTENANT });
  assert.equal(filtre["request.amount"], 10000);
});

/* -------------------------------------------------------------------------- */
/* Diagnostic : le message désigne la vraie cause                             */
/* -------------------------------------------------------------------------- */

test("devis absent → 404 QUOTE_NOT_FOUND", () => {
  const err = diagnostiquerEchec(null, {
    userId: "u-1",
    requete: REQUETE,
    maintenant: MAINTENANT,
  });

  assert.equal(err.status, 404);
  assert.equal(err.code, "QUOTE_NOT_FOUND");
});

test("devis d'un autre compte → 403, sans révéler à qui il appartient", () => {
  const err = diagnostiquerEchec(devisActif({ userId: "u-2" }), {
    userId: "u-1",
    requete: REQUETE,
    maintenant: MAINTENANT,
  });

  assert.equal(err.status, 403);
  assert.equal(err.code, "QUOTE_NOT_OWNED");
  assert.ok(!err.message.includes("u-2"), "le propriétaire ne doit pas fuiter");
});

test("devis déjà consommé → 409 QUOTE_ALREADY_USED", () => {
  const err = diagnostiquerEchec(devisActif({ status: "USED" }), {
    userId: "u-1",
    requete: REQUETE,
    maintenant: MAINTENANT,
  });

  assert.equal(err.code, "QUOTE_ALREADY_USED");
});

test("devis expiré → 409 QUOTE_EXPIRED, et le message invite à en redemander un", () => {
  const err = diagnostiquerEchec(
    devisActif({ expiresAt: new Date(MAINTENANT.getTime() - 1000) }),
    { userId: "u-1", requete: REQUETE, maintenant: MAINTENANT }
  );

  assert.equal(err.code, "QUOTE_EXPIRED");
  assert.match(err.message, /redemandez/i);
});

test("paramètres divergents → 409 QUOTE_MISMATCH, avec les écarts nommés", () => {
  const err = diagnostiquerEchec(devisActif(), {
    userId: "u-1",
    requete: { ...REQUETE, amount: 50 },
    maintenant: MAINTENANT,
  });

  assert.equal(err.code, "QUOTE_MISMATCH");
  assert.equal(err.details.differences[0].champ, "amount");
});

/* -------------------------------------------------------------------------- */
/* Exigence progressive                                                       */
/* -------------------------------------------------------------------------- */

test("le devis est EXIGÉ par défaut — une variable oubliée ne désarme rien", () => {
  assert.equal(devisEstExige({}), true);
  assert.equal(devisEstExige({ PRICING_QUOTE_REQUIRED: "" }), true);
  assert.equal(devisEstExige({ PRICING_QUOTE_REQUIRED: "true" }), true);
  assert.equal(devisEstExige({ PRICING_QUOTE_REQUIRED: "TRUE" }), true);
  assert.equal(devisEstExige({ NODE_ENV: "production" }), true);
});

test("une valeur illisible exige le devis, et le dit", () => {
  const r = regimeDevis({ PRICING_QUOTE_REQUIRED: "non" });
  assert.equal(r.exige, true);
  assert.equal(r.source, "valeur-illisible");
  assert.ok(r.avertissement);
});

test("la dérogation n'existe qu'hors production, et elle s'annonce", () => {
  const dev = regimeDevis({ PRICING_QUOTE_REQUIRED: "false", NODE_ENV: "development" });
  assert.equal(dev.exige, false);
  assert.match(dev.avertissement, /CONSÉQUENCE/);

  const prod = regimeDevis({ PRICING_QUOTE_REQUIRED: "false", NODE_ENV: "production" });
  assert.equal(prod.exige, true);
  assert.match(prod.avertissement, /IGNORÉE en production/);
});

/* -------------------------------------------------------------------------- */
/* Consommation                                                               */
/* -------------------------------------------------------------------------- */

test("un devis conforme est consommé une fois, et passe à USED", async () => {
  const modele = fauxModele(devisActif());

  const out = await consumeQuote({
    quoteId: "q-1",
    userId: "u-1",
    request: REQUETE,
    reference: "TX-1",
    idempotencyKey: "k-1",
    model: modele,
  });

  assert.equal(out.status, "USED");
  assert.equal(out.usedByReference, "TX-1");
  assert.equal(modele.etat.doc.status, "USED");
});

test("un devis consommé est CONSERVÉ : l'index TTL ne l'efface plus avec l'offre", async () => {
  const { retentionDevisMs } = require("../../src/services/pricing/quoteService");
  const modele = fauxModele(devisActif());
  const avant = Date.now();

  await consumeQuote({
    quoteId: "q-1",
    userId: "u-1",
    request: REQUETE,
    reference: "TX-1",
    model: modele,
  });

  const conserveJusqua = new Date(modele.etat.doc.expiresAt).getTime();
  assert.ok(
    conserveJusqua >= avant + retentionDevisMs() - 5000,
    "la pièce du prix accepté doit survivre à la fin de l'offre"
  );
  assert.ok(retentionDevisMs() >= 365 * 24 * 3600 * 1000);
  assert.equal(retentionDevisMs({ PRICING_QUOTE_RETENTION_DAYS: "abc" }), retentionDevisMs({}));
});

test("le second usage est refusé — un devis n'engage PayNoval qu'une fois", async () => {
  const modele = fauxModele(devisActif());

  await consumeQuote({
    quoteId: "q-1",
    userId: "u-1",
    request: REQUETE,
    idempotencyKey: "k-1",
    model: modele,
  });

  await assert.rejects(
    consumeQuote({
      quoteId: "q-1",
      userId: "u-1",
      request: REQUETE,
      idempotencyKey: "k-2",
      model: modele,
    }),
    (err) => err.code === "QUOTE_ALREADY_USED"
  );
});

test("un rejeu portant la MÊME clé d'idempotence retrouve son devis", async () => {
  const modele = fauxModele(devisActif());

  const premier = await consumeQuote({
    quoteId: "q-1",
    userId: "u-1",
    request: REQUETE,
    idempotencyKey: "k-1",
    model: modele,
  });

  const rejeu = await consumeQuote({
    quoteId: "q-1",
    userId: "u-1",
    request: REQUETE,
    idempotencyKey: "k-1",
    model: modele,
  });

  assert.equal(rejeu.quoteId, premier.quoteId);
  assert.equal(rejeu.result.netTo, premier.result.netTo);
});

test("un devis NON CONFORME n'est pas brûlé : il reste utilisable", async () => {
  const modele = fauxModele(devisActif());

  await assert.rejects(
    consumeQuote({
      quoteId: "q-1",
      userId: "u-1",
      request: { ...REQUETE, amount: 999999 },
      model: modele,
    }),
    (err) => err.code === "QUOTE_MISMATCH"
  );

  // ⚠️ LA propriété : le devis est intact, l'utilisateur n'a pas perdu son prix.
  assert.equal(modele.etat.doc.status, "ACTIVE");

  const out = await consumeQuote({
    quoteId: "q-1",
    userId: "u-1",
    request: REQUETE,
    model: modele,
  });

  assert.equal(out.status, "USED");
});

test("le devis d'un autre compte ne se consomme pas", async () => {
  const modele = fauxModele(devisActif());

  await assert.rejects(
    consumeQuote({
      quoteId: "q-1",
      userId: "u-999",
      request: REQUETE,
      model: modele,
    }),
    (err) => err.code === "QUOTE_NOT_OWNED"
  );

  assert.equal(modele.etat.doc.status, "ACTIVE");
});

test("un devis expiré ne se consomme pas", async () => {
  const modele = fauxModele(
    devisActif({ expiresAt: new Date(Date.now() - 60 * 1000) })
  );

  await assert.rejects(
    consumeQuote({
      quoteId: "q-1",
      userId: "u-1",
      request: REQUETE,
      model: modele,
    }),
    (err) => err.code === "QUOTE_EXPIRED"
  );
});

test("sans identité, aucune consommation n'est possible", async () => {
  await assert.rejects(
    consumeQuote({
      quoteId: "q-1",
      userId: "",
      request: REQUETE,
      model: fauxModele(devisActif()),
    }),
    (err) => err.status === 401
  );
});
