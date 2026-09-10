"use strict";

/**
 * ============================================================================
 * AUCUN RAIL DU PÉRIMÈTRE NE ROULE SANS PLAFOND
 * ============================================================================
 *
 * ── Le défaut que ce test empêche de revenir ────────────────────────────────
 *
 * `visa_direct` portait DEUX flux ouverts et zéro ligne dans la table des
 * plafonds. Le contrôle AML retombait alors sur un repli de 1 000 000, dans
 * toutes les devises — un plafond que personne n'avait décidé, appliqué à un
 * rail qui déplaçait de l'argent.
 *
 * ── Pourquoi ce test est ICI et non au bord ─────────────────────────────────
 *
 * Il vivait dans `api-gateway/test/railScopeEndToEnd.test.js`, où il liait la
 * table des flux (bord) à la table des plafonds (`tools/amlLimits`). Le
 * 2026-09-10, les plafonds ont cessé d'exister au bord : ils y étaient le
 * TROISIÈME exemplaire d'une même règle, et trois implémentations ne restent
 * pas d'accord.
 *
 * Le test s'est donc scindé selon ce que chaque service possède réellement :
 *
 *   · le bord garde ce qu'il décide — quels couples funds/destination sont
 *     recevables, et l'alias `visa` → `visa_direct` ;
 *   · Tx-Core garde ce qu'il décide — que chaque rail du périmètre porte un
 *     plafond réel.
 *
 * ⚠️ Le périmètre est ÉCRIT ICI, en toutes lettres. C'est délibéré : un test qui
 * dérive sa liste d'une autre table ne défend plus rien le jour où cette table
 * se vide. Ajouter un rail au produit sans l'ajouter ici fait passer ce test
 * pour vert — d'où la liste explicite, et la vérification qu'elle n'est pas
 * vide.
 *
 * Test **pur** : aucune connexion, aucun serveur.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { getSingleTxLimit, getDailyLimit } = require("../src/tools/amlLimits");

/**
 * ⚠️ CE SONT DES RAILS, PAS DES PRESTATAIRES — la distinction porte l'invariant.
 *
 * Première écriture de ce test : j'y avais mis `wave`, `orange`, `mtn` et
 * `moov`. Les quatre ont échoué, et j'ai d'abord cru tenir quatre rails sans
 * plafond. C'était l'inverse : `amlLimits.RAIL_ALIASES` dit en toutes lettres
 * que ces quatre-là sont des **prestataires du rail `mobilemoney`**, et qu'ils
 * ne sont délibérément pas listés. Le plafond se porte au niveau du rail ; le
 * choix de l'opérateur n'en change pas la politique.
 *
 * Le test avait tort, pas le code. Je le note parce qu'un test qui crie sur du
 * code sain finit désactivé, et emporte avec lui la protection qu'il apportait.
 *
 * `paynoval` est exclu : un transfert interne ne quitte pas le grand livre et
 * ne dépend d'aucun prestataire (invariant 13) — ses plafonds relèvent d'une
 * autre politique.
 */
const RAILS_DU_PERIMETRE = Object.freeze(["mobilemoney", "card"]);

/**
 * Les formes sous lesquelles un rail peut arriver dans une requête. Elles
 * doivent TOUTES se ramener au même plafond : c'est la normalisation qui est
 * testée ici, et c'est elle qui a déjà fait retomber `visa_direct` sur un repli
 * de 1 000 000 quand elle manquait.
 */
const ALIAS_ATTENDUS = Object.freeze({
  mobilemoney: ["mobilemoney", "mobile_money", "mobile-money", "momo"],
  card: ["card", "cards", "visa", "visa_direct", "visa-direct", "mastercard"],
});

/** Les devises dans lesquelles ces rails sont effectivement proposés. */
const DEVISES = Object.freeze(["XOF", "EUR", "USD"]);

test("le périmètre testé n'est pas vide — sinon ce fichier ne défend rien", () => {
  assert.ok(RAILS_DU_PERIMETRE.length >= 2);
  assert.ok(DEVISES.length >= 3);
});

test("un opérateur mobile money hérite du plafond de SON RAIL", () => {
  /**
   * L'autre moitié de la distinction rail/prestataire. Si `wave` recevait un
   * plafond propre, deux opérateurs du même rail pourraient diverger sans que
   * personne l'ait décidé.
   *
   * Ce que le code garantit : un opérateur non listé est rendu tel quel par
   * `normalizeRail`, ne correspond à aucune ligne, et LÈVE. L'AML de Tx-Core
   * répond alors 500 — il échoue en fermeture, il ne devine pas un plafond.
   */
  for (const operateur of ["wave", "orange", "mtn", "moov"]) {
    assert.throws(
      () => getSingleTxLimit(operateur, "XOF"),
      `« ${operateur} » a reçu un plafond propre : le rail et le prestataire ` +
        "ont été confondus, et deux opérateurs du même rail peuvent désormais " +
        "diverger sans décision"
    );
  }
});

for (const [rail, formes] of Object.entries(ALIAS_ATTENDUS)) {
  test(`${rail} : toutes ses écritures donnent le même plafond`, () => {
    const reference = getSingleTxLimit(rail, "EUR");

    for (const forme of formes) {
      assert.equal(
        getSingleTxLimit(forme, "EUR"),
        reference,
        `« ${forme} » ne se ramène pas au rail « ${rail} » — il retomberait ` +
          "sur un plafond que personne n'a décidé"
      );
    }
  });
}

for (const rail of RAILS_DU_PERIMETRE) {
  test(`${rail} : plafond unitaire et journalier réels, dans au moins une devise`, () => {
    const couvertures = [];

    for (const devise of DEVISES) {
      let envoi;
      let jour;

      try {
        envoi = getSingleTxLimit(rail, devise);
        jour = getDailyLimit(rail, devise);
      } catch {
        /**
         * Une devise non couverte pour un rail est LÉGITIME — `visa_direct` ne
         * sert pas le XOF. Ce qui ne l'est pas, c'est qu'AUCUNE devise ne le
         * soit : le rail roulerait alors sans politique.
         */
        continue;
      }

      assert.ok(
        Number.isFinite(envoi) && envoi > 0,
        `${rail}/${devise} : plafond unitaire non fini`
      );
      assert.ok(
        Number.isFinite(jour) && jour >= envoi,
        `${rail}/${devise} : plafond journalier incohérent avec l'unitaire`
      );

      /** Les anciennes constantes de repli, qui ne doivent jamais reparaître. */
      assert.notEqual(envoi, 1_000_000, `${rail}/${devise} : plafond de repli détecté`);
      assert.notEqual(jour, 5_000_000, `${rail}/${devise} : plafond de repli détecté`);

      couvertures.push(devise);
    }

    assert.ok(
      couvertures.length > 0,
      `le rail « ${rail} » n'a de plafond dans AUCUNE devise — il roulerait ` +
        "sur le repli, c'est-à-dire sur un plafond que personne n'a décidé"
    );
  });
}

test("un rail inconnu ne reçoit pas de plafond de complaisance", () => {
  /**
   * L'autre moitié de l'invariant. Si `getSingleTxLimit` rendait une valeur
   * pour n'importe quelle chaîne, la garde ci-dessus passerait toujours et ne
   * mesurerait rien (règle B.5).
   */
  assert.throws(() => getSingleTxLimit("rail_forge_xyz", "EUR"));
  assert.throws(() => getDailyLimit("stripe", "EUR"));
});
