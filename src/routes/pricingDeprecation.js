"use strict";

/**
 * ============================================================================
 * LES SURFACES TARIFAIRES RETIRÉES RÉPONDENT 410, ET ELLES EXPLIQUENT
 * ============================================================================
 *
 * ── Le défaut fermé le 2026-09-16 ───────────────────────────────────────────
 *
 * Trois surfaces d'administration écrivaient des « prix » HORS du circuit
 * gouverné, et deux d'entre elles n'avaient AUCUN effet sur les prix
 * réellement appliqués :
 *
 *   · `Fee`          — ne servait plus qu'aux frais d'annulation simulés ;
 *   · `FxRule`       — plus aucun consommateur : écrire dedans ne changeait RIEN ;
 *   · `ExchangeRate` — le « taux personnalisé » n'entrait dans AUCUN devis, qui
 *                      interroge le marché en mode `live`.
 *
 * Le danger n'était pas l'inutilité, c'était le SUCCÈS APPARENT : un
 * administrateur fixait un taux, recevait une confirmation, et le devis
 * continuait d'appliquer le taux du marché. C'est exactement le défaut fermé le
 * 2026-08-26 sur `/api/v1/admin/fees` du backend principal — réapparu ailleurs.
 *
 * ── Pourquoi 410 et pas 404 ─────────────────────────────────────────────────
 *
 * Un 404 est indiscernable d'une faute de frappe : celui qui cherche la route
 * conclut à une erreur d'URL et va chercher ailleurs. `410 Gone` dit « cela a
 * existé, c'est parti, voici le successeur ». C'est ce que font Stripe, PayPal
 * et Wise de leurs points d'entrée retirés.
 *
 * Les en-têtes suivent la RFC 8594 (`Deprecation`, `Sunset`, `Link`), pour que
 * l'information soit lisible par un outil et pas seulement par un humain.
 */

const SUCCESSEUR = "/api/v1/pricing-change-requests";

/** Date de retrait effectif, au format HTTP exigé par la RFC 8594. */
const SUNSET = new Date("2026-09-16T00:00:00Z").toUTCString();

/**
 * @param {{code: string, quoi: string}} params
 * @returns {import("express").RequestHandler}
 */
function routeRetiree({ code, quoi }) {
  return function repondreGone(req, res) {
    console.warn(
      `[PRICING][410] ${req.method} ${req.originalUrl} — écriture tarifaire ` +
        "retirée ; la source de vérité est PricingRule, par le circuit gouverné.",
      { par: req.user?.email || null }
    );

    res.set("Deprecation", "true");
    res.set("Sunset", SUNSET);
    res.set("Link", `<${SUCCESSEUR}>; rel="successor-version"`);

    return res.status(410).json({
      success: false,
      ok: false,
      code,
      error: "Route retirée.",
      message:
        `${quoi} La tarification a une seule source de vérité : les barèmes ` +
        "`PricingRule`, modifiables uniquement par une demande de changement " +
        "validée par un second administrateur, qui écrit une version immuable. " +
        `Voir ${SUCCESSEUR}. Cette route écrivait une donnée que le calcul du ` +
        "prix ne lit pas : la modifier n'avait aucun effet sur les montants prélevés.",
      successor: SUCCESSEUR,
    });
  };
}

module.exports = { routeRetiree, SUCCESSEUR, SUNSET };
