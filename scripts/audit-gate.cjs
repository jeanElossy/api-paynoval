#!/usr/bin/env node
"use strict";

/**
 * ============================================================================
 * CONTRÔLE DES FAILLES DES DÉPENDANCES — UNE SEULE RÈGLE, CINQ DÉPÔTS (2026-11-11)
 * ============================================================================
 *
 * Fichier IDENTIQUE à l'octet près dans les cinq dépôts PayNoval (Tx-Core,
 * backend, passerelle, web, mobile) — épinglé par leurs tests. On le modifie
 * dans les cinq à la fois.
 *
 * Avant : un seuil différent par dépôt (« critical » sur le backend et le web,
 * « high » sur Tx-Core, « low » sur la passerelle, rien sur le mobile). Une
 * faille critique de Mongoose est restée en production sur deux services
 * pendant que l'intégration continue était rouge sans que personne ne le voie.
 *
 * LA RÈGLE (délais de correction des grandes fintechs : critique 24-72 h,
 * haute 7 jours, moyenne 30 jours) :
 *   · critique ou haute, n'importe où            ⇒ BLOQUE ;
 *   · moyenne dans le code livré (`--omit=dev`)  ⇒ BLOQUE ;
 *   · moyenne d'outillage, faible                ⇒ signalée, ne bloque pas.
 *
 * LE REGISTRE D'EXCEPTIONS (`audit-exceptions.json`, à côté de `package.json`) :
 * une faille qu'on ne peut pas corriger tout de suite (correctif = migration
 * majeure) est NOMMÉE (identifiant GHSA), JUSTIFIÉE, porte sa MESURE
 * COMPENSATOIRE et une DATE D'EXPIRATION (180 jours au plus). Expirée, elle
 * bloque de nouveau. Une exception qui ne sert plus est signalée (à retirer).
 *
 * FERMÉ PAR DÉFAUT : si `npm audit` ne répond pas (registre injoignable,
 * réponse illisible), le contrôle ÉCHOUE — un contrôle qui ne voit rien ne doit
 * jamais dire « tout va bien ».
 *
 * Usage : node scripts/audit-gate.cjs
 * Le cœur (`evaluateAudit`) est pur et testé.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const MAX_EXCEPTION_DAYS = 180;
const BLOCKING_EVERYWHERE = new Set(["critical", "high"]);
const BLOCKING_IN_PRODUCTION = new Set(["critical", "high", "moderate"]);
const GHSA = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i;

/** Avis de sécurité d'un rapport `npm audit --json` : `[{ id, pkg, severity, title }]`. */
function advisoriesOf(report) {
  const out = new Map();
  for (const [pkg, entry] of Object.entries(report?.vulnerabilities || {})) {
    for (const via of entry?.via || []) {
      if (!via || typeof via !== "object") continue;
      const id = (String(via.url || "").match(GHSA) || [String(via.source || "")])[0].toUpperCase();
      if (!id) continue;
      const key = `${id}|${pkg}`;
      if (!out.has(key)) {
        out.set(key, { id, pkg, severity: String(via.severity || entry.severity || "").toLowerCase(), title: String(via.title || "") });
      }
    }
  }
  return [...out.values()];
}

const dayOf = (value) => {
  const d = new Date(`${String(value || "").slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Exceptions lisibles, et les erreurs de forme (une exception mal écrite BLOQUE). */
function validateExceptions(exceptions, today) {
  const valid = [];
  const errors = [];
  const now = dayOf(today);
  for (const [i, e] of (Array.isArray(exceptions) ? exceptions : []).entries()) {
    const where = `exception n° ${i + 1}`;
    const id = String(e?.id || "").toUpperCase();
    const expires = dayOf(e?.expires);
    if (!GHSA.test(id)) errors.push(`${where} : identifiant GHSA manquant ou illisible`);
    else if (!String(e?.reason || "").trim()) errors.push(`${where} (${id}) : justification manquante`);
    else if (!String(e?.mitigation || "").trim()) errors.push(`${where} (${id}) : mesure compensatoire manquante`);
    else if (!expires) errors.push(`${where} (${id}) : date d'expiration manquante ou illisible`);
    else if (now && (expires - now) / 86400000 > MAX_EXCEPTION_DAYS) {
      errors.push(`${where} (${id}) : expiration au-delà de ${MAX_EXCEPTION_DAYS} jours`);
    } else valid.push({ ...e, id, expiresAt: expires });
  }
  return { valid, errors };
}

/**
 * Verdict, PUR. `all` / `prod` : rapports `npm audit --json` (tout ; code livré).
 * @returns {{ blocking: object[], reported: object[], excepted: object[], expired: object[], unused: string[], errors: string[] }}
 */
function evaluateAudit({ all, prod, exceptions = [], today = new Date().toISOString() }) {
  const { valid, errors } = validateExceptions(exceptions, today);
  const now = dayOf(today);
  const prodIds = new Set(advisoriesOf(prod).map((a) => `${a.id}|${a.pkg}`));
  const used = new Set();
  const blocking = [];
  const reported = [];
  const excepted = [];
  const expired = [];

  for (const a of advisoriesOf(all)) {
    const inProduction = prodIds.has(`${a.id}|${a.pkg}`);
    const blocks = BLOCKING_EVERYWHERE.has(a.severity) || (inProduction && BLOCKING_IN_PRODUCTION.has(a.severity));
    const item = { ...a, scope: inProduction ? "livré" : "outillage" };
    if (!blocks) {
      reported.push(item);
      continue;
    }
    const exception = valid.find((e) => e.id === a.id);
    if (!exception) {
      blocking.push(item);
      continue;
    }
    used.add(exception.id);
    if (now && exception.expiresAt < now) {
      expired.push({ ...item, expires: exception.expires });
      blocking.push({ ...item, expiredException: exception.expires });
    } else {
      excepted.push({ ...item, expires: exception.expires });
    }
  }

  const unused = valid.filter((e) => !used.has(e.id)).map((e) => e.id);
  return { blocking, reported, excepted, expired, unused, errors };
}

/** `npm audit --json` ; `null` si la réponse est absente ou illisible (fermé par défaut). */
function runAudit(args, cwd) {
  const res = spawnSync("npm", ["audit", "--json", ...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  try {
    const json = JSON.parse(res.stdout || "");
    if (json?.error) return null;
    return json && typeof json === "object" && "vulnerabilities" in json ? json : null;
  } catch {
    return null;
  }
}

function main() {
  const cwd = process.cwd();
  const exceptionsFile = path.join(cwd, "audit-exceptions.json");
  let exceptions = [];
  if (fs.existsSync(exceptionsFile)) {
    try {
      exceptions = JSON.parse(fs.readFileSync(exceptionsFile, "utf8")).exceptions || [];
    } catch (error) {
      console.error(`❌ audit-exceptions.json illisible : ${error.message}`);
      process.exit(2);
    }
  }

  const all = runAudit([], cwd);
  const prod = runAudit(["--omit=dev"], cwd);
  if (!all || !prod) {
    console.error("❌ npm audit n'a pas répondu (registre injoignable ou réponse illisible) : contrôle en échec, par prudence.");
    process.exit(2);
  }

  const v = evaluateAudit({ all, prod, exceptions });
  const line = (a) => `  ${a.severity.padEnd(8)} ${a.scope.padEnd(9)} ${a.pkg} — ${a.id} — ${a.title}`;

  if (v.errors.length) v.errors.forEach((e) => console.error(`❌ ${e}`));
  if (v.excepted.length) {
    console.log(`Exceptions en vigueur (${v.excepted.length}) :`);
    v.excepted.forEach((a) => console.log(`${line(a)} (jusqu'au ${a.expires})`));
  }
  if (v.unused.length) console.log(`⚠️ Exceptions qui ne servent plus, à retirer : ${v.unused.join(", ")}`);
  if (v.reported.length) {
    console.log(`Signalées, non bloquantes (${v.reported.length}) :`);
    v.reported.forEach((a) => console.log(line(a)));
  }
  if (v.blocking.length) {
    console.error(`❌ Failles bloquantes (${v.blocking.length}) :`);
    v.blocking.forEach((a) => console.error(`${line(a)}${a.expiredException ? ` — exception EXPIRÉE le ${a.expiredException}` : ""}`));
  }

  if (v.blocking.length || v.errors.length) process.exit(1);
  console.log("✅ Aucune faille bloquante.");
}

module.exports = { evaluateAudit, advisoriesOf, validateExceptions, MAX_EXCEPTION_DAYS };

if (require.main === module) main();
