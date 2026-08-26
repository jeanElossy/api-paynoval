"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { STATUSES } = require("../src/models/Transaction");
const { STATES, ALLOWED } = require("../src/services/transactionStateMachine");

/**
 * ============================================================================
 * INVARIANT : AUCUN STATUT ÉCRIT NE DOIT SORTIR DE L'ÉNUMÉRATION
 * ============================================================================
 *
 * CE QUE CE TEST AURAIT ATTRAPÉ
 * -----------------------------
 * Deux gestionnaires écrivaient `tx.status = "completed"`, un statut ABSENT de
 * `STATUSES`. Le `tx.save()` levait donc une erreur de validation Mongoose, et
 * les deux chemins sandbox de la revue App Store échouaient en 500 — sans que
 * rien ne le signale, puisque aucun test n'emprunte ces chemins.
 *
 * POURQUOI UN TEST STATIQUE PLUTÔT QU'UN TEST D'INTÉGRATION
 * ---------------------------------------------------------
 * Couvrir ces chemins à l'exécution demanderait une connexion Mongo, une
 * transaction, un utilisateur sandbox — donc une suite lente, qui n'existe pas
 * ici et dont l'absence est un CHOIX (les cinq suites du dépôt tournent en
 * quelques secondes parce qu'aucune n'ouvre de connexion).
 *
 * Lire le source attrape la même faute, en quelques millisecondes, et sur TOUS
 * les chemins — y compris ceux que personne n'a pensé à tester. C'est le bon
 * outil pour cet invariant précis : la liste des valeurs écrites est une
 * propriété syntaxique, pas comportementale.
 *
 * CE QU'IL NE COUVRE PAS, ET C'EST ASSUMÉ
 * ---------------------------------------
 * Un statut calculé (`tx.status = someVar`) échappe à l'analyse. Le test ne
 * prétend donc pas à l'exhaustivité — il verrouille les littéraux, qui sont la
 * forme sous laquelle la faute est apparue les deux fois.
 */

const SRC = path.join(__dirname, "..", "src");

/** Fichiers à balayer : tout `src/`, hors répertoires sans logique de statut. */
function collectSources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (["node_modules", "aml"].includes(entry.name)) continue;
      collectSources(full, out);
    } else if (entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Retire les commentaires avant analyse.
 *
 * Indispensable : plusieurs gestionnaires conservent en tête un bloc commenté
 * de l'ANCIENNE version du code — `cancelTransaction.js` et
 * `confirmTransaction.js` en ont des dizaines de lignes. Sans ce nettoyage, le
 * test signalerait des écritures qui n'existent plus, et le premier réflexe
 * serait de le désactiver.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/** `tx.status = "..."` / `transaction.status = "..."` / `status: "..."` */
const WRITE_PATTERNS = [
  /\b(?:tx|transaction|doc)\.status\s*=\s*["']([a-z_]+)["']/gi,
  /\bstatus:\s*["']([a-z_]+)["']\s*(?:,|\})/gi,
];

/**
 * Champs `status` qui n'appartiennent PAS à `Transaction` et ont légitimement
 * leur propre vocabulaire. Les exclure par FICHIER, pas par valeur : exclure la
 * valeur `"completed"` reviendrait à rouvrir exactement le trou qu'on ferme.
 */
const FOREIGN_STATUS_FILES = new Set([
  "IdempotencyRecord.js",       // in_progress | completed
  "TxRefundRequest.js",         // cycle de vie d'une demande de remboursement
  "LedgerEntry.js",             // PENDING | POSTED | REVERSED
  "Outbox.js",                  // pending | processing | retry | done
  "ReferralPayout.js",
  "CagnotteSettlement.js",
  "CagnotteVaultWithdrawalSettlement.js",
  "AMLLog.js",
  "Device.js",
  "User.js",
  "cancellation.service.js",    // écrit le statut des TxRefundRequest
  "orangeAdapter.js",           // canonicalStatus() → vocabulaire PRESTATAIRE
  "mtnAdapter.js",
  "moovAdapter.js",
  "waveAdapter.js",
  "stripeAdapter.js",
  "visaDirectAdapter.js",
  "bankGenericAdapter.js",
]);

test("aucun littéral de statut de transaction hors STATUSES", () => {
  const violations = [];

  for (const file of collectSources(SRC)) {
    const base = path.basename(file);
    if (FOREIGN_STATUS_FILES.has(base)) continue;

    const src = stripComments(fs.readFileSync(file, "utf8"));

    for (const pattern of WRITE_PATTERNS) {
      pattern.lastIndex = 0;
      let m;

      while ((m = pattern.exec(src)) !== null) {
        const value = m[1].toLowerCase();

        // `status: "..."` sert aussi à filtrer/comparer ; on ne retient que ce
        // qui n'est PAS un statut connu — une valeur étrangère au domaine
        // (`"active"`, `"open"`…) appartient à un autre champ `status`.
        if (STATUSES.includes(value)) continue;

        const line = src.slice(0, m.index).split("\n").length;
        violations.push({
          file: path.relative(SRC, file),
          line,
          value,
          snippet: m[0].trim(),
        });
      }
    }
  }

  // Seules les écritures directes sur `.status` sont bloquantes : `status: "x"`
  // dans un littéral d'objet est trop souvent un filtre de requête.
  const hard = violations.filter((v) => /\.status\s*=/.test(v.snippet));

  assert.deepEqual(
    hard,
    [],
    "Statut écrit hors énumération :\n" +
      hard.map((v) => `  ${v.file}:${v.line} → ${v.snippet}`).join("\n") +
      `\n\nStatuts valides : ${STATUSES.join(", ")}`
  );
});

test("« completed » n'est PAS un statut de transaction — c'est un statut prestataire", () => {
  /**
   * Verrou de non-régression. Si quelqu'un « corrige » un futur échec de
   * validation en ajoutant `"completed"` à l'énumération, ce test le refuse et
   * explique pourquoi : deux statuts de succès pour la même réalité, ce que §24
   * de l'architecture interdit.
   */
  assert.ok(
    !STATUSES.includes("completed"),
    "Ajouter « completed » créerait un second statut de succès à côté de " +
      "« confirmed ». Le vocabulaire prestataire (canonicalStatus) doit rester " +
      "distinct du statut de transaction."
  );

  assert.ok(STATUSES.includes("confirmed"), "« confirmed » est le succès déclaré");
});

test("la machine à états et le modèle partagent exactement le même vocabulaire", () => {
  /**
   * Les deux listes sont écrites séparément (`transactionStateMachine.js` et
   * `models/Transaction.js`). Une divergence entre elles est la même classe de
   * défaut que `"completed"` : un statut que l'une accepte et que l'autre
   * refuse à l'écriture.
   */
  const machineStates = Object.values(STATES).sort();
  const modelStatuses = [...STATUSES].sort();

  assert.deepEqual(
    machineStates,
    modelStatuses,
    "Divergence entre STATES (machine à états) et STATUSES (modèle)"
  );
});

test("toute transition déclarée mène vers un statut valide", () => {
  for (const [from, targets] of Object.entries(ALLOWED)) {
    assert.ok(STATUSES.includes(from), `état source inconnu : ${from}`);

    for (const to of targets) {
      assert.ok(
        STATUSES.includes(to),
        `transition ${from} → ${to} : « ${to} » n'est pas un statut valide`
      );
    }
  }
});

test("le statut de succès du chemin sandbox est bien le statut déclaré", () => {
  /**
   * Test ciblé sur les deux sites précis qui portaient le défaut, pour que la
   * régression soit nommée et non seulement couverte par l'invariant général.
   */
  const files = [
    "services/transactions/handlers/confirmTransaction.js",
    "services/transactions/handlers/submitExternalExecution.js",
  ];

  for (const rel of files) {
    const src = stripComments(fs.readFileSync(path.join(SRC, rel), "utf8"));

    assert.ok(
      !/\.status\s*=\s*["']completed["']/.test(src),
      `${rel} écrit encore le statut inexistant « completed »`
    );

    assert.ok(
      /\.status\s*=\s*["']confirmed["']/.test(src),
      `${rel} doit écrire « confirmed »`
    );
  }
});
