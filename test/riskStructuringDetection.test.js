"use strict";

/**
 * ============================================================================
 * DÉTECTION DU FRACTIONNEMENT — LA RÈGLE, PAS LE PLOMBIER
 * ============================================================================
 *
 * ── Ce qui est testé ────────────────────────────────────────────────────────
 *
 * `detecterFractionnement` lit des événements et rend un constat. Les tests
 * substituent la lecture pour porter uniquement sur la RÈGLE : combien
 * d'opérations, dans quelle bande, sur quelle fenêtre, et ce qu'on refuse de
 * conclure.
 *
 * ── Les deux erreurs qu'un détecteur peut commettre ─────────────────────────
 *
 * Manquer un motif est grave. Mais un détecteur qui signale TOUT est pire :
 * l'analyste s'habitue au bruit, et finit par ignorer la règle entière — y
 * compris le jour où elle a raison. Les tests couvrent donc autant les cas où
 * la règle NE DOIT PAS se déclencher.
 *
 * Test **pur** : aucune connexion Mongo, aucun Redis.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const CHEMIN_MODELE = require.resolve("../src/models/DomainEvent");
const CHEMIN_DB = require.resolve("../src/config/db");

/**
 * ⚠️ SUBSTITUTION AU NIVEAU DU CHARGEUR, pas monkey-patch après coup.
 *
 * `monitoringConsumer` résout ses modèles PARESSEUSEMENT — au premier appel,
 * pas au chargement. Remplacer l'export après un `require` ne suffirait donc
 * pas : c'est le `require` interne qu'il faut intercepter.
 */
let evenementsSimules = [];

const chargeurOriginal = Module._load;

Module._load = function (demande, parent, estPrincipal) {
  const resolu = (() => {
    try {
      return Module._resolveFilename(demande, parent, estPrincipal);
    } catch {
      return null;
    }
  })();

  if (resolu === CHEMIN_DB) {
    return { getTxConn: () => ({}) };
  }

  if (resolu === CHEMIN_MODELE) {
    return () => ({
      find() {
        return {
          select() {
            return {
              lean: async () => evenementsSimules,
            };
          },
        };
      },
    });
  }

  return chargeurOriginal.apply(this, arguments);
};

const monitoring = require("../src/services/risk/monitoringConsumer");

/** Fabrique un événement à un montant donné. */
function ev(transactionId, amount, currency = "XOF") {
  return {
    payload: { transactionId, amount, currency, senderId: "u-1" },
    occurredAt: new Date(),
  };
}

const MAINTENANT = new Date();

async function detecter(evenements, devise = "XOF") {
  evenementsSimules = evenements;

  return monitoring.detecterFractionnement({
    sujetId: "u-1",
    devise,
    maintenant: MAINTENANT,
  });
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* CE QUI DOIT DÉCLENCHER                                                    */
/* ══════════════════════════════════════════════════════════════════════════ */

test("quatre opérations juste sous le seuil ouvrent un dossier", async () => {
  const seuil = monitoring.seuilDeclaration("XOF");
  const montant = Math.round(seuil * 0.9);

  const constat = await detecter([
    ev("t1", montant),
    ev("t2", montant),
    ev("t3", montant),
    ev("t4", montant),
  ]);

  assert.ok(constat, "le fractionnement n'a pas été détecté");
  assert.equal(constat.code, "AML_STRUCTURING");
  assert.equal(constat.occurrences, 4);
  assert.equal(constat.depasseParCumul, true);
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* CE QUI NE DOIT PAS DÉCLENCHER — la moitié qui protège de l'inutilité      */
/* ══════════════════════════════════════════════════════════════════════════ */

test("trois opérations ne suffisent pas", async () => {
  const montant = Math.round(monitoring.seuilDeclaration("XOF") * 0.9);

  assert.equal(await detecter([ev("t1", montant), ev("t2", montant), ev("t3", montant)]), null);
});

test("des montants ORDINAIRES ne sont pas du fractionnement", async () => {
  /**
   * Dix virements à 3 % du seuil, c'est un usage normal. Les compter ferait de
   * ce détecteur une machine à bruit — et un détecteur bruyant se fait ignorer.
   */
  const petit = Math.round(monitoring.seuilDeclaration("XOF") * 0.03);

  const evenements = Array.from({ length: 10 }, (_, i) => ev(`t${i}`, petit));

  assert.equal(await detecter(evenements), null);
});

test("des opérations AU-DESSUS du seuil ne sont pas du fractionnement", async () => {
  /**
   * Elles sont déjà déclarables : celui qui les fait ne cherche rien à éviter.
   * Le fractionnement est un contournement — sans contournement, pas de motif.
   */
  const gros = Math.round(monitoring.seuilDeclaration("XOF") * 1.5);

  const evenements = Array.from({ length: 6 }, (_, i) => ev(`t${i}`, gros));

  assert.equal(await detecter(evenements), null);
});

test("`initiated` et `confirmed` de la MÊME transaction comptent pour UNE", async () => {
  /**
   * ⚠️ LE PIÈGE CENTRAL DE CE DÉTECTEUR.
   *
   * Les deux événements décrivent la même opération. Les compter tous deux
   * doublerait mécaniquement chaque transaction : le seuil de quatre serait
   * franchi par deux virements, et la moitié des signalements serait inventée.
   */
  const montant = Math.round(monitoring.seuilDeclaration("XOF") * 0.9);

  const constat = await detecter([
    ev("t1", montant),
    ev("t1", montant),
    ev("t2", montant),
    ev("t2", montant),
    ev("t3", montant),
    ev("t3", montant),
  ]);

  assert.equal(
    constat,
    null,
    "trois transactions dédoublées ont été comptées comme six"
  );
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* CE QU'ON REFUSE DE CONCLURE                                               */
/* ══════════════════════════════════════════════════════════════════════════ */

test("une devise sans seuil déclaré N'OUVRE PAS de dossier", async () => {
  /**
   * Inventer un seuil produirait des dossiers arbitraires — pire que pas de
   * dossier : un analyste y perdrait son temps et finirait par se défier de la
   * règle. La fonction rend `null` ET journalise la conséquence.
   */
  const montant = 100000;

  const constat = await detecter(
    Array.from({ length: 10 }, (_, i) => ev(`t${i}`, montant, "ZZZ")),
    "ZZZ"
  );

  assert.equal(constat, null);
  assert.equal(monitoring.seuilDeclaration("ZZZ"), null);
});

test("les seuils sont des paramètres LISIBLES, pas des constantes cachées", () => {
  /**
   * Un responsable conformité doit pouvoir lire la politique en vigueur. Ces
   * valeurs sont exportées et annoncées au démarrage (règle B.6).
   */
  assert.ok(monitoring.FRACTIONNEMENT.occurrences >= 3);
  assert.ok(monitoring.FRACTIONNEMENT.ratioMin > 0 && monitoring.FRACTIONNEMENT.ratioMin < 1);
  assert.ok(monitoring.FRACTIONNEMENT.fenetreMs >= 3600 * 1000);

  for (const devise of ["XOF", "EUR", "USD"]) {
    assert.ok(monitoring.seuilDeclaration(devise) > 0, `${devise} sans seuil`);
  }
});

test.after(() => {
  Module._load = chargeurOriginal;
});
