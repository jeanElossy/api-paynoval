"use strict";

/**
 * ============================================================================
 * BACK-OFFICE CONFORMITÉ — LE JOURNAL AML EST LA SOURCE, PAS LES TRANSACTIONS
 * ============================================================================
 *
 * ── Ce qui existait avant, et pourquoi c'était faux ─────────────────────────
 *
 * Cette surface vivait dans `api-gateway/controllers/adminCompliance.controller.js`.
 * Elle appelait d'abord `/api/v1/internal/admin/compliance/transactions` — une
 * route qui N'A JAMAIS EXISTÉ dans Tx-Core — récoltait un 404, et se repliait
 * en silence sur `/internal/admin/transactions`. Ce repli :
 *
 *   1. tirait AU PLUS 500 transactions récentes ;
 *   2. les filtrait EN MÉMOIRE, au bord ;
 *   3. détectait les cas par `JSON.stringify(tx).includes("SANCTION")`.
 *
 * Conséquence : un blocage de sanctions survenu 600 transactions plus tôt était
 * INVISIBLE au responsable conformité, et rien ne le disait. Une troncature
 * silencieuse sur une surface réglementaire est le pire endroit où en placer
 * une (règle B.1).
 *
 * ── La source correcte ──────────────────────────────────────────────────────
 *
 * `AMLLog` est le journal d'audit écrit AU MOMENT de la décision, par
 * `services/aml.logTransaction`, avec `flagged` et `flagReason`. Il porte
 * l'index `{ flagged: 1, createdAt: -1 }` : c'est exactement la requête du
 * back-office, et elle se sert en base au lieu de se reconstituer par fouille
 * de texte.
 *
 * Corollaire à ne pas perdre de vue : ce journal ne contient que ce que l'AML a
 * jugé. Une transaction refusée par un autre chemin (rail interdit, éligibilité)
 * n'y figure pas — et c'est correct, ce ne sont pas des cas de conformité.
 *
 * ── Ce qui n'a PAS été repris, volontairement ───────────────────────────────
 *
 * La détection par fouille de JSON (`blob.includes("SANCTION")`). Elle
 * attrapait des cas que le champ nommé n'aurait pas donnés, mais au prix de
 * faux positifs impossibles à expliquer à un régulateur : une transaction dont
 * la description contient le mot « sanction » devenait un cas de sanctions.
 * Ici, le code vient de `flagReason` et de `details.code`, deux champs que
 * l'AML écrit lui-même.
 */

const mongoose = require("mongoose");
const AMLLog = require("../models/AMLLog");
const logger = require("../utils/logger");

/**
 * Table CLOSE des codes de conformité. Elle est identique à celle que servait
 * la passerelle : le back-office web l'affiche telle quelle dans son filtre.
 * En retirer un code masquerait des dossiers ; en ajouter un sans que l'AML ne
 * l'écrive créerait un filtre qui ne rend jamais rien.
 */
const COMPLIANCE_ALERT_CODES = Object.freeze([
  "COMPLIANCE_REVIEW_REQUIRED",
  "SANCTIONS_SCREENING_BLOCKED",
  "PEP_SANCTIONED",
  "BLACKLISTED",
  "BLACKLISTED_USER",
  "BLACKLISTED_EMAIL",
  "BLACKLISTED_PHONE",
  "BLACKLISTED_IBAN",
  "BLACKLISTED_COUNTRY",
  "BLACKLISTED_NAME",
  "BLACKLISTED_SENDER_EMAIL",
  "BLACKLISTED_SENDER_PHONE",
  "RISKY_COUNTRY",
  "AML_SINGLE_LIMIT",
  "AML_DAILY_LIMIT",
  "AML_RATE_LIMIT_1H",
  "AML_STRUCTURING",
  "AML_ML_BLOCK",
]);

function texte(valeur) {
  return String(valeur ?? "").trim();
}

function entier(valeur, defaut, min, max) {
  const n = Number.parseInt(valeur, 10);
  if (!Number.isFinite(n)) return defaut;
  return Math.min(max, Math.max(min, n));
}

/**
 * Le code d'un dossier se lit dans les champs que l'AML A ÉCRITS, dans cet
 * ordre. `flagReason` porte des formes composées (« Sanctions screening:
 * SANCTIONS_HIT ») : on y cherche donc le code, sans fouiller le reste du
 * document.
 */
function codeConformite(entree) {
  const candidats = [
    entree?.details?.code,
    entree?.details?.complianceCode,
    entree?.details?.sanctionsScreening?.reason,
    entree?.details?.blacklistHit?.code,
  ]
    .map(texte)
    .map((v) => v.toUpperCase())
    .filter(Boolean);

  const direct = candidats.find((v) => COMPLIANCE_ALERT_CODES.includes(v));
  if (direct) return direct;

  const motif = texte(entree?.flagReason).toUpperCase();
  if (!motif) return "";

  /**
   * Le plus SPÉCIFIQUE gagne : `BLACKLISTED_EMAIL` doit l'emporter sur
   * `BLACKLISTED`, qui en est un préfixe. Trier par longueur décroissante rend
   * ce choix explicite au lieu de dépendre de l'ordre de la table.
   */
  const trouve = [...COMPLIANCE_ALERT_CODES]
    .sort((a, b) => b.length - a.length)
    .find((code) => motif.includes(code));

  if (trouve) return trouve;

  if (motif.includes("SANCTION")) return "SANCTIONS_SCREENING_BLOCKED";
  if (motif.includes("BLACKLIST")) return "BLACKLISTED";
  if (motif.includes("PEP")) return "PEP_SANCTIONED";
  if (motif.includes("CONFORMITÉ") || motif.includes("CONFORMITE")) {
    return "COMPLIANCE_REVIEW_REQUIRED";
  }

  return "";
}

function statutRisque(code) {
  if (
    code === "SANCTIONS_SCREENING_BLOCKED" ||
    code === "PEP_SANCTIONED" ||
    texte(code).startsWith("BLACKLISTED")
  ) {
    return "blocked";
  }

  if (code === "COMPLIANCE_REVIEW_REQUIRED") return "review";
  return "alert";
}

/**
 * ⚠️ `details` PEUT PORTER DE LA DONNÉE PERSONNELLE.
 *
 * `logTransaction` y range `maskSensitive(body)` : le masquage a déjà eu lieu à
 * l'écriture, mais le corps d'une transaction reste une donnée personnelle
 * (nom du bénéficiaire, téléphone). Le back-office en a besoin pour instruire
 * un dossier — c'est sa raison d'être — et la route est réservée aux rôles
 * admin. Ce qui ne sort PAS : `ip`, qui n'apporte rien à l'instruction et
 * constitue une donnée de localisation.
 */
function projeter(entree, code) {
  return {
    _id: entree._id,
    userId: entree.userId || null,
    type: entree.type,
    provider: entree.provider,
    amount: entree.amount,
    currency: entree.currency || null,
    toEmail: entree.toEmail || "",
    details: entree.details || null,
    flagReason: entree.flagReason || "",
    reviewed: Boolean(entree.reviewed),
    reviewedBy: entree.reviewedBy || null,
    reviewComment: entree.reviewComment || null,
    transactionId: entree.transactionId || null,
    createdAt: entree.createdAt,
    loggedAt: entree.loggedAt,
    complianceCode: code,
    complianceRiskStatus: statutRisque(code),
  };
}

/**
 * Fenêtre par défaut : 90 jours.
 *
 * ⚠️ Ce n'est pas une troncature déguisée — c'est un défaut ANNONCÉ dans la
 * réponse (`window`), et l'appelant peut demander n'importe quelle fenêtre avec
 * `from`/`to`. La différence avec le repli du bord est là : celui-ci coupait à
 * 500 lignes sans le dire.
 */
const FENETRE_DEFAUT_JOURS = 90;

function fenetre(query) {
  const depuis = texte(query.from);
  const jusqu = texte(query.to);

  const fin = jusqu ? new Date(jusqu) : new Date();
  const debut = depuis
    ? new Date(depuis)
    : new Date(fin.getTime() - FENETRE_DEFAUT_JOURS * 24 * 3600 * 1000);

  if (Number.isNaN(debut.getTime()) || Number.isNaN(fin.getTime())) return null;
  if (debut > fin) return null;

  return { debut, fin, parDefaut: !depuis && !jusqu };
}

exports.listComplianceCases = async function listComplianceCases(req, res) {
  const page = entier(req.query.page, 1, 1, 100000);
  const limit = entier(req.query.limit, 50, 1, 200);

  const codeDemande = texte(req.query.code).toUpperCase();
  const statutDemande = texte(req.query.status).toLowerCase();
  const recherche = texte(req.query.q || req.query.search).toLowerCase();

  const bornes = fenetre(req.query);

  if (!bornes) {
    return res.status(400).json({
      success: false,
      code: "INVALID_DATE_RANGE",
      error: "Plage de dates invalide.",
    });
  }

  /**
   * ⚠️ ÉCHEC EN FERMETURE, ET SANS AMBIGUÏTÉ.
   *
   * Une surface de conformité qui rend une liste VIDE parce que la base est
   * indisponible ment au responsable conformité : « aucun dossier » et « je ne
   * peux pas savoir » ne sont pas la même phrase, et la première est celle qui
   * fait classer un dossier qu'on n'a pas vu.
   */
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      success: false,
      code: "COMPLIANCE_STORE_UNAVAILABLE",
      error:
        "Journal de conformité indisponible. Aucune conclusion ne peut être " +
        "tirée de cette réponse.",
    });
  }

  try {
    const entrees = await AMLLog.find({
      flagged: true,
      createdAt: { $gte: bornes.debut, $lte: bornes.fin },
    })
      .sort({ createdAt: -1 })
      .lean();

    const dossiers = [];

    for (const entree of entrees) {
      const code = codeConformite(entree);
      if (!code) continue;

      if (codeDemande && codeDemande !== "ALL" && code !== codeDemande) continue;

      if (statutDemande && statutDemande !== "all") {
        if (statutRisque(code) !== statutDemande) continue;
      }

      const projete = projeter(entree, code);

      if (recherche) {
        const champs = [
          projete.toEmail,
          projete.provider,
          projete.flagReason,
          String(projete.userId || ""),
          String(projete.transactionId || ""),
        ]
          .join(" ")
          .toLowerCase();

        if (!champs.includes(recherche)) continue;
      }

      dossiers.push(projete);
    }

    const stats = {
      total: dossiers.length,
      review: 0,
      blocked: 0,
      sanctions: 0,
      blacklist: 0,
      riskyCountry: 0,
      aml: 0,
    };

    for (const dossier of dossiers) {
      const code = dossier.complianceCode;

      if (code === "COMPLIANCE_REVIEW_REQUIRED") stats.review += 1;

      if (code === "SANCTIONS_SCREENING_BLOCKED" || code === "PEP_SANCTIONED") {
        stats.sanctions += 1;
        stats.blocked += 1;
      }

      if (code.startsWith("BLACKLISTED")) {
        stats.blacklist += 1;
        stats.blocked += 1;
      }

      if (code === "RISKY_COUNTRY") {
        stats.riskyCountry += 1;
        stats.blocked += 1;
      }

      if (code.startsWith("AML_")) stats.aml += 1;
    }

    const debut = (page - 1) * limit;
    const paged = dossiers.slice(debut, debut + limit);

    return res.status(200).json({
      success: true,
      source: "tx-core-amllog",
      data: paged,
      items: paged,
      total: dossiers.length,
      page,
      limit,
      stats,
      codes: COMPLIANCE_ALERT_CODES,

      /**
       * Règle B.6 appliquée à une réponse d'API : elle dit sur quoi elle porte.
       * Un responsable conformité doit pouvoir affirmer « rien entre ces deux
       * dates », pas « rien ».
       */
      window: {
        from: bornes.debut.toISOString(),
        to: bornes.fin.toISOString(),
        isDefault: bornes.parDefaut,
        defaultDays: FENETRE_DEFAUT_JOURS,
      },
    });
  } catch (err) {
    logger.error("[compliance] lecture du journal AML impossible", {
      message: err?.message || String(err),
    });

    return res.status(503).json({
      success: false,
      code: "COMPLIANCE_STORE_UNAVAILABLE",
      error:
        "Journal de conformité illisible. Aucune conclusion ne peut être " +
        "tirée de cette réponse.",
    });
  }
};

exports.COMPLIANCE_ALERT_CODES = COMPLIANCE_ALERT_CODES;
exports.codeConformite = codeConformite;
exports.statutRisque = statutRisque;
