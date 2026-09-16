"use strict";

/**
 * ============================================================================
 * QUELS CORRIDORS N'ONT AUCUN BARÈME ? — LECTURE SEULE
 * ============================================================================
 *
 * ── Pourquoi ce script existe ───────────────────────────────────────────────
 *
 * Un corridor sans barème ne se dégrade pas : il REFUSE (404 « aucun barème ne
 * couvre ce corridor »), et c'est voulu — servir un prix que personne n'a décidé
 * serait pire. Mais la conséquence est qu'un rail entier peut être inutilisable
 * sans que rien ne l'annonce.
 *
 * On ne peut pas vérifier cela en lisant le code : cela dépend de ce que la base
 * contient AUJOURD'HUI. D'où cet outil, qui interroge le vrai moteur de
 * sélection (`pickBestRule`) avec la vraie table de règles.
 *
 * ── ⚠️ LE DÉFAUT DE LA PREMIÈRE VERSION, CORRIGÉ LE 2026-09-16 ──────────────
 *
 * Elle balayait un produit cartésien devises × rails SANS faire varier les
 * PAYS. Or les règles réelles portent des corridors de pays explicites
 * (`FRANCE → COTE D'IVOIRE`). Toutes les combinaisons tombaient donc à côté, et
 * l'outil annonçait « 864 corridors non couverts, 0 couvert » — y compris pour
 * des corridors parfaitement tarifés.
 *
 * Un outil de diagnostic qui produit une alarme PAR CONSTRUCTION est pire
 * qu'inutile : il fait perdre confiance dans les vraies alarmes. La matrice
 * dérive désormais ses pays DES RÈGLES EN BASE, et le rapport sépare deux
 * constats de nature différente :
 *
 *   · « ce rail n'a AUCUNE règle, quel que soit le pays » — un fait dur, qui
 *     signifie que le rail refuse toute transaction ;
 *   · « ce corridor précis n'est pas couvert » — une décision commerciale à
 *     prendre, ou pas.
 *
 * ⚠️ LECTURE SEULE, strictement. Il n'écrit rien et ne corrige rien : combler un
 * trou est une DÉCISION de prix, qui passe par le circuit gouverné
 * (`/api/v1/pricing-change-requests`).
 *
 * Usage :
 *   node scripts/pricingCoverage.js
 *   node scripts/pricingCoverage.js --countries=CI,FR,CA --currencies=XOF,EUR
 *   node scripts/pricingCoverage.js --amount=25000 --json
 */

const mongoose = require("mongoose");

const config = require("../src/config");
const { connectTransactionsDB, getPricingModel } = require("../src/config/db");
const {
  pickBestRule,
  normalizeCountryISO2,
} = require("../src/services/pricing/pricingEngine");

const EN_JSON = process.argv.includes("--json");

function arg(nom, defaut = null) {
  const trouve = process.argv.find((a) => a.startsWith(`--${nom}=`));
  return trouve ? trouve.slice(nom.length + 3).trim() : defaut;
}

function liste(nom) {
  const brut = arg(nom);
  if (!brut) return null;

  return brut
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
}

const MONTANT = Number(arg("amount", "10000"));

/**
 * Les rails réellement servis. `bank` et `stripe` n'y figurent pas : les deux
 * ont été retirés (`test/noBankRail.test.js`), et lister un rail mort produirait
 * des « trous » qu'il ne faut surtout pas combler.
 */
const RAILS = [
  { method: "INTERNAL", providers: ["paynoval"] },
  { method: "MOBILEMONEY", providers: ["wave", "orange", "mtn", "moov"] },
  { method: "CARD", providers: ["visa_direct"] },
];

const TYPES = ["TRANSFER", "DEPOSIT", "WITHDRAW", "CANCELLATION"];

const CARACTERISTIQUE = "ALL";

function estJoker(v) {
  const s = String(v || "").trim().toUpperCase();
  return !s || s === CARACTERISTIQUE || s === "*";
}

/**
 * Devises et pays observés DANS LES RÈGLES. C'est la correction de fond : une
 * matrice inventée de toutes pièces ne rencontre jamais un corridor explicite.
 */
function dimensionsObservees(regles) {
  const devises = new Set();
  const pays = new Set();
  const corridors = new Set();

  for (const r of regles) {
    const s = r.scope || {};

    if (!estJoker(s.fromCurrency)) devises.add(String(s.fromCurrency).toUpperCase());
    if (!estJoker(s.toCurrency)) devises.add(String(s.toCurrency).toUpperCase());

    const de = estJoker(s.fromCountry) ? null : normalizeCountryISO2(s.fromCountry);
    const vers = estJoker(s.toCountry) ? null : normalizeCountryISO2(s.toCountry);

    if (de) pays.add(de);
    if (vers) pays.add(vers);
    if (de && vers) corridors.add(`${de}>${vers}`);
  }

  return { devises: [...devises].sort(), pays: [...pays].sort(), corridors: [...corridors].sort() };
}

function etiquette(c) {
  const pays = c.fromCountry ? `${c.fromCountry}→${c.toCountry}` : "pays non précisé";
  return `${c.txType} · ${c.method}/${c.provider} · ${pays} · ${c.fromCurrency}→${c.toCurrency}`;
}

async function main() {
  config.load({ strict: false });
  await connectTransactionsDB();

  const PricingRule = getPricingModel("PricingRule");
  const regles = await PricingRule.find({ active: true, archivedAt: null }).lean();

  const observe = dimensionsObservees(regles);

  const DEVISES = liste("currencies") || (observe.devises.length ? observe.devises : ["XOF", "EUR", "CAD"]);
  const PAYS = liste("countries") || (observe.pays.length ? observe.pays : ["CI", "FR", "CA"]);

  /* ── 1. Le constat DUR : un rail sans aucune règle, quel que soit le reste ── */
  const railsSansAucuneRegle = [];

  for (const txType of TYPES) {
    for (const rail of RAILS) {
      const existe = regles.some((r) => {
        const s = r.scope || {};
        const typeOk = estJoker(s.txType) || String(s.txType).toUpperCase() === txType;
        const railOk = estJoker(s.method) || String(s.method).toUpperCase() === rail.method;
        return typeOk && railOk;
      });

      if (!existe) railsSansAucuneRegle.push(`${txType} · ${rail.method}`);
    }
  }

  /* ── 2. Le détail, sur une matrice ANCRÉE dans les règles réelles ────────── */
  const couverts = [];
  const decouverts = [];

  for (const txType of TYPES) {
    for (const rail of RAILS) {
      for (const provider of rail.providers) {
        for (const fromCountry of PAYS) {
          for (const toCountry of PAYS) {
            for (const fromCurrency of DEVISES) {
              for (const toCurrency of DEVISES) {
                const c = {
                  txType,
                  method: rail.method,
                  provider,
                  fromCountry,
                  toCountry,
                  country: toCountry,
                  fromCurrency,
                  toCurrency,
                  amount: MONTANT,
                };

                const regle = pickBestRule(regles, c);

                if (regle) couverts.push({ ...c, ruleCode: regle.code || String(regle._id) });
                else decouverts.push(c);
              }
            }
          }
        }
      }
    }
  }

  if (EN_JSON) {
    console.log(
      JSON.stringify(
        {
          mesureLe: new Date().toISOString(),
          montantTeste: MONTANT,
          reglesActives: regles.length,
          dimensionsObservees: observe,
          railsSansAucuneRegle,
          couverts: couverts.length,
          decouverts: decouverts.length,
          exemplesCouverts: couverts.slice(0, 20).map(etiquette),
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`\n  Couverture tarifaire — mesurée le ${new Date().toISOString()}`);
  console.log(`  Montant testé : ${MONTANT} · règles actives en base : ${regles.length}`);
  console.log("  " + "─".repeat(74));

  console.log(`\n  Dimensions OBSERVÉES dans les règles :`);
  console.log(`    devises   : ${observe.devises.join(", ") || "(aucune — que des jokers)"}`);
  console.log(`    pays      : ${observe.pays.join(", ") || "(aucun — que des jokers)"}`);
  console.log(`    corridors : ${observe.corridors.join(", ") || "(aucun explicite)"}`);

  /**
   * Le constat qui compte, mis EN PREMIER : un rail sans la moindre règle ne
   * sert à rien d'autre que refuser. C'est un fait, pas un arbitrage.
   */
  if (railsSansAucuneRegle.length) {
    console.log(`\n  ⛔ RAILS SANS AUCUNE RÈGLE — ils refusent TOUTE transaction (404) :`);
    for (const r of railsSansAucuneRegle) console.log(`    · ${r}`);
  } else {
    console.log(`\n  ✅ Chaque type/rail possède au moins une règle.`);
  }

  console.log(`\n  Matrice ancrée sur les dimensions observées :`);
  console.log(`    combinaisons testées : ${couverts.length + decouverts.length}`);
  console.log(`    couvertes            : ${couverts.length}`);
  console.log(`    non couvertes        : ${decouverts.length}`);

  if (couverts.length) {
    const parRegle = new Map();
    for (const c of couverts) parRegle.set(c.ruleCode, (parRegle.get(c.ruleCode) || 0) + 1);

    console.log(`\n  Ce qui EST tarifé, par règle :`);
    for (const [code, n] of [...parRegle.entries()].sort()) {
      console.log(`    · ${code} — ${n} combinaison(s)`);
    }
  }

  console.log(
    "\n  ⚠️ Un corridor non couvert REFUSE la transaction (404). Combler un trou " +
      "est une décision\n     de prix : elle passe par /api/v1/pricing-change-requests " +
      "(demande, puis approbation\n     par un second membre du staff).\n"
  );
}

main()
  .catch((err) => {
    console.error(`\n  ❌ ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
