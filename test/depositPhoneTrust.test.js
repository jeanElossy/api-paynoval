"use strict";

/**
 * ============================================================================
 * LA CONFIANCE DU NUMÉRO DE DÉPÔT EST TENUE DANS LE MOTEUR
 * ============================================================================
 *
 * Volet « présence » de la paire dont le volet « absence » vit au bord
 * (`api-gateway/test/transactions/edgeHasNoDepositTrust.test.js`). Un
 * déplacement ne se prouve que par les deux : sans celui-ci, on pourrait
 * supprimer le contrôle du bord et croire l'avoir déplacé.
 *
 * Test **pur** : aucune connexion, aucun serveur, aucun appel réseau.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const RACINE = path.resolve(__dirname, "..");

function lire(...s) {
  return fs.readFileSync(path.join(RACINE, ...s), "utf8");
}

function sansCommentaires(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const {
  concerneCeControle,
  railNormalise,
} = require("../src/services/risk/depositPhoneTrust");

const { toE164 } = require("../src/utils/phone");

/* ══════════════════════════════════════════════════════════════════════════
 * LE CONTRÔLE NE SE CONTOURNE PAS PAR UNE ORTHOGRAPHE
 * ══════════════════════════════════════════════════════════════════════════ */

test("les six écritures du rail mobile money déclenchent le contrôle", () => {
  /**
   * ⚠️ LE PIRE MODE DE DÉFAILLANCE POSSIBLE POUR CE CONTRÔLE.
   *
   * Le rail s'écrit de six façons dans le dépôt, et l'application mobile envoie
   * `mobile_money` avec un tiret bas (`montant.js:303`). Une comparaison
   * stricte à `"mobilemoney"` ferait que le contrôle ne s'exécuterait
   * simplement JAMAIS sur un vrai encaissement — sans erreur, sans journal,
   * sans rien.
   *
   * Un contrôle qui refuse à tort se voit en une heure. Un contrôle qui ne
   * s'exécute pas ne se voit qu'à l'incident.
   */
  for (const funds of [
    "mobilemoney",
    "mobile_money",
    "mobile-money",
    "momo",
    "wave",
    "orange",
    "mtn",
    "moov",
  ]) {
    assert.equal(
      concerneCeControle({ action: "deposit", funds, destination: "paynoval" }),
      true,
      `« ${funds} » n'est pas reconnu comme un encaissement mobile money : ` +
        "le contrôle du numéro ne s'appliquerait pas, silencieusement."
    );
  }
});

test("les flux qui ne désignent pas un numéro tiers ne sont pas concernés", () => {
  const horsPerimetre = [
    { action: "send", funds: "paynoval", destination: "paynoval" },
    { action: "withdraw", funds: "paynoval", destination: "mobilemoney" },
    { action: "deposit", funds: "card", destination: "paynoval" },
  ];

  for (const cas of horsPerimetre) {
    assert.equal(
      concerneCeControle(cas),
      false,
      `${cas.action} ${cas.funds}→${cas.destination} ne devrait pas être ` +
        "contrôlé : un retrait ENVOIE vers un numéro sans en débiter le titulaire."
    );
  }
});

test("le rail se normalise, l'inconnu reste inconnu", () => {
  assert.equal(railNormalise("WAVE"), "mobilemoney");
  assert.equal(railNormalise("paynoval"), "paynoval");

  /** Pas de repli : un rail inconnu ne devient pas un rail connu. */
  assert.equal(railNormalise("bitcoin"), "bitcoin");
  assert.equal(railNormalise(""), "");
});

/* ══════════════════════════════════════════════════════════════════════════
 * LA NORMALISATION DU NUMÉRO ÉCHOUE EN FERMETURE
 * ══════════════════════════════════════════════════════════════════════════ */

test("sans pays, un numéro local ne prend pas d'indicatif par défaut", () => {
  /**
   * ⚠️ LE DÉFAUT QUE CE TEST EMPÊCHE DE REVENIR.
   *
   * `payNoval-master/app/operations/recipient-selection.js:109` fait
   * `inferDefaultCountryDial = () => "+225"` — l'indicatif ivoirien EN DUR.
   * Un numéro sénégalais y devient un numéro ivoirien syntaxiquement valide,
   * qui appartient à quelqu'un d'autre.
   *
   * Deviner un indicatif, c'est deviner un destinataire.
   */
  assert.equal(toE164("0700000000", "").e164, "");
  assert.equal(toE164("700000000", "").e164, "");
});

test("les bornes de longueur locale sont conservées", () => {
  /** Sans elles, `0700` devient un E.164 correct qui ne joint personne. */
  assert.equal(toE164("0700", "CI").e164, "");
  assert.equal(toE164("0700000000", "CI").e164, "+2250700000000");

  /** Le Sénégal a des numéros de 9 chiffres, pas 10. */
  assert.equal(toE164("700000000", "SN").e164, "+221700000000");
  assert.equal(toE164("70000000", "SN").e164, "");
});

test("un pays hors périmètre n'ouvre pas de chemin par défaut", () => {
  assert.equal(toE164("70000000", "XX").e164, "");
});

/* ══════════════════════════════════════════════════════════════════════════
 * LE CÂBLAGE — UN CONTRÔLE NON BRANCHÉ NE CONTRÔLE RIEN
 * ══════════════════════════════════════════════════════════════════════════ */

test("la barrière est sur la chaîne de /initiate", () => {
  /**
   * ⚠️ L'ASSERTION QUI COMPTE LE PLUS.
   *
   * Le défaut d'origine côté bord n'était pas du mauvais code : c'était un
   * routeur parfaitement écrit que personne ne montait. Écrire le contrôle ne
   * suffit pas — il faut prouver qu'il est TRAVERSÉ.
   */
  const routes = sansCommentaires(lire("src", "routes", "transactionsRoutes.js"));

  assert.match(
    routes,
    /requireTrustedDepositPhone/,
    "`requireTrustedDepositPhone` n'apparaît plus dans les routes transactions."
  );

  const initiate = routes.slice(routes.indexOf('router.post(\n  "/initiate"'));
  const fin = initiate.indexOf("asyncHandler(initiateByFlow)");

  assert.ok(fin > 0, "La chaîne de `/initiate` est introuvable.");

  assert.ok(
    initiate.slice(0, fin).includes("requireTrustedDepositPhone"),
    "La barrière n'est plus DANS la chaîne de `/initiate`. Un middleware " +
      "importé mais non monté ne contrôle rien — c'est exactement le défaut " +
      "qu'on vient de fermer au bord."
  );
});

test("la décision ne parle pas à Twilio en direct", () => {
  /**
   * Le backend principal possède Email/Push/SMS. Rebrancher Twilio ici
   * recréerait un SECOND jeu d'identifiants, donc deux quotas, deux factures et
   * deux comportements d'erreur — la situation exacte qu'on vient de défaire.
   */
  const client = lire("src", "services", "notifications", "phoneOtpClient.js");
  const decision = lire("src", "services", "risk", "depositPhoneTrust.js");

  for (const [nom, src] of [["client OTP", client], ["décision", decision]]) {
    assert.ok(
      !/require\(\s*["']twilio["']\s*\)/.test(src),
      `Le ${nom} requiert \`twilio\` directement. Le canal SMS a UN propriétaire.`
    );
  }

  assert.match(
    client,
    /\/api\/v1\/internal\/verification\/phone\//,
    "Le client OTP ne vise plus la capacité interne du backend principal."
  );
});

test("aucun code OTP ne peut être journalisé", () => {
  /**
   * Règle B.4 : rien de sensible ne sort ni ne se journalise. Un code à usage
   * unique dans un journal reste exploitable pendant sa durée de vie.
   */
  const controleur = lire(
    "src",
    "controllers",
    "depositPhoneVerification.controller.js"
  );

  /**
   * ⚠️ EXTRACTION PAR PARENTHÈSES ÉQUILIBRÉES, PAS PAR `[^)]*`.
   *
   * La première version extrayait les appels avec `/logger\.\w+\([^)]*\)/`.
   * Ce motif s'arrête à la PREMIÈRE parenthèse fermante — donc à celle de
   * `last4(phoneE164)` — et tronquait l'appel avant ses arguments suivants.
   * La fuite `{ phone: last4(…), code }` tombait hors du texte examiné : le
   * test passait, et la fuite avec lui.
   *
   * Le défaut n'a été trouvé qu'en RÉINTRODUISANT la faute et en constatant que
   * le test restait vert. Relire le motif ne l'aurait pas montré.
   */
  function appelsAuJournal(src) {
    const trouves = [];
    const debut = /logger\.\w+\(/g;

    let m;
    while ((m = debut.exec(src)) !== null) {
      let i = m.index + m[0].length;
      let profondeur = 1;

      while (i < src.length && profondeur > 0) {
        if (src[i] === "(") profondeur += 1;
        else if (src[i] === ")") profondeur -= 1;
        i += 1;
      }

      trouves.push(src.slice(m.index, i));
    }

    return trouves;
  }

  const journaux = appelsAuJournal(controleur);

  assert.ok(
    journaux.length > 0,
    "Aucun appel au journal trouvé : l'extraction est cassée, et un test qui " +
      "n'examine rien passe toujours."
  );

  /**
   * ⚠️ VISER LA VARIABLE `code`, PAS LE MOT « code ».
   *
   * Une première version de ce test interdisait `\bcode\b` dans tout appel au
   * journal. Elle signalait `code: err?.code || "INCONNU"` — un code d'ERREUR
   * (`OTP_UPSTREAM_TIMEOUT`), qui n'a rien de sensible et qu'on veut justement
   * voir dans les journaux.
   *
   * Un test qui crie sur du code sain finit désactivé, et emporte avec lui la
   * protection qu'il apportait. On affûte donc au lieu d'affaiblir : seul le
   * passage de la VALEUR `code` (celle de `req.body.code`) est interdit.
   *
   * ⚠️ LA PREMIÈRE VERSION AFFÛTÉE NE MORDAIT PLUS. Elle exigeait `{` juste
   * avant `code` et ratait donc `{ phone: …, code }` — le raccourci APRÈS une
   * virgule, c'est-à-dire la forme la plus probable dans un vrai journal. Le
   * test passait, la fuite passait avec lui. Trouvé en réintroduisant la faute,
   * pas en relisant le motif.
   *
   *   · `{ code }` / `{ a, code }` — raccourci d'objet     → INTERDIT
   *   · `{ x: code }`      — affectation depuis la variable → INTERDIT
   *   · `${code}`          — interpolation              → INTERDIT
   *   · `{ code: err?.code }` — code d'erreur           → autorisé
   */
  const FUITE_OTP = [
    /[{,]\s*code\s*[,}]/,
    /:\s*code\s*[,}]/,
    /\$\{\s*code\s*\}/,
  ];

  for (const ligne of journaux) {
    for (const motif of FUITE_OTP) {
      assert.ok(
        !motif.test(ligne),
        `Un journal transporte la valeur du code OTP : ${ligne.slice(0, 90)}`
      );
    }
  }

  /** Les numéros ne paraissent qu'en quatre derniers chiffres. */
  assert.match(
    controleur,
    /last4\(/,
    "Le contrôleur ne masque plus les numéros dans ses journaux."
  );
});
