"use strict";

/**
 * AUCUN CHEMIN D'ARGENT NE CONTOURNE LE GRAND LIVRE
 * ============================================================================
 *
 * Le 2026-09-03, l'audit de `docs/architecture/transaction-engine.md` a trouvé
 * `POST /api/v1/pay` : une route montée (`src/server.js`), authentifiée
 * (`protect`), qui débitait et créditait `tx_wallet_balances` EN DIRECT via
 * `src/services/transactions.js`, sans écrire une seule `LedgerEntry`, sans
 * idempotence, sans machine à états, avec `Math.random()` pour référence et
 * `'F CFA'` en dur pour devise.
 *
 * Elle n'avait rien cassé parce qu'elle était cassée : trois erreurs de
 * programmation indépendantes la faisaient sortir en 500 avant la première
 * écriture. C'est précisément ce qui la rendait dangereuse — elle ressemblait à
 * un bug d'une ligne, et sa correction « évidente » aurait ouvert un mouvement
 * d'argent invisible du grand livre (invariants 2, 3, 4, 12).
 *
 * Ce que ce test verrouille — et qui le fait ÉCHOUER si on réintroduit la faute :
 *   1. les primitives de `services/transactions.js` échouent en fermeture ;
 *   2. `routes/pay.js` ne touche plus à aucun solde ;
 *   3. la route répond 410 et le dit explicitement ;
 *   4. aucun module de `src/` n'importe ces primitives ;
 *   5. aucun autre fichier ne débite/crédite un portefeuille hors des chemins
 *      qui écrivent au grand livre.
 *
 * Le point 5 est le vrai filet : les quatre premiers ferment CETTE route, le
 * cinquième empêche qu'une autre reprenne le même raccourci ailleurs.
 *
 * Aucune connexion Mongo, aucun serveur : lecture de fichiers et invocation
 * directe du gestionnaire de route.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const RACINE = path.join(__dirname, "..");
const lire = (rel) => fs.readFileSync(path.join(RACINE, rel), "utf8");

/**
 * Retire commentaires de bloc et de ligne. Indispensable ici : les fichiers
 * corrigés NOMMENT les primitives retirées pour expliquer leur retrait.
 */
function sansCommentaires(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/* -------------------------------------------------------------------------- */
/* 1. Les primitives échouent en fermeture                                    */
/* -------------------------------------------------------------------------- */

test("les primitives d'argent sans grand livre lèvent au lieu d'écrire", () => {
  const primitives = require("../src/services/transactions");

  for (const nom of [
    "debitUser",
    "creditUserByEmail",
    "transfer",
    "findUserByEmail",
    "findWalletByUserId",
    "findBalanceByUserId",
  ]) {
    assert.equal(typeof primitives[nom], "function", `${nom} doit rester exportée`);
    assert.throws(
      () => primitives[nom]("qui-que-ce-soit", "XOF", 1000),
      (err) => {
        assert.equal(
          err.code,
          "LEDGERLESS_MONEY_PATH_REMOVED",
          `${nom} doit échouer en fermeture avec un code explicite`
        );
        assert.match(err.message, /grand livre/i);
        return true;
      },
      `${nom} ne doit RIEN écrire : elle doit lever`
    );
  }
});

test("le module ne contient plus aucune écriture de solde", () => {
  // Hors commentaires : l'en-tête du module CITE les primitives retirées pour
  // expliquer pourquoi elles le sont. Chercher dans le fichier brut ferait
  // échouer ce test sur sa propre documentation.
  const src = sansCommentaires(lire("src/services/transactions.js"));

  for (const interdit of [
    "TxWalletBalance.debit",
    "TxWalletBalance.credit",
    ".withTransaction(",
    "startSession(",
  ]) {
    assert.ok(
      !src.includes(interdit),
      `services/transactions.js ne doit plus contenir « ${interdit} » : ` +
        "ces primitives écrivaient le solde sans écrire le grand livre."
    );
  }
});

/* -------------------------------------------------------------------------- */
/* 2 & 3. La route est fermée, et le dit                                      */
/* -------------------------------------------------------------------------- */

test("routes/pay.js ne déplace plus d'argent", () => {
  const code = sansCommentaires(lire("src/routes/pay.js"));

  for (const interdit of [
    "debitUser(",
    "creditUserByEmail(",
    "TxWalletBalance",
    "Transaction.create(",
    "Math.random(",
  ]) {
    assert.ok(
      !code.includes(interdit),
      `routes/pay.js ne doit plus appeler « ${interdit} »`
    );
  }
});

test("POST /api/v1/pay répond 410 et nomme le chemin légitime", () => {
  const router = require("../src/routes/pay");

  // On extrait le gestionnaire du routeur Express sans démarrer de serveur.
  const couche = router.stack.find((c) => c.route);
  assert.ok(couche, "le routeur doit exposer au moins une route");

  const gestionnaire = couche.route.stack[couche.route.stack.length - 1].handle;

  let statutRendu = null;
  let corpsRendu = null;
  const res = {
    status(code) {
      statutRendu = code;
      return this;
    },
    json(corps) {
      corpsRendu = corps;
      return this;
    },
  };

  gestionnaire({ method: "POST", body: {}, headers: {}, user: null }, res);

  assert.equal(statutRendu, 410, "un chemin d'argent retiré doit répondre 410");
  assert.equal(corpsRendu.success, false);
  assert.equal(corpsRendu.code, "PAY_ROUTE_REMOVED");
  assert.match(
    corpsRendu.error,
    /transactions\/initiate/,
    "le refus doit nommer le chemin légitime, sinon l'appelant cherchera un contournement"
  );
});

/* -------------------------------------------------------------------------- */
/* 4. Plus aucun importateur                                                  */
/* -------------------------------------------------------------------------- */

/** Tous les .js sous `src/`, récursivement. */
function fichiersSource(dossier = path.join(RACINE, "src"), acc = []) {
  for (const e of fs.readdirSync(dossier, { withFileTypes: true })) {
    const p = path.join(dossier, e.name);
    if (e.isDirectory()) fichiersSource(p, acc);
    else if (e.name.endsWith(".js")) acc.push(p);
  }
  return acc;
}

test("aucun module de src/ n'importe les primitives retirées", () => {
  // `services/transactions` — et non `services/transactions/…`, qui est le
  // répertoire légitime des handlers.
  const motif = /require\(\s*["'][^"']*services\/transactions["']\s*\)/;

  const coupables = fichiersSource()
    .filter((f) => !f.endsWith(path.join("services", "transactions.js")))
    .filter((f) => motif.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(RACINE, f));

  assert.deepEqual(
    coupables,
    [],
    "ces fichiers importent des primitives qui écrivent le solde sans grand livre"
  );
});

/* -------------------------------------------------------------------------- */
/* 5. Le filet : personne d'autre ne prend le raccourci                       */
/* -------------------------------------------------------------------------- */

test("les écritures directes de solde restent cantonnées aux chemins connus", () => {
  /**
   * `TxWalletBalance.debit/credit` déplacent des fonds. Chaque fichier qui les
   * appelle DOIT être un chemin qui écrit aussi le grand livre — ou être
   * explicitement listé ici avec sa raison.
   *
   * Cette liste est une frontière, pas une commodité : y ajouter un fichier
   * est une décision d'architecture (invariant 2). Si ce test échoue sur un
   * nouveau fichier, la question n'est pas « comment faire passer le test »,
   * c'est « ce fichier écrit-il au grand livre ? ».
   */
  const AUTORISES = new Set([
    // Le modèle lui-même : c'est lui qui définit debit/credit.
    "src/models/TxWalletBalance.js",

    // Vérifiés le 2026-09-03 : chacun écrit le grand livre.
    //   `postInternalPaymentEntries` (ledgerService).
    //   La compensation manuelle du bloc `catch`, qui recréditait le solde SANS
    //   contre-écriture, a été RETIRÉE le même jour (l:695). Le mode dégradé
    //   (`canShareSession() === false`) est désormais refusé en 503 AVANT tout
    //   mouvement, et un argent déplacé hors transaction est signalé par le
    //   marqueur `MONEY_MOVED_WITHOUT_TRANSACTION` (l:715) — jamais rattrapé.
    //   Verrouillé par `test/internalPaymentsAtomicOnly.test.js`.
    "src/controllers/internalPaymentsController.js",
    // 5 références au grand livre ; ajustements admin avec contre-écriture.
    "src/services/adminAdjustmentExecutionService.js",
    // 10 références au grand livre ; transferts de parrainage.
    "src/services/internalReferralTransferService.js",
  ]);

  const motif = /TxWalletBalance\.(debit|credit)\s*\(/;

  const inattendus = fichiersSource()
    .map((f) => path.relative(RACINE, f))
    .filter((rel) => !AUTORISES.has(rel.split(path.sep).join("/")))
    .filter((rel) => motif.test(lire(rel)));

  assert.deepEqual(
    inattendus,
    [],
    "écriture directe de solde hors des chemins autorisés — vérifier que le " +
      "grand livre est écrit, puis inscrire le fichier dans AUTORISES avec sa raison"
  );
});
