"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  INDEX_NAME,
  checkDedupIndex,
  formatDedupIndexReport,
} = require("../src/services/ledger/verifyDedupIndex");

/**
 * Pourquoi ce contrôle existe : `scripts/ensure-ledger-indexes.js` se lance À
 * LA MAIN. Si le déploiement qui écrit `dedupKey` part avant lui, le code se
 * comporte comme s'il avait une protection contre le double enregistrement,
 * alors que la base n'en porte aucune. Et les doublons écrits pendant cette
 * fenêtre feront ensuite ÉCHOUER la construction de l'index.
 */

const fakeConn = (result) => ({
  collection: () => ({
    indexes: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  }),
});

test("reconnaît l'index quand il est là", async () => {
  const res = await checkDedupIndex(
    fakeConn([{ name: "_id_" }, { name: INDEX_NAME }])
  );

  assert.equal(res.present, true);
  assert.equal(res.reason, "ok");
});

test("signale l'absence sans se tromper de voisin", async () => {
  // Quatre autres index existent sur cette collection : leur présence ne dit
  // rien de celui-ci.
  const res = await checkDedupIndex(
    fakeConn([{ name: "createdAt_-1" }, { name: "currency_1_createdAt_-1" }])
  );

  assert.equal(res.present, false);
});

test("ne LÈVE JAMAIS — un contrôle qui casse le démarrage est un défaut", async () => {
  /**
   * Collection absente sur une base neuve, droits insuffisants, réseau : trois
   * causes légitimes. Faire échouer le démarrage du service financier pour un
   * contrôle d'observabilité serait un très mauvais arbitrage.
   */
  const res = await checkDedupIndex(fakeConn(new Error("ns does not exist")));

  assert.equal(res.present, false);
  assert.match(res.reason, /indisponible/);
});

test("distingue « absent » de « je ne sais pas »", () => {
  /**
   * La distinction compte : « absent » appelle une action immédiate
   * (lancer le script), « je ne sais pas » appelle une vérification. Les
   * confondre produirait de fausses alertes que l'exploitation finirait par
   * ignorer — et l'alerte utile serait perdue avec les autres.
   */
  const inconnu = formatDedupIndexReport({ present: false, reason: "indisponible: timeout" });
  const absent = formatDedupIndexReport({ present: false, reason: "absent" });

  assert.ok(inconnu.some((l) => l.includes("⚠️")));
  assert.ok(!inconnu.some((l) => l.includes("❌")));

  assert.ok(absent.some((l) => l.includes("❌")));
  assert.ok(absent.some((l) => l.includes("ensure-ledger-indexes")));
});

test("le rapport de succès reste discret", () => {
  const lignes = formatDedupIndexReport({ present: true });

  assert.equal(lignes.length, 1);
  assert.ok(lignes[0].includes("✅"));
});

test("le message d'absence dit POURQUOI c'est grave", () => {
  // Un message qui dit seulement « index absent » n'obtient pas d'action. Il
  // doit dire que le grand livre restera ÉQUILIBRÉ en cas de doublon — donc
  // que la balance de vérification ne signalera rien.
  const lignes = formatDedupIndexReport({ present: false, reason: "absent" }).join(" ");

  assert.match(lignes, /deux fois/);
  assert.match(lignes, /équilibré/);
});

/* ==========================================================================
 * LE CONTRÔLE GÉNÉRALISÉ — CINQ CONTRAINTES D'INTÉGRITÉ, PAS UNE
 * ======================================================================== */

const {
  CRITICAL_INDEXES,
  checkCriticalIndexes,
  formatCriticalIndexesReport,
} = require("../src/services/ledger/verifyDedupIndex");

test("les cinq contraintes d'intégrité sont surveillées", () => {
  /**
   * Elles partagent la même propriété redoutable : leur absence ne se voit pas.
   * Le code continue de fonctionner, il se comporte simplement comme s'il avait
   * une protection qu'il n'a plus — et on ne s'en aperçoit qu'après le doublon.
   *
   * `outboxes.uniq_outbox_idempotency_key` a rejoint la liste le 2026-09-03.
   * `models/Outbox.js` le déclare et son propre commentaire DOUTE qu'il existe
   * en base : `autoIndex` est coupé hors développement, et un index déclaré
   * n'est pas un index créé. Or le dédoublonnage des événements de parrainage
   * repose sur le `E11000` qu'il produit — sans lui, ce `E11000` ne survient
   * jamais et le dédoublonnage est muet.
   *
   * `processed_events.uniq_processed_event` a rejoint la liste le 2026-09-10,
   * avec le bus d'événements. Même famille exactement : `services/events/consumer.js`
   * refuse de démarrer un consommateur sans stratégie de dédoublonnage, mais
   * cette stratégie est un « lire puis écrire » — et entre les deux il y a une
   * fenêtre. Deux instances du même groupe qui réclament le même message
   * abandonné au même instant passent toutes deux la lecture. C'est l'index
   * UNIQUE qui referme la fenêtre, par le E11000 qu'il produit.
   *
   * Sans lui, tout continue de fonctionner : le dédoublonnage attrape le cas
   * courant (relivraison séquentielle) et manque le cas concurrent — celui d'un
   * redéploiement ou d'une montée en charge.
   *
   * `trusted_deposit_numbers.uniq_trusted_deposit_number` a rejoint la liste le
   * 2026-09-10, en descendant la confiance des numéros de dépôt depuis le bord.
   * Encore la même famille : `/start` crée le document par `upsert` sur
   * `{ userId, phoneE164 }`, et deux appels concurrents — un double appui — en
   * produiraient DEUX si rien ne l'interdit. Le compteur d'envois se
   * répartirait entre les deux documents, et le plafond de 5 SMS par fenêtre en
   * autoriserait 10.
   *
   * Rien ne le signalerait : les deux documents sont valides, les deux comptent,
   * et la lecture n'en voit qu'un. Un anti-abus qui paraît tenir et ne tient
   * plus.
   *
   * Cette liste est une frontière : y ajouter une entrée est une décision, et
   * ce test la rend explicite plutôt que tacite.
   */
  const noms = CRITICAL_INDEXES.map((i) => `${i.collection}.${i.name}`);

  assert.deepEqual(noms.sort(), [
    "ledgerentries.dedupKey_unique_partial",
    "outboxes.uniq_outbox_idempotency_key",
    "processed_events.uniq_processed_event",
    "provider_webhook_events.uniq_webhook_provider_event",
    "trusted_deposit_numbers.uniq_trusted_deposit_number",
  ]);
});

test("chaque index surveillé est réellement déclaré par un modèle", () => {
  /**
   * Un index surveillé mais déclaré nulle part serait signalé absent à chaque
   * démarrage — une alarme permanente qu'on finirait par ignorer, ce qui est
   * pire que pas d'alarme.
   */
  const fs = require("node:fs");
  const path = require("node:path");
  const srcDir = path.join(__dirname, "..", "src");

  const sources = [];
  (function parcourir(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) parcourir(p);
      else if (e.name.endsWith(".js")) sources.push(fs.readFileSync(p, "utf8"));
    }
  })(srcDir);

  for (const i of CRITICAL_INDEXES) {
    assert.ok(
      sources.some((s) => s.includes(i.name)),
      `${i.name} est surveillé mais aucun modèle ne le déclare`
    );
  }
});

test("chaque contrainte explique CE QU'ELLE protège", () => {
  // « index absent » n'obtient pas d'action. « le bénéficiaire serait crédité
  // deux fois » en obtient une.
  for (const i of CRITICAL_INDEXES) {
    assert.ok(i.protects && i.protects.length > 40, `${i.name} sans explication`);
  }
});

test("une collection ABSENTE n'est pas une panne", () => {
  /**
   * `provider_webhook_events` n'existe qu'au premier rappel reçu. Traiter son
   * absence comme une erreur ferait crier un service parfaitement sain — et
   * l'alerte utile finirait ignorée avec les autres.
   */
  const lignes = formatCriticalIndexesReport([
    { collection: "provider_webhook_events", name: "x", present: false, reason: "collection-absente", protects: "…" },
  ]);

  assert.ok(lignes.some((l) => l.includes("⚠️")));
  assert.ok(!lignes.some((l) => l.includes("❌")));
});

test("le contrôle ne LÈVE jamais, même collection par collection", async () => {
  const conn = {
    collection: (nom) => ({
      indexes: async () => {
        if (nom === "ledgerentries") return [{ name: "dedupKey_unique_partial" }];
        throw new Error("ns does not exist");
      },
    }),
  };

  const r = await checkCriticalIndexes(conn);

  // Une collection qui n'existe pas ne doit pas interrompre le contrôle des
  // suivantes : chaque cible est évaluée pour elle-même.
  assert.equal(r.length, CRITICAL_INDEXES.length);
  assert.equal(r[0].present, true);

  for (const ligne of r.slice(1)) {
    assert.equal(ligne.present, false);
    assert.equal(ligne.reason, "collection-absente");
  }
});

test("un index vraiment absent est signalé en ❌ avec la marche à suivre", () => {
  const lignes = formatCriticalIndexesReport([
    { collection: "ledgerentries", name: "dedupKey_unique_partial", present: false, reason: "absent", protects: "le grand livre resterait équilibré" },
  ]);

  assert.ok(lignes.some((l) => l.includes("❌")));
  assert.ok(lignes.some((l) => l.includes("ensure-ledger-indexes")));
});
