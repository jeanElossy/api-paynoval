"use strict";

/**
 * ============================================================================
 * CONSOMMATION D'UN DEVIS — LE PRIX AFFICHÉ DEVIENT LE PRIX PRÉLEVÉ
 * ============================================================================
 *
 * ── Le défaut que ce module ferme ───────────────────────────────────────────
 *
 * `lockQuote` créait bien un `PricingQuote` et rendait un `quoteId`. Mais
 * AUCUN chemin d'initiation ne le lisait : `quoteId` n'était recopié qu'en
 * métadonnée, et le prix était intégralement RECALCULÉ au moment d'écrire.
 *
 * Le verrou ne verrouillait donc rien. Entre l'écran de confirmation et
 * l'écriture comptable, le taux pouvait changer — cache de change expiré, autre
 * instance avec un cache différent, barème publié entre-temps — et l'utilisateur
 * recevait autre chose que ce qu'il avait accepté, sans que rien ne le détecte
 * ni ne le journalise.
 *
 * C'est le modèle de Stripe, de PayPal et de Wise qui est appliqué ici : le
 * prix est un OBJET, pas un calcul. On l'émet, il expire, on le consomme une
 * fois, et c'est lui qu'on écrit.
 *
 * ── Pourquoi les paramètres entrent dans le FILTRE ──────────────────────────
 *
 * La tentation naturelle est de consommer le devis, puis de comparer ses
 * paramètres à la demande. C'est une faute : une divergence BRÛLERAIT alors un
 * devis parfaitement valide, et l'utilisateur perdrait son prix à cause d'une
 * erreur d'appel.
 *
 * Les champs comparés font donc partie du filtre de la mise à jour
 * conditionnelle. Un devis qui ne correspond pas n'est pas consommé — il n'est
 * même pas touché. Le diagnostic vient ensuite, par une simple lecture, et n'a
 * qu'un rôle d'explication.
 *
 * ── Pourquoi ce module est PUR ──────────────────────────────────────────────
 *
 * Aucun accès base, aucun accès réseau, aucun modèle résolu au chargement —
 * `test/pricingDomainLoads.test.js` l'exige de tout le domaine des prix, parce
 * que Tx-Core ouvre des connexions NOMMÉES qui n'existent pas au `require`.
 * La décision « ce devis est-il recevable ? » se teste donc sans base.
 */

/**
 * Les champs qui DÉFINISSENT un prix. Deux devis qui diffèrent sur l'un d'eux
 * ne sont pas le même engagement.
 *
 * ⚠️ `amount` en fait partie, et c'est le plus important : sans lui, un devis
 * obtenu pour 10 000 XOF servirait à envoyer 1 000 000 XOF au tarif du premier.
 */
const CHAMPS_ENGAGEANTS = Object.freeze([
  "txType",
  "method",
  "amount",
  "fromCurrency",
  "toCurrency",
  "country",
  "fromCountry",
  "toCountry",
  "provider",
  "operator",
]);

/** Erreur nommée, à la forme déjà retenue par le règlement des cagnottes. */
function quoteError(status, code, message, details) {
  const err = new Error(message);
  err.status = status;
  err.statusCode = status;
  err.code = code;
  if (details) err.details = details;
  return err;
}

/**
 * Normalise une valeur comparable.
 *
 * `null`, `undefined` et `""` désignent tous « non précisé » — les trois
 * doivent se comparer égaux, sinon un devis émis sans opérateur ne serait
 * jamais consommable par une demande qui en envoie une chaîne vide.
 */
function valeurComparable(v) {
  if (v === null || v === undefined) return null;

  if (typeof v === "number") {
    return Number.isFinite(v) ? v : null;
  }

  const s = String(v).trim();
  return s === "" ? null : s;
}

/**
 * Les montants viennent d'un côté de Mongo (double) et de l'autre d'un calcul
 * en mémoire. On compare donc à l'unité minimale de devise près, jamais par
 * égalité stricte de flottants — même raisonnement que la tolérance de
 * `pricingValidation.js`.
 */
function memeMontant(a, b) {
  const na = Number(a);
  const nb = Number(b);

  if (!Number.isFinite(na) || !Number.isFinite(nb)) return false;

  return Math.abs(na - nb) < 1e-9;
}

/**
 * Compare la demande d'initiation au devis figé.
 *
 * @param {object} requeteDevis   `quote.request` tel qu'il a été figé.
 * @param {object} requeteDemande Sortie de `buildRequest` pour la demande courante.
 * @returns {{ok: boolean, differences: Array<{champ: string, devis: *, demande: *}>}}
 */
function comparerRequete(requeteDevis = {}, requeteDemande = {}) {
  const differences = [];

  for (const champ of CHAMPS_ENGAGEANTS) {
    const attendu = valeurComparable(requeteDevis?.[champ]);
    const recu = valeurComparable(requeteDemande?.[champ]);

    const identique =
      champ === "amount"
        ? memeMontant(attendu, recu)
        : String(attendu).toUpperCase() === String(recu).toUpperCase();

    if (!identique) {
      differences.push({ champ, devis: attendu, demande: recu });
    }
  }

  return { ok: differences.length === 0, differences };
}

/**
 * Construit le filtre de la consommation atomique.
 *
 * Tout ce qui engage PayNoval y figure : l'identifiant du devis, SON
 * PROPRIÉTAIRE, son état, sa fraîcheur, et chacun des champs de prix. Mongo
 * garantit l'atomicité sur un document unique — aucune transaction
 * multi-documents n'est nécessaire, ce qui compte parce que la base de
 * tarification ne partage pas forcément le client Mongo du grand livre
 * (`config/db.js`).
 */
function construireFiltreConsommation({ quoteId, userId, requete, maintenant }) {
  const filtre = {
    quoteId,
    userId,
    status: "ACTIVE",
    expiresAt: { $gt: maintenant },
  };

  for (const champ of CHAMPS_ENGAGEANTS) {
    const valeur = valeurComparable(requete?.[champ]);

    /**
     * Un champ non précisé dans la demande doit rencontrer un champ non
     * précisé dans le devis. `null` et champ absent sont tous deux acceptés :
     * `lockQuote` écrit `null`, mais un devis ancien peut ne pas porter la clé.
     */
    filtre[`request.${champ}`] =
      valeur === null ? { $in: [null, ""] } : valeur;
  }

  return filtre;
}

/**
 * Pourquoi la consommation conditionnelle n'a rien trouvé.
 *
 * Le devis n'a PAS été modifié à ce stade : cette fonction ne fait qu'expliquer.
 * L'ordre des contrôles va du plus précis au plus général, pour que le message
 * désigne la vraie cause et non la première rencontrée.
 *
 * @param {object|null} devis   Document relu, ou `null`.
 * @param {object} params
 * @returns {Error} portant `.status` et `.code`
 */
function diagnostiquerEchec(devis, { userId, requete, maintenant }) {
  if (!devis) {
    return quoteError(
      404,
      "QUOTE_NOT_FOUND",
      "Devis introuvable ou expiré. Redemandez un devis : le taux a pu changer."
    );
  }

  if (String(devis.userId || "") !== String(userId || "")) {
    /**
     * ⚠️ On ne dit PAS à qui appartient le devis. Un message qui le révélerait
     * transformerait cette réponse en moyen de sonder les devis d'autrui
     * (règle B.4).
     */
    return quoteError(
      403,
      "QUOTE_NOT_OWNED",
      "Ce devis a été émis pour un autre compte."
    );
  }

  if (devis.status === "USED") {
    return quoteError(
      409,
      "QUOTE_ALREADY_USED",
      "Ce devis a déjà servi à une transaction. Redemandez un devis."
    );
  }

  const expiration = devis.expiresAt ? new Date(devis.expiresAt).getTime() : 0;

  if (devis.status === "EXPIRED" || expiration <= maintenant.getTime()) {
    return quoteError(
      409,
      "QUOTE_EXPIRED",
      "Le devis a expiré. Redemandez un devis : le taux a pu changer."
    );
  }

  const { ok, differences } = comparerRequete(devis.request, requete);

  if (!ok) {
    /**
     * Les écarts sont nommés : sans eux, celui qui intègre l'API voit « devis
     * non conforme » sans savoir si c'est le montant, la devise ou le corridor,
     * et corrige à l'aveugle.
     */
    return quoteError(
      409,
      "QUOTE_MISMATCH",
      "Ce devis ne correspond pas à la transaction demandée. Redemandez un devis.",
      { differences }
    );
  }

  /**
   * Aucun contrôle n'a expliqué l'échec : le devis a changé d'état entre la
   * tentative et la relecture (course avec un second appel). On répond comme
   * pour un devis déjà consommé, qui est le cas de très loin le plus probable.
   */
  return quoteError(
    409,
    "QUOTE_ALREADY_USED",
    "Ce devis vient d'être consommé par une autre requête. Redemandez un devis."
  );
}

/**
 * Le devis est-il EXIGÉ pour initier ?
 *
 * Exigence progressive, même motif que `IDEMPOTENCY_REQUIRED` : le drapeau
 * n'est pas déclaré dans `.env.example` — l'y mettre le rendrait obligatoire
 * dans le `.env` de développement et casserait le démarrage (`dotenv-safe`).
 * Le basculement se fait dans l'environnement de déploiement, sans redéployer.
 *
 * Tant qu'il vaut `false`, une initiation sans devis reste servie — mais elle
 * est JOURNALISÉE, parce qu'un défaut qu'on ne compte pas est un défaut qu'on
 * ne saura jamais refermer.
 */
function devisEstExige(env = process.env) {
  return String(env.PRICING_QUOTE_REQUIRED || "false").trim().toLowerCase() === "true";
}

module.exports = {
  CHAMPS_ENGAGEANTS,
  quoteError,
  comparerRequete,
  construireFiltreConsommation,
  diagnostiquerEchec,
  devisEstExige,
  valeurComparable,
};
