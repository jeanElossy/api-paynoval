"use strict";

/**
 * ============================================================================
 * LE BUS EST-IL RÉELLEMENT BRANCHÉ ? — la question que personne ne pose
 * ============================================================================
 *
 * ── Pourquoi ce fichier existe ──────────────────────────────────────────────
 *
 * Le dépôt a déjà connu ce défaut exact, deux fois :
 *
 *   · `collect()` existait sur les cinq adaptateurs et n'avait AUCUN appelant :
 *     toute la capacité d'encaissement était morte, et rien ne le disait ;
 *   · `mirrorTxToTxCore` n'avait aucun appelant non plus, et la jauge de sa
 *     file était VERTE — parce qu'une file structurellement vide n'a jamais de
 *     retard.
 *
 * Un bus d'événements est le candidat idéal à cette panne : tout se charge,
 * tout démarre, les journaux sont propres, et aucun événement ne circule. Ces
 * tests vérifient les BRANCHEMENTS, pas les fonctions.
 *
 * Test **pur** : il lit des fichiers et charge des modules sans connexion.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const RACINE = path.join(__dirname, "..");
const lire = (...s) => fs.readFileSync(path.join(RACINE, ...s), "utf8");

const sansCommentaires = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ══════════════════════════════════════════════════════════════════════════ */
/* 1. LES PRODUCTEURS — l'événement est-il écrit DANS la transaction ?       */
/* ══════════════════════════════════════════════════════════════════════════ */

const CHEMINS_ARGENT = Object.freeze([
  ["src/services/transactions/handlers/initiateInternal.js", "transaction.initiated.v1"],
  ["src/services/transactions/handlers/confirmTransaction.js", "transaction.confirmed.v1"],
  ["src/services/transactions/handlers/cancelTransaction.js", "transaction.cancelled.v1"],
]);

for (const [fichier, evenement] of CHEMINS_ARGENT) {
  test(`${path.basename(fichier)} publie « ${evenement} »`, () => {
    const src = sansCommentaires(lire(fichier));

    assert.match(src, /publishDomainEvent\(/, "aucune publication d'événement");
    assert.ok(
      src.includes(evenement),
      `l'événement « ${evenement} » n'est pas publié depuis ce chemin`
    );
  });

  test(`${path.basename(fichier)} publie SOUS LA SESSION, pas après le commit`, () => {
    /**
     * ⚠️ L'INVARIANT CENTRAL DU MOTIF.
     *
     * `publishDomainEvent(..., sess)` : le second argument est la session. Sans
     * lui, l'écriture sort de la transaction et on rétablit la double écriture
     * — un virement peut alors être réservé sans que le moindre consommateur
     * l'apprenne, et rien ne le signalerait.
     *
     * Le test cherche la forme d'appel exacte, pas la présence du mot
     * « session » quelque part dans le fichier.
     */
    const src = sansCommentaires(lire(fichier));

    /**
     * ⚠️ On PARSE les parenthèses au lieu de deviner l'indentation.
     *
     * Première écriture de ce test : une expression rationnelle attendait la
     * session sur une ligne indentée de 6 à 8 espaces. `confirmTransaction.js`
     * publie depuis un bloc plus profond — le test a échoué sur du code
     * parfaitement correct.
     *
     * Un test qui crie sur du code sain finit désactivé, et emporte avec lui la
     * protection qu'il apportait. On lit donc la STRUCTURE : dernier argument de
     * l'appel, quelle que soit sa mise en forme.
     */
    const appels = [];

    let curseur = src.indexOf("publishDomainEvent(");

    while (curseur !== -1) {
      let profondeur = 0;
      let i = src.indexOf("(", curseur);
      const debut = i;

      for (; i < src.length; i += 1) {
        if (src[i] === "(") profondeur += 1;
        else if (src[i] === ")") {
          profondeur -= 1;
          if (profondeur === 0) break;
        }
      }

      appels.push(src.slice(debut + 1, i));
      curseur = src.indexOf("publishDomainEvent(", i);
    }

    assert.ok(appels.length > 0, "aucun appel à `publishDomainEvent`");

    for (const args of appels) {
      const dernier = args.trim().split(",").pop().trim();

      assert.ok(
        ["sess", "session"].includes(dernier),
        "`publishDomainEvent` est appelé SANS session (dernier argument : " +
          `« ${dernier} ») : l'événement sortirait de la transaction, et un ` +
          "mouvement d'argent pourrait n'être jamais publié"
      );
    }
  });
}

test("l'encaissement public publie son succès, et sous transaction", () => {
  const src = sansCommentaires(lire("src/services/collections/collectionService.js"));

  assert.match(src, /collection\.succeeded\.v1/);
  assert.match(src, /withTransaction\(/);

  /**
   * ⚠️ AUCUN APPEL RÉSEAU DANS LA TRANSACTION.
   *
   * C'est l'invariant que défend l'en-tête de `initiateInternal.js` : une
   * transaction qui attend le réseau tient des verrous pendant l'attente, et
   * au-delà de 60 s le serveur la tue sous nos pieds.
   */
  const bloc = src.slice(src.indexOf("withTransaction("), src.indexOf("finally"));

  assert.ok(bloc.length > 50, "bloc transactionnel introuvable — test à revoir");
  assert.doesNotMatch(bloc, /axios|fetch\(|notifier|http/i);
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* 2. LE RELAIS — la moitié qui transporte                                   */
/* ══════════════════════════════════════════════════════════════════════════ */

test("le relais est démarré par le serveur, et arrêté proprement", () => {
  const src = sansCommentaires(lire("src/server.js"));

  assert.match(src, /require\("\.\/services\/events\/relay"\)/);
  assert.match(src, /eventRelay = relais\.start\(/);
  assert.match(src, /eventRelay\?\.stop\?\.\(\)/);
});

test("le relais publie AVANT de marquer publié — jamais l'inverse", () => {
  /**
   * Marquer puis publier perd l'événement si le processus meurt entre les deux :
   * il est réputé publié et ne repartira jamais. Dans le bon ordre, la même
   * mort produit un DOUBLON — que les consommateurs absorbent.
   */
  const src = sansCommentaires(lire("src/services/events/relay.js"));

  const posEnvoi = src.indexOf("stream.xadd(");
  const posMarquage = src.indexOf("await marquerPublie(");

  assert.ok(posEnvoi > -1 && posMarquage > -1);
  assert.ok(
    posEnvoi < posMarquage,
    "le relais marque publié avant d'envoyer : tout événement perdu entre les " +
      "deux le serait DÉFINITIVEMENT"
  );
});

test("sans transport, le relais ne marque RIEN comme publié", async () => {
  const relay = require("../src/services/events/relay");

  /** Aucun client Redis n'est posé dans les tests : c'est le cas « absent ». */
  const bilan = await relay.tick({ logger: { error() {}, warn() {}, info() {} } });

  assert.equal(bilan.transport, false);
  assert.equal(bilan.publies, 0);
  assert.equal(bilan.lus, 0);
});

test("le bail du relais expire — il n'y a pas de statut bloquant", () => {
  /**
   * Invariant 5 : tout verrou distribué porte un TTL et un propriétaire. Un
   * statut `processing` laissé par un processus mort bloque une file pour
   * toujours ; un bail expire tout seul.
   */
  const src = sansCommentaires(lire("src/services/events/relay.js"));

  assert.match(src, /claimedUntil/);
  assert.match(src, /claimedBy/);
  assert.match(src, /\$or: \[\{ claimedUntil: null \}, \{ claimedUntil: \{ \$lte: maintenant \} \}\]/);
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* 3. LE TRANSPORT — flux, pas pub/sub                                       */
/* ══════════════════════════════════════════════════════════════════════════ */

test("le transport utilise les FLUX, jamais publish/subscribe", () => {
  /**
   * `PUBLISH` est du « tire et oublie » : un consommateur redémarré pendant un
   * déploiement perdrait tous les événements de la fenêtre, sans erreur nulle
   * part. C'est le pire mode de perte — silencieux, et pendant les opérations.
   */
  const src = sansCommentaires(lire("src/services/events/stream.js"));

  assert.match(src, /xadd\(/);
  assert.match(src, /xreadgroup\(/);
  assert.match(src, /xack\(/);
  assert.match(src, /xautoclaim\(/);

  assert.doesNotMatch(
    src,
    /client\.publish\(|client\.subscribe\(/,
    "le bus est retombé sur pub/sub : les événements ne survivraient pas à un " +
      "redémarrage de consommateur"
  );
});

test("le journal du flux est BORNÉ — l'équivalent d'un TTL (invariant A6)", () => {
  const stream = require("../src/services/events/stream");
  const src = sansCommentaires(lire("src/services/events/stream.js"));

  assert.ok(Number.isFinite(stream.TAILLE_MAX) && stream.TAILLE_MAX >= 1000);
  assert.match(src, /"MAXLEN"/);
  assert.match(src, /"~"/, "la taille exacte coûterait cher sur un flux actif");
});

test("`BLOCK 0` n'est JAMAIS envoyé à Redis — il veut dire « à l'infini »", () => {
  /**
   * ⚠️ DÉFAUT MESURÉ LE 2026-09-10, TROUVÉ EN FAISANT TOURNER LE BUS.
   *
   * `readGroup({ blockMs: 0 })` semblait demander une lecture non bloquante.
   * En Redis, `BLOCK 0` signifie l'inverse : « attends INDÉFINIMENT jusqu'à ce
   * qu'un message arrive ». Sur un flux vide, le tour du consommateur ne rendait
   * jamais la main — le consommateur se figeait, et `stop()` n'aboutissait pas
   * non plus, donc l'arrêt sur SIGTERM restait sans effet.
   *
   * Le défaut était invisible aux tests unitaires (ils n'ouvrent aucun Redis) et
   * aux premiers essais de bout en bout, où il y avait toujours des messages à
   * lire. Il n'apparaissait qu'au tour SUIVANT la consommation, c'est-à-dire au
   * régime nominal.
   *
   * Ce test lit la SOURCE : la garde doit être conditionnelle, et le cadre de
   * consommation ne doit pas redemander une attente.
   */
  const flux = sansCommentaires(lire("src/services/events/stream.js"));
  const conso = sansCommentaires(lire("src/services/events/consumer.js"));

  assert.match(
    flux,
    /Number\(blockMs\) > 0 \? \["BLOCK", String\(blockMs\)\] : \[\]/,
    "`BLOCK` est envoyé sans condition : un `blockMs: 0` bloquerait à l'infini"
  );

  assert.ok(
    !/blockMs:\s*0/.test(conso),
    "le cadre de consommation redemande `blockMs: 0` — c'est la forme qui a " +
      "produit le blocage infini ; ne rien passer suffit"
  );
});

test("le groupe démarre à 0, pas à $ — aucun historique n'est sauté", () => {
  /**
   * `$` signifie « seulement ce qui arrive après moi ». À la création du
   * groupe, tout l'historique déjà présent serait ignoré EN SILENCE — sur de la
   * surveillance de conformité, c'est exactement ce qu'il ne faut pas faire.
   */
  const src = sansCommentaires(lire("src/services/events/stream.js"));

  assert.match(src, /xgroup\("CREATE", FLUX, groupe, "0", "MKSTREAM"\)/);
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* 4. LE CONSOMMATEUR — idempotence obligatoire                              */
/* ══════════════════════════════════════════════════════════════════════════ */

test("un consommateur sans stratégie de dédoublonnage NE DÉMARRE PAS", () => {
  /**
   * Le point le plus important du cadre. Sans `dejaTraite`, tout fonctionne en
   * développement — où chaque message n'arrive qu'une fois — et double au
   * premier redéploiement en production.
   */
  const { createConsumer } = require("../src/services/events/consumer");

  assert.throws(
    () => createConsumer({ groupe: "test", handler: async () => {} }),
    /dédoublonne/
  );
});

test("le registre de dédoublonnage est unique PAR GROUPE", () => {
  /**
   * Dédoublonner sur `eventId` seul ferait que le premier groupe à traiter
   * empêcherait tous les autres — un défaut qui n'apparaîtrait qu'en ajoutant
   * le second consommateur.
   */
  const src = lire("src/models/ProcessedEvent.js");

  assert.match(src, /\{ group: 1, eventId: 1 \}/);
  assert.match(src, /unique: true/);
});

test("la surveillance du risque est un consommateur complet", () => {
  const monitoring = require("../src/services/risk/monitoringConsumer");

  assert.equal(typeof monitoring.dejaTraite, "function");
  assert.equal(typeof monitoring.handler, "function");
  assert.ok(monitoring.EVENEMENTS.length >= 2);

  /** Il se construit : c'est le cadre qui refuserait s'il manquait une pièce. */
  const c = monitoring.build({ logger: { info() {}, warn() {}, error() {} } });
  assert.equal(c.groupe, "risk-monitoring");
});

test("la surveillance a son PROPRE point d'entrée — processus séparé", () => {
  /**
   * C'est l'étape vers le service `Risk/AML` du schéma cible : la surveillance
   * doit pouvoir planter, saturer ou se redéployer SANS emporter le moteur
   * d'argent.
   */
  assert.ok(fs.existsSync(path.join(RACINE, "workers", "riskMonitor.js")));

  const pkg = JSON.parse(lire("package.json"));
  assert.equal(pkg.scripts["worker:risk"], "node workers/riskMonitor.js");

  const worker = sansCommentaires(lire("workers", "riskMonitor.js"));

  /** Ce n'est pas une API : elle n'écoute aucun port. */
  assert.doesNotMatch(worker, /app\.listen|express\(/);
});
