"use strict";

/**
 * ============================================================================
 * LE DEVIS SE CALCULE DANS LE PROCESSUS — ET LA CARTE DOIT LE DIRE
 * ============================================================================
 *
 * Le domaine des prix a été déplacé du bord vers Tx-Core le 2026-09-10, pour
 * supprimer une inversion de dépendance : le moteur d'argent appelait le bord
 * au milieu du chemin de l'argent.
 *
 * Le déplacement a été fait. La CARTE ne l'a pas suivi : la fonction est restée
 * nommée `fetchPricingQuoteFromGateway`, un commentaire annonçait toujours
 * « part en HTTP POST vers la passerelle », le message de journal disait
 * « pricing quote gateway error », et le cache Redis écrivait ses clés sous le
 * segment de service `gateway`.
 *
 * Ces reliquats ne sont pas cosmétiques. Le 2026-09-10, leur lecture a produit
 * un diagnostic FAUX et assuré : « le moteur appelle le bord sur le chemin de
 * l'argent ». Il a fallu ouvrir quatre fichiers pour établir le contraire.
 *
 * Un nom périmé ne se contente pas d'être inexact — il fait porter à celui qui
 * le lit une conclusion fausse, avec assurance.
 *
 * Ce fichier tient DEUX invariants :
 *   1. le chemin du devis ne fait aucun appel réseau ;
 *   2. rien sur ce chemin n'annonce, dans le CODE, un saut vers le bord.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const RACINE = path.join(__dirname, "..");

const CHEMIN_DEVIS = path.join(
  RACINE,
  "src/services/transactions/shared/pricing.js"
);
const DOSSIER_PRIX = path.join(RACINE, "src/services/pricing");

/**
 * Neutralise les COMMENTAIRES seulement — longueurs et sauts de ligne
 * conservés, pour que les numéros de ligne signalés restent justes.
 *
 * ── Pourquoi les commentaires ────────────────────────────────────────────────
 *
 * Sans cela, ce fichier échouerait sur sa PROPRE documentation, et sur les
 * blocs d'historique qui expliquent — légitimement, au passé — l'ancienne
 * architecture. Un garde-fou qui interdit d'expliquer ce qu'on a corrigé pousse
 * à effacer l'explication.
 *
 * ── Pourquoi PAS le contenu des chaînes, contrairement au premier jet ───────
 *
 * La première version vidait aussi les littéraux chaîne. Conséquence mesurée
 * par le test de morsure ci-dessous : `require("axios")` devenait
 * `require("     ")`, et le détecteur de réseau ne pouvait RIEN détecter. Le
 * test « aucun appel réseau » passait à vide.
 *
 * Le nom d'un module et un message de journal vivent tous deux dans une chaîne.
 * Les vider revenait à aveugler le garde-fou sur les deux choses qu'il surveille.
 * Les chaînes sont donc conservées — un `"pricing quote gateway error"`
 * réintroduit est signalé, alors qu'un commentaire d'histoire ne l'est pas.
 */
function sansCommentaires(source) {
  const out = source.split("");
  let i = 0;

  const masquer = (debut, fin) => {
    for (let k = debut; k < fin && k < out.length; k += 1) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };

  while (i < source.length) {
    const c = source[i];
    const d = source[i + 1];

    if (c === "/" && d === "*") {
      const f = source.indexOf("*/", i + 2);
      const stop = f === -1 ? source.length : f + 2;
      masquer(i, stop);
      i = stop;
      continue;
    }

    if (c === "/" && d === "/") {
      let f = source.indexOf("\n", i);
      if (f === -1) f = source.length;
      masquer(i, f);
      i = f;
      continue;
    }

    /**
     * On SAUTE le littéral sans le vider : son contenu est justement ce que
     * les deux détecteurs doivent voir. Le saut reste nécessaire — sans lui,
     * un `"// pas un commentaire"` ou une apostrophe dans un texte français
     * ferait dérailler l'analyse des commentaires.
     */
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === c) break;
        j += 1;
      }
      i = j + 1;
      continue;
    }

    i += 1;
  }

  return out.join("");
}

function fichiersDuPrix() {
  const liste = fs
    .readdirSync(DOSSIER_PRIX)
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join(DOSSIER_PRIX, f));

  return [CHEMIN_DEVIS, ...liste];
}

const RESEAU =
  /\brequire\(\s*["'](?:axios|node-fetch|got|superagent|undici|https?)["']\s*\)|\bfetch\s*\(/;

/**
 * ── LA SORTIE RÉSEAU AUTORISÉE, ET ELLE EST UNIQUE ──────────────────────────
 *
 * Le premier jet de ce test affirmait « le chemin du devis ne fait AUCUN appel
 * réseau ». C'était FAUX, et le test l'a montré aussitôt :
 * `exchangeRateService.js` interroge un fournisseur de taux externe
 * (`exchangerate-api.com`, `open.er-api.com`). C'est légitime — un taux de
 * change vient forcément du dehors.
 *
 * L'invariant qui compte n'est donc pas « zéro réseau », mais :
 *
 *     le chemin du devis sort vers un FOURNISSEUR EXTERNE,
 *     jamais vers un autre service PayNoval.
 *
 * La distinction est toute la question. Sortir vers un fournisseur de taux est
 * une dépendance ASSUMÉE, isolée dans un seul fichier, qui échoue en fermeture.
 * Rappeler le bord était une dépendance qui REMONTE : elle rendait les
 * virements internes tributaires de la disponibilité de la passerelle.
 *
 * Cette liste est un GEL. L'élargir est une décision d'architecture qui se
 * prend en connaissance de cause, pas un ajustement de test.
 */
const SORTIES_RESEAU_AUTORISEES = Object.freeze([
  "src/services/pricing/exchangeRateService.js",
]);

test("la sortie réseau du chemin du devis reste confinée au fournisseur de taux", () => {
  const constatees = [];

  for (const f of fichiersDuPrix()) {
    const code = sansCommentaires(fs.readFileSync(f, "utf8"));
    if (RESEAU.test(code)) constatees.push(path.relative(RACINE, f));
  }

  assert.deepEqual(
    constatees.sort(),
    [...SORTIES_RESEAU_AUTORISEES].sort(),
    "Une sortie réseau NOUVELLE sur le chemin du devis, ou la disparition de " +
      "celle qui est attendue. Une sortie vers un service PayNoval y " +
      "rétablirait l'inversion de dépendance supprimée le 2026-09-10."
  );
});

test("le détecteur de réseau MORD", () => {
  /**
   * Un garde-fou qui ne détecte rien passe toujours. La première version de ce
   * fichier vidait le contenu des littéraux chaîne : `require("axios")` y
   * devenait `require("     ")` et le détecteur était AVEUGLE. C'est ce test-ci
   * qui l'a révélé, pas une relecture.
   */
  assert.ok(RESEAU.test(sansCommentaires('const axios = require("axios");')));
  assert.ok(RESEAU.test(sansCommentaires("await fetch(url);")));

  /* ...et il ne mord pas sur l'historique rédigé en commentaire. */
  assert.ok(
    !RESEAU.test(sansCommentaires('/* Elle postait via require("axios"). */'))
  );
  assert.ok(!RESEAU.test(sansCommentaires("// on n'appelle plus fetch( ici")));
});

test("aucun identifiant du chemin du devis n'annonce un saut vers le bord", () => {
  const fautifs = [];

  for (const f of fichiersDuPrix()) {
    const code = sansCommentaires(fs.readFileSync(f, "utf8"));
    const lignes = code.split("\n");

    lignes.forEach((ligne, i) => {
      /* `GATEWAY_URL`, `fromGateway`, `getGatewayBase`… dans du CODE actif. */
      if (/gateway/i.test(ligne)) {
        fautifs.push(`${path.relative(RACINE, f)}:${i + 1} → ${ligne.trim()}`);
      }
    });
  }

  assert.deepEqual(fautifs, [], fautifs.join("\n"));
});

test("le cache des règles de change s'inscrit sous « tx-core », pas sous le bord", () => {
  const source = fs.readFileSync(
    path.join(DOSSIER_PRIX, "fxRulesService.js"),
    "utf8"
  );

  /**
   * Ce segment entre dans la clé Redis
   * `paynoval:<env>:<service>:<ressource>:<id>`. Le poser au nom d'un autre
   * service annule ce que le segment sert à faire : séparer.
   */
  assert.match(source, /service:\s*"tx-core"/);
  assert.doesNotMatch(sansCommentaires(source), /service:\s*""/);
});
