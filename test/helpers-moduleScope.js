/**
 * DÉTECTION D'UN USAGE AVANT DÉCLARATION, AU NIVEAU MODULE
 * =============================================================================
 *
 * ═══ POURQUOI CE FICHIER EXISTE ══════════════════════════════════════════
 *
 * Un `const` déclaré au niveau module est en **zone morte temporelle** jusqu'à
 * sa ligne : le lire avant lève `ReferenceError: Cannot access 'x' before
 * initialization`, **au chargement du module**, avant que quoi que ce soit ne
 * démarre.
 *
 * C'est exactement ce qui a fait boucler un déploiement : un bloc de
 * configuration inséré au-dessus de `const logger = require("./logger")` le
 * référençait. Le service ne démarrait plus.
 *
 * ⚠️ `node --check` NE L'ATTRAPE PAS : il valide la syntaxe, pas l'ordre
 * d'évaluation. Et les entrées de ces services démarrent un serveur au `require`,
 * donc on ne peut pas simplement les charger dans une suite de tests pure.
 *
 * D'où cette analyse statique : elle reproduit la seule règle qui compte —
 * **ce qui s'évalue au chargement ne peut pas lire ce qui est déclaré plus bas.**
 *
 * ═══ CE QU'ELLE NE SIGNALE PAS, ET POURQUOI ══════════════════════════════
 *
 * Un corps de fonction est **différé** : il ne s'exécute pas au chargement.
 *
 *     const handler = () => logger.info("ok");   // ✅ légitime
 *     const logger = require("./logger");
 *
 * Ici `logger` est lu quand `handler` est appelé, bien après. L'analyse entre
 * donc dans les fonctions sans rien signaler. C'est la distinction qui sépare un
 * vrai défaut d'un faux positif — et c'est aussi pourquoi une simple recherche
 * textuelle ne suffirait pas.
 */

const DEFERRED = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ClassMethod",
  "ObjectMethod",
  "MethodDefinition",
]);

/** Déclarations dont la lecture anticipée lève (contrairement à `var`/`function`). */
const TDZ_KINDS = new Set(["const", "let"]);

function collectTopLevelBindings(program) {
  const bindings = new Map();

  for (const node of program.body) {
    if (node.type === "VariableDeclaration" && TDZ_KINDS.has(node.kind)) {
      for (const d of node.declarations) namesOf(d.id).forEach((n) => {
        if (!bindings.has(n)) bindings.set(n, node.start);
      });
    }

    if (node.type === "ClassDeclaration" && node.id) {
      if (!bindings.has(node.id.name)) bindings.set(node.id.name, node.start);
    }
  }

  return bindings;
}

/** Gère la déstructuration : `const { a, b: c } = …`, `const [x] = …`. */
function namesOf(id, acc = []) {
  if (!id) return acc;

  if (id.type === "Identifier") acc.push(id.name);
  else if (id.type === "ObjectPattern") id.properties.forEach((p) => namesOf(p.value || p.argument, acc));
  else if (id.type === "ArrayPattern") id.elements.forEach((e) => namesOf(e, acc));
  else if (id.type === "AssignmentPattern") namesOf(id.left, acc);
  else if (id.type === "RestElement") namesOf(id.argument, acc);

  return acc;
}

/**
 * @returns {Array<{name, usedAt, declaredAt}>} usages fautifs
 */
function findUseBeforeDeclaration(program, sourceLines) {
  const bindings = collectTopLevelBindings(program);
  const offences = [];

  function visit(node, deferred, ownDeclStart) {
    if (!node || typeof node.type !== "string") return;

    if (DEFERRED.has(node.type)) deferred = true;

    if (!deferred && node.type === "Identifier") {
      const declaredAt = bindings.get(node.name);

      if (declaredAt !== undefined && node.start < declaredAt && ownDeclStart !== declaredAt) {
        offences.push({
          name: node.name,
          usedAt: lineOf(sourceLines, node.start),
          declaredAt: lineOf(sourceLines, declaredAt),
        });
      }
    }

    for (const key of Object.keys(node)) {
      if (key === "start" || key === "end" || key === "loc" || key === "range") continue;

      const child = node[key];

      // Ne pas descendre dans les clés de propriété ni les accès `.membre` :
      // `{ logger: x }` et `a.logger` ne sont pas des lectures de `logger`.
      if (key === "key" && node.type !== "ObjectProperty" && node.type !== "Property") continue;
      if (key === "property" && node.computed === false) continue;
      if (key === "key" && node.computed === false && node.shorthand !== true) continue;

      if (Array.isArray(child)) child.forEach((c) => visit(c, deferred, ownDeclStart));
      else if (child && typeof child.type === "string") visit(child, deferred, ownDeclStart);
    }
  }

  for (const node of program.body) {
    const own =
      node.type === "VariableDeclaration" && TDZ_KINDS.has(node.kind) ? node.start : undefined;

    visit(node, false, own);
  }

  /**
   * Déduplication : une propriété abrégée (`{ logger }`) porte le même
   * identifiant en clé ET en valeur, et serait donc signalée deux fois pour un
   * seul défaut.
   */
  const seen = new Set();

  return offences.filter((o) => {
    const sig = `${o.name}@${o.usedAt}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
}

function lineOf(lines, offset) {
  let total = 0;
  for (let i = 0; i < lines.length; i += 1) {
    total += lines[i].length + 1;
    if (offset < total) return i + 1;
  }
  return lines.length;
}

module.exports = { findUseBeforeDeclaration, collectTopLevelBindings, namesOf };
