"use strict";

/**
 * ============================================================================
 * NORMALISATION E.164 — UNE SEULE RÉPONSE À « QUEL EST CE NUMÉRO ? »
 * ============================================================================
 *
 * ── Pourquoi ce module existe ───────────────────────────────────────────────
 *
 * La même question recevait TROIS réponses différentes selon l'endroit :
 *
 *   · `api-gateway/src/utils/phone.js`      — table de 7 pays, forme `{e164}`
 *   · `phoneSecurity.normalizePhoneE164`    — table de 7 pays AVEC bornes de
 *                                             longueur locale, forme `string`
 *   · `payNoval-master` (`normalizePhoneCI`) — indicatif `+225` EN DUR
 *
 * Trois tables, trois formats de retour, trois verdicts possibles sur le même
 * numéro. Un numéro burkinabè accepté par l'un et rejeté par l'autre, c'est un
 * dépôt qui échoue sans que personne ne sache où.
 *
 * ── Ce qui est conservé de la version la plus stricte ───────────────────────
 *
 * Les bornes `localMin` / `localMax` viennent de `phoneSecurity`. Elles sont
 * la seule chose qui distingue un numéro local valide d'une suite de chiffres :
 * sans elles, `0700` devient `+2250700`, un E.164 syntaxiquement correct qui ne
 * joindra jamais personne. On garde toujours la version qui refuse le plus.
 *
 * ── Ce qui n'est PAS ici ────────────────────────────────────────────────────
 *
 * Aucune déduction d'opérateur à partir du préfixe. Deviner « 07 donc Orange »
 * est une décision de RAIL, et le rail désigne le compte de compensation auquel
 * le règlement sera rapproché. Il vient du choix explicite de l'utilisateur, pas
 * d'une table de préfixes qui se périme à chaque attribution de bloc par le
 * régulateur.
 */

/**
 * Les sept pays du périmètre. Une entrée absente fait échouer la normalisation
 * — elle n'ouvre pas un chemin par défaut.
 *
 * ⚠️ Ajouter un pays ici NE SUFFIT PAS à l'ouvrir : le rail, la tarification et
 * les limites AML ont chacun leur propre table. Cette liste dit « je sais lire
 * ce numéro », pas « on opère dans ce pays ».
 */
const COUNTRY_DIAL = Object.freeze({
  CI: { dial: "225", localMin: 8, localMax: 10 },
  BF: { dial: "226", localMin: 8, localMax: 8 },
  ML: { dial: "223", localMin: 8, localMax: 8 },
  CM: { dial: "237", localMin: 8, localMax: 9 },
  SN: { dial: "221", localMin: 9, localMax: 9 },
  BJ: { dial: "229", localMin: 8, localMax: 8 },
  TG: { dial: "228", localMin: 8, localMax: 8 },
});

/** E.164 : 7 à 15 chiffres, indicatif compris. */
const E164_MIN = 7;
const E164_MAX = 15;

function digitsOnly(v) {
  return String(v || "").replace(/[^\d]/g, "");
}

/**
 * Rend `{ e164, digits }`. Les deux sont vides quand le numéro est inexploitable
 * — jamais une valeur approchée, jamais l'entrée telle quelle.
 *
 * ⚠️ RENDRE `""` PLUTÔT QUE L'ENTRÉE BRUTE EST LE CŒUR DE CE MODULE.
 * Un appelant qui reçoit la chaîne d'origine croit avoir un numéro normalisé et
 * l'écrit en base. On se retrouve alors avec `0700000000` et `+2250700000000`
 * comme deux numéros distincts pour le même téléphone : l'index unique
 * `{ userId, phoneE164 }` ne voit aucun doublon, et un numéro déjà vérifié doit
 * être revérifié. La chaîne vide, elle, est impossible à confondre avec un
 * succès.
 */
function toE164(phone, country) {
  const brut = String(phone || "").trim().replace(/\s+/g, "");
  if (!brut) return { e164: "", digits: "" };

  /* Déjà international : on ne consulte aucune table, on valide la longueur. */
  if (brut.startsWith("+")) {
    const digits = digitsOnly(brut);
    if (digits.length < E164_MIN || digits.length > E164_MAX) {
      return { e164: "", digits: "" };
    }
    return { e164: `+${digits}`, digits };
  }

  const cle = String(country || "").toUpperCase().trim();
  const cfg = COUNTRY_DIAL[cle];

  /**
   * Sans pays connu, on s'arrête. La tentation est de supposer le pays le plus
   * fréquent — c'est ce que fait l'application mobile avec `+225` en dur. Un
   * numéro sénégalais devient alors un numéro ivoirien syntaxiquement valide,
   * qui appartient à quelqu'un d'autre. Deviner un indicatif, c'est deviner un
   * destinataire.
   */
  if (!cfg) return { e164: "", digits: "" };

  const local = digitsOnly(brut);
  if (!local) return { e164: "", digits: "" };
  if (local.length < cfg.localMin || local.length > cfg.localMax) {
    return { e164: "", digits: "" };
  }

  const digits = `${cfg.dial}${local}`;
  if (digits.length < E164_MIN || digits.length > E164_MAX) {
    return { e164: "", digits: "" };
  }

  return { e164: `+${digits}`, digits };
}

/**
 * Les quatre derniers chiffres, pour journaliser sans exporter de donnée
 * personnelle (règle B.4). Un numéro complet dans un journal est une fuite.
 */
function last4(phone) {
  const d = digitsOnly(phone);
  return d ? `••${d.slice(-4)}` : "••";
}

/**
 * Retrouve le numéro principal d'un utilisateur, quelle que soit la forme sous
 * laquelle le backend l'a transmis. Rend `""` si aucune forme n'est exploitable.
 */
function pickUserPrimaryPhoneE164(user, countryFallback) {
  if (!user) return "";

  const direct =
    user.phoneE164 || user.phoneNumber || user.phone || user.mobile || "";
  const pays = user.country || countryFallback || "";

  const premier = toE164(direct, pays).e164;
  if (premier) return premier;

  if (Array.isArray(user.mobiles)) {
    for (const m of user.mobiles) {
      if (!m) continue;
      const candidat = toE164(m.e164 || m.numero, m.country || pays).e164;
      if (candidat) return candidat;
    }
  }

  return "";
}

module.exports = {
  COUNTRY_DIAL,
  digitsOnly,
  toE164,
  last4,
  pickUserPrimaryPhoneE164,
};
