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

/**
 * La FRONTIÈRE du cache de change — le test le plus important de ce lot.
 *
 * `pickFxRule` fait deux choses : lire le jeu de règles d'une paire (accès
 * base, cachable) et choisir la règle applicable selon le montant (calcul pur,
 * PAS cachable). Si la frontière glisse, on se met à servir un tarif choisi
 * pour un autre montant — sans aucune erreur visible.
 *
 * Ces tests lisent le SOURCE plutôt que d'exécuter le service : exécuter
 * demanderait une base et un Redis, ce que les suites de ce dépôt s'interdisent
 * pour rester rapides. Ce qu'on protège ici est une propriété structurelle, et
 * elle se lit.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(
  path.join(__dirname, "../../src/services/pricing/fxRulesService.js"),
  "utf8"
);

test("la lecture des règles passe par le cache", () => {
  assert.match(SRC, /getOrSet\(\s*"pricing-rules"/);
});

test("SEULE la requête base est enveloppée — la sélection reste hors cache", () => {
  // Si `candidates`, `sort` ou `computeSpecificityScore` se retrouvaient à
  // l'intérieur du `getOrSet`, on cacherait la DÉCISION et non la donnée : le
  // premier montant vu figerait le tarif de tous les suivants.
  const debut = SRC.indexOf('getOrSet("pricing-rules"');
  assert.ok(debut > 0);
  const fin = SRC.indexOf("const candidates", debut);
  assert.ok(fin > debut, "la sélection doit venir APRÈS le getOrSet");

  const enveloppe = SRC.slice(debut, fin);
  for (const interdit of ["candidates", "computeSpecificityScore", ".sort(", "inRange("]) {
    assert.ok(
      !enveloppe.includes(interdit),
      `« ${interdit} » ne doit pas se trouver DANS la portion cachée`
    );
  }
});

test("la clé de cache ne dépend QUE de la paire de devises", () => {
  // Une clé qui inclurait le montant ferait exploser le nombre d'entrées et
  // rendrait le cache inutile ; une clé qui inclurait le pays servirait la
  // mauvaise règle. La paire, et rien d'autre.
  assert.match(SRC, /function clePaire\(fromCurrency, toCurrency\)/);
  const corps = SRC.slice(SRC.indexOf("function clePaire"), SRC.indexOf("function clePaire") + 200);
  for (const interdit of ["amount", "country", "provider", "method"]) {
    assert.ok(!corps.includes(interdit), `la clé ne doit pas dépendre de « ${interdit} »`);
  }
});

test("la paire est normalisée en majuscules", () => {
  // `eur→XOF` et `EUR→xof` sont la même paire. Sans normalisation, elles
  // occuperaient deux entrées et l'invalidation n'en purgerait qu'une.
  assert.match(SRC, /clePaire[\s\S]{0,120}toUpper\(fromCurrency\)/);
});

test("le DEVIS n'est jamais caché — seulement le référentiel", () => {
  // La ressource `pricing-rules` est du référentiel. Si un jour quelqu'un
  // cachait le résultat de `getAdjustedRate`, il servirait un PRIX périmé et
  // déferait la frontière de tarification « échec en fermeture ».
  const apresGetAdjusted = SRC.slice(SRC.indexOf("function getAdjustedRate"));
  assert.ok(
    !/getOrSet\(/.test(apresGetAdjusted),
    "getAdjustedRate ne doit contenir AUCUN appel de cache"
  );
});

test("une fonction d'invalidation existe ET est exportée", () => {
  assert.match(SRC, /async function invalidateFxRulesCache/);
  assert.match(SRC, /module\.exports[\s\S]*invalidateFxRulesCache/);
});

test("les TROIS écritures du contrôleur purgent le cache", () => {
  // Un cache sans invalidation est un bug à retardement : il sert le bon
  // tarif jusqu'à la première modification, puis l'ancien pendant tout le TTL.
  const ctrl = fs.readFileSync(
    path.join(__dirname, "../../src/controllers/pricing/fxRulesController.js"),
    "utf8"
  );

  for (const nom of ["create", "update", "remove"]) {
    const debut = ctrl.indexOf(`exports.${nom} =`);
    assert.ok(debut > 0, `handler ${nom} introuvable`);
    const suite = ctrl.slice(debut, ctrl.indexOf("exports.", debut + 10) + 1 || undefined);
    assert.ok(
      suite.includes("purgerCache("),
      `le handler « ${nom} » doit purger le cache après écriture`
    );
  }
});

test("la purge intervient APRÈS l'écriture, jamais avant", () => {
  // Purger avant laisse une fenêtre où un lecteur concurrent recharge
  // l'ancienne valeur et la remet en cache : on aurait purgé pour rien.
  const ctrl = fs.readFileSync(
    path.join(__dirname, "../../src/controllers/pricing/fxRulesController.js"),
    "utf8"
  );
  const debut = ctrl.indexOf("exports.create =");
  const bloc = ctrl.slice(debut, debut + 600);
  assert.ok(
    bloc.indexOf("doc.save()") < bloc.indexOf("purgerCache("),
    "purgerCache doit venir après save()"
  );
});

test("le cache réutilise le client Redis du processus, sans en ouvrir un second", () => {
  // §12 : aucune requête HTTP ne crée de connexion Redis.
  assert.match(SRC, /getClient/);
  assert.ok(!/new Redis\(/.test(SRC), "aucun client Redis ne doit être créé ici");
});
