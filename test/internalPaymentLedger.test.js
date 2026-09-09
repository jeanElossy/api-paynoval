"use strict";

/**
 * ============================================================================
 * UN PAIEMENT INTERNE NE DÉPLACE PAS D'ARGENT SANS ÉCRITURE COMPTABLE
 * ============================================================================
 *
 * ── Ce que ce test empêche de revenir ────────────────────────────────────────
 * `controllers/internalPaymentsController.js` déplaçait des portefeuilles par
 * `TxWalletBalance.debit` et `.credit` **sans écrire une seule ligne au grand
 * livre** — le fichier ne contenait aucune occurrence de « ledger ».
 *
 * Ce n'est pas un chemin marginal : c'est là qu'aboutit `POST /api/v1/pay` du
 * backend principal, via `transactionsService.createInternalPayment` →
 * `POST /api/v1/internal-payments`. De l'argent bougeait réellement, sans
 * contrepartie comptable.
 *
 * Deux invariants tombaient ensemble :
 *   · **2** — le grand livre fait foi, le solde n'en est qu'une projection.
 *     Une projection qui bouge sans que sa source bouge n'en est plus une.
 *   · **4** — toute écriture financière est auditable. Il n'y avait rien à
 *     auditer.
 *
 * ── Pourquoi un test de CÂBLAGE et pas seulement de comportement ────────────
 * C'est la leçon de `mongodb_pool_max_size`, qui affichait 0 pendant que ses
 * tests unitaires passaient : ils alimentaient eux-mêmes l'événement et
 * validaient un réducteur correct, tandis que le câblage perdait tout. Un test
 * qui appelle `postInternalPaymentEntries` directement prouverait que la
 * primitive sait poser des écritures — pas qu'elle est appelée.
 *
 * ── Comment il tombe ────────────────────────────────────────────────────────
 * Retirer l'appel à `postInternalPaymentEntries` du contrôleur, ou le sortir de
 * `runWithTransaction`.
 *
 * Test **pur** : aucune connexion, aucun serveur. Le contrôle de bout en bout,
 * avec base, vit dans `test-concurrency/`.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const CONTROLEUR = path.join(SRC, "controllers", "internalPaymentsController.js");

function source() {
  return fs.readFileSync(CONTROLEUR, "utf8");
}

test("le contrôleur de paiements internes écrit au grand livre", () => {
  const s = source();

  assert.match(
    s,
    /postInternalPaymentEntries\s*\(/,
    "`internalPaymentsController.js` ne pose plus d'écriture comptable. Il " +
      "déplace pourtant des portefeuilles (`TxWalletBalance.debit`/`.credit`) : " +
      "de l'argent bougerait sans contrepartie au grand livre (invariants 2 et 4)."
  );
});

/**
 * ⚠️ L'APPARTENANCE À LA TRANSACTION EST LA MOITIÉ DE LA GARANTIE.
 *
 * Poser l'écriture hors de `runWithTransaction` laisserait exactement
 * l'incohérence que ce correctif ferme : un échec entre le mouvement de
 * portefeuille et l'écriture, et le solde aurait bougé sans trace.
 */
test("l'écriture est posée DANS la transaction, et reçoit la session", () => {
  const s = source();

  const debutTx = s.indexOf("runWithTransaction(session");
  assert.notEqual(debutTx, -1, "`runWithTransaction` est introuvable");

  const posePose = s.indexOf("postInternalPaymentEntries({", debutTx);
  assert.notEqual(
    posePose,
    -1,
    "l'écriture comptable est posée HORS de `runWithTransaction` : un échec " +
      "entre le mouvement de portefeuille et l'écriture laisserait un solde " +
      "déplacé sans trace."
  );

  const appel = s.slice(posePose, posePose + 900);
  assert.match(
    appel,
    /session,/,
    "l'appel ne transmet pas `session` : l'écriture partirait hors transaction " +
      "et ne serait pas annulée avec le reste."
  );
});

/**
 * Le contrôle le plus important : **aucune mutation de portefeuille ne doit
 * exister dans ce fichier sans que l'écriture comptable soit posée**. Les deux
 * contrôles précédents resteraient verts si quelqu'un ajoutait une troisième
 * mutation en oubliant de la déclarer.
 */
test("toute mutation de portefeuille du fichier est couverte par une écriture", () => {
  const s = source();

  const mutations = [...s.matchAll(/TxWalletBalance\.(debit|credit)\s*\(/g)].map(
    (m) => m[1]
  );

  assert.ok(
    mutations.length > 0,
    "aucune mutation trouvée : ce test a perdu sa cible, le motif a changé"
  );

  // Chaque côté muté doit avoir son drapeau, et le drapeau doit alimenter la pose.
  for (const cote of new Set(mutations)) {
    const drapeau = cote === "debit" ? "debited" : "credited";

    assert.match(
      s,
      new RegExp(`${drapeau}\\s*=\\s*true`),
      `une mutation \`${cote}\` existe mais rien ne pose \`${drapeau}\` : ` +
        "l'écriture comptable correspondante ne sera jamais posée."
    );

    assert.match(
      s,
      new RegExp(`${drapeau}\\s*\\n?\\s*\\?`),
      `\`${drapeau}\` n'alimente pas \`postInternalPaymentEntries\` : le ` +
        "portefeuille bougerait sans contrepartie comptable."
    );
  }
});
