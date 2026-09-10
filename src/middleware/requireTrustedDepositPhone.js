"use strict";

/**
 * ============================================================================
 * BARRIÈRE : UN ENCAISSEMENT PART D'UN NUMÉRO PROUVÉ
 * ============================================================================
 *
 * Enveloppe HTTP autour de `services/risk/depositPhoneTrust`. La décision vit
 * dans le service — testable sans Express, réutilisable par un autre chemin
 * d'entrée ; ce middleware ne fait que traduire un refus en réponse.
 *
 * ── Pourquoi ce contrôle est passé du bord au moteur ───────────────────────
 *
 * Il vivait dans `api-gateway/src/services/transactions/phoneSecurity.js`, avec
 * la collection qu'il lit. Deux raisons de le descendre :
 *
 *   1. un contrôle qui AUTORISE un mouvement d'argent appartient au service qui
 *      déplace l'argent — sinon il suffit d'atteindre le moteur autrement pour
 *      s'en affranchir. C'est l'invariant 12 ;
 *   2. le bord interrogeait l'état de vérification par un APPEL HTTP vers une
 *      route qu'il ne montait pas. 404 à chaque fois, traduit en « non
 *      vérifié » par un `catch`. Le contrôle fonctionnait par accident.
 *
 * ── Position dans la chaîne ────────────────────────────────────────────────
 *
 * APRÈS `amlMiddleware`, juste avant le handler. L'AML est le contrôle le plus
 * large (sanctions, listes, plafonds) : inutile de vérifier le numéro d'un
 * compte qui ne devrait pas transiger du tout.
 */

const {
  enforceDepositPhoneTrust,
} = require("../services/risk/depositPhoneTrust");

module.exports = async function requireTrustedDepositPhone(req, res, next) {
  try {
    const { applique, phoneE164 } = await enforceDepositPhoneTrust({
      userId: req.user?._id || req.user?.id || null,
      user: req.user,
      body: req.body,
    });

    /**
     * ⚠️ ON RÉÉCRIT LE NUMÉRO EN E.164 DANS LE CORPS.
     *
     * Sans cette ligne, on VÉRIFIE `+2250700000000` et on ENCAISSE sur
     * `0700000000` : le contrôle porte sur une valeur, l'opération sur une
     * autre. Deux formes du même numéro sont aussi deux clés distinctes pour
     * l'index unique du registre — un numéro déjà vérifié devrait alors l'être
     * une seconde fois.
     */
    if (applique && phoneE164) {
      req.body.phoneNumber = phoneE164;
    }

    return next();
  } catch (err) {
    const statut = Number(err?.statut) || 500;

    /**
     * Un 500 non identifié ne se déguise pas en refus métier : on le laisse
     * remonter au gestionnaire d'erreurs, qui le journalise comme une panne.
     * Traduire toute exception en 403 ferait passer un bug pour une décision.
     */
    if (statut === 500) return next(err);

    return res.status(statut).json({
      success: false,
      error: err.message,
      code: err.code,
      ...(err.payload || {}),
    });
  }
};
