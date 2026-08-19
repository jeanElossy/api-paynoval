"use strict";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * UN INDEX INCRÉABLE NE SE SIGNALE JAMAIS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MongoDB n'accepte qu'un sous-ensemble d'opérateurs dans un
 * `partialFilterExpression`. `$ne`, `$not`, `$nin`, `$regex` et `$expr` en sont
 * exclus : la création échoue avec « Expression not supported in partial
 * index ».
 *
 * Ce qui rend ce défaut coûteux, c'est son silence. `autoIndex` est désactivé
 * en production ; l'index n'est donc jamais tenté au démarrage, aucune erreur
 * n'apparaît, et le schéma affiche une garantie que la base ne porte pas.
 *
 * Constaté le 2026-08-19 sur ce dépôt : `{sender, idempotencyKey}` et
 * `{userId, idempotencyKey}`, deux index UNIQUES censés empêcher un virement
 * en double, étaient déclarés avec `$ne` — donc absents de la base depuis
 * toujours. Le middleware d'idempotence s'appuyait pourtant explicitement sur
 * eux lorsque son registre est indisponible.
 *
 * Ce test lit le SOURCE des modèles : aucune connexion, aucun schéma compilé,
 * conformément à la contrainte de logique pure des suites du projet.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const MODELS_DIR = path.join(__dirname, "..", "src", "models");

const OPERATEURS_INTERDITS = ["$ne", "$not", "$nin", "$regex", "$expr"];

/**
 * Isole chaque `partialFilterExpression: { ... }` en équilibrant les accolades.
 * Une expression régulière ne suffirait pas : ces filtres contiennent des
 * objets imbriqués, et un `.*?}` s'arrêterait à la première accolade fermante.
 */
function extrairePartialFilters(source) {
  const filtres = [];
  const marqueur = "partialFilterExpression";
  let depart = source.indexOf(marqueur);

  while (depart !== -1) {
    const ouvrante = source.indexOf("{", depart);

    if (ouvrante !== -1) {
      let profondeur = 0;
      let i = ouvrante;

      for (; i < source.length; i += 1) {
        if (source[i] === "{") profondeur += 1;
        else if (source[i] === "}") {
          profondeur -= 1;
          if (profondeur === 0) break;
        }
      }

      filtres.push({
        contenu: source.slice(ouvrante, i + 1),
        ligne: source.slice(0, ouvrante).split("\n").length,
      });
    }

    depart = source.indexOf(marqueur, depart + marqueur.length);
  }

  return filtres;
}

/** Les commentaires citent souvent les opérateurs interdits : on les retire. */
function retirerCommentaires(texte) {
  return texte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function listerModeles() {
  return fs
    .readdirSync(MODELS_DIR)
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join(MODELS_DIR, f));
}

test("il y a bien des modèles à inspecter", () => {
  // Garde-fou du garde-fou : un test qui n'inspecte rien passe toujours.
  assert.ok(listerModeles().length > 0);
});

test("aucun modèle n'utilise un opérateur refusé dans un filtre partiel", () => {
  const fautes = [];

  for (const fichier of listerModeles()) {
    const source = fs.readFileSync(fichier, "utf8");

    for (const filtre of extrairePartialFilters(source)) {
      const utile = retirerCommentaires(filtre.contenu);

      for (const op of OPERATEURS_INTERDITS) {
        if (utile.includes(op)) {
          fautes.push(
            `${path.basename(fichier)}:${filtre.ligne} → ${op} ` +
              `(remplacer par $type, ou $gt: "" pour exclure la chaîne vide)`
          );
        }
      }
    }
  }

  assert.deepEqual(fautes, []);
});

test("l'extracteur suit les accolades imbriquées", () => {
  const source = `
    schema.index({ a: 1 }, {
      partialFilterExpression: {
        a: { $type: "string", $gt: "" },
        b: { $exists: true },
      },
    });
  `;

  const [filtre] = extrairePartialFilters(source);

  assert.ok(filtre.contenu.includes("$exists"));
  assert.ok(filtre.contenu.trim().endsWith("}"));
});

test("détecte réellement une déclaration fautive", () => {
  // Un contrôle incapable de détecter la faute qu'il cherche ne protège de rien.
  const fautif = `partialFilterExpression: { k: { $type: "string", $ne: "" } }`;
  const [filtre] = extrairePartialFilters(fautif);

  assert.ok(retirerCommentaires(filtre.contenu).includes("$ne"));
});

test("ne se laisse pas tromper par un $ne cité en commentaire", () => {
  const commente = `partialFilterExpression: {
    // $ne est interdit ici
    k: { $type: "string", $gt: "" },
  }`;
  const [filtre] = extrairePartialFilters(commente);

  assert.ok(!retirerCommentaires(filtre.contenu).includes("$ne"));
});
