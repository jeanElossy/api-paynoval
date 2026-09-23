"use strict";

/**
 * ============================================================================
 * LE STEP-UP CLIENT — prévenir, demander, puis reprendre ou annuler
 * ============================================================================
 *
 * ── LE CHAÎNON QUI MANQUAIT ─────────────────────────────────────────────
 *
 * Le moteur de risque savait mettre un virement en `pending_review`, fonds
 * réservés, en attendant un opérateur. Mais personne ne prévenait le client et
 * on ne lui demandait rien : l'opérateur héritait d'un dossier vide et le
 * client d'un virement figé sans explication.
 *
 * C'est ce que Stripe appelle une *step-up authentication* et PayPal une
 * *information request* : le système ne refuse pas, **il demande**. La très
 * grande majorité des dossiers se referme d'elle-même, parce que la plupart
 * des clients retenus sont honnêtes et peuvent le prouver.
 *
 * ── ⚠️ ON NE DIT JAMAIS AU CLIENT QUELLE RÈGLE S'EST DÉCLENCHÉE ─────────
 *
 * C'est la règle la plus importante de ce fichier, et elle est
 * contre-intuitive : on aimerait être transparent. Mais « votre virement a été
 * retenu car vous dépassez 5 opérations par heure » est un MODE D'EMPLOI pour
 * le contourner. Aucun établissement sérieux ne le fait.
 *
 * Le client reçoit une CATÉGORIE générique et la liste des pièces attendues.
 * L'opérateur, lui, voit les codes exacts dans le dossier.
 *
 * ── ⚠️ CE MODULE NE DÉPLACE AUCUN ARGENT ────────────────────────────────
 *
 * Il ouvre un dossier et met une notification en file. Il ne touche ni au
 * solde, ni au grand livre, ni au statut de la transaction — c'est la machine
 * à états qui en décide, et elle seule.
 *
 * ── ⚠️ IL NE FAIT JAMAIS ÉCHOUER UN VIREMENT ────────────────────────────
 *
 * Il s'exécute APRÈS le commit, sur une transaction déjà acquise. Une erreur
 * ici doit être VISIBLE (règle B.1) mais jamais rendue au client : un 500 sur
 * un virement réussi le pousserait à rejouer.
 */

const {
  REQUIRED_DOCUMENTS,
  CLIENT_CATEGORIES,
} = require("../../models/TransactionReviewCase");

/** Délai laissé au client pour répondre, en heures. */
const DEFAULT_DEADLINE_HOURS = 72;

/**
 * Quelle pièce pour quel motif.
 *
 * ⚠️ ON DEMANDE LE MINIMUM QUI RÉPOND À LA QUESTION POSÉE. Réclamer trois
 * pièces à chaque dossier ferait abandonner des clients honnêtes — et un
 * client qui abandonne n'est pas un risque écarté, c'est un client perdu ET
 * un dossier qui reste ouvert.
 *
 * PURE.
 */
const DOCUMENTS_PAR_MOTIF = Object.freeze({
  /* — Qui êtes-vous ? — */
  KYC_INSUFFICIENT: ["identity"],
  NEW_ACCOUNT: ["identity"],
  SANCTIONED: ["identity"],

  /* — D'où vient cet argent ? — */
  AMOUNT_OVER_SINGLE_LIMIT: ["source_of_funds"],
  AMOUNT_FAR_ABOVE_CUSTOMER_HABIT: ["source_of_funds"],
  AMOUNT_ABOVE_CUSTOMER_MAX: ["source_of_funds"],
  VELOCITY_AMOUNT_DAILY: ["source_of_funds"],

  /* — À quoi sert cette opération ? — */
  AMOUNT_NEAR_SINGLE_LIMIT: ["purpose_of_payment"],
  VELOCITY_COUNT_BURST: ["purpose_of_payment"],
  VELOCITY_SAME_DESTINATION: ["purpose_of_payment"],
  NEW_BENEFICIARY: ["purpose_of_payment"],
  UNUSUAL_HOUR_FOR_CUSTOMER: ["purpose_of_payment"],
  AMOUNT_ABOVE_CUSTOMER_HABIT: ["purpose_of_payment"],
});

/**
 * ⚠️ CES CODES NE DEMANDENT RIEN AU CLIENT.
 *
 * `SIGNAL_UNAVAILABLE` dit que NOUS n'avons pas pu lire une donnée ; c'est
 * notre panne, pas son affaire. `SCORE_CLAMPED` et `SOFT_SCORE_CAPPED`
 * décrivent l'arithmétique du score. Réclamer une pièce d'identité parce que
 * notre cache était coupé serait absurde — et la première chose qu'un client
 * raconterait.
 */
const MOTIFS_SANS_DEMANDE = Object.freeze([
  "SIGNAL_UNAVAILABLE",
  "SCORE_CLAMPED",
  "SOFT_SCORE_CAPPED",
]);

function codesDe(reasons) {
  const lignes = Array.isArray(reasons) ? reasons : [];

  return lignes
    .map((r) => (typeof r === "string" ? r : r?.code))
    .filter((c) => typeof c === "string" && c.length > 0);
}

/**
 * Les pièces à réclamer, sans doublon et dans un ordre stable.
 *
 * PURE. L'ordre stable n'est pas cosmétique : il rend la notification et le
 * dossier reproductibles, donc comparables d'un dossier à l'autre.
 */
function requiredDocumentsFor(reasons) {
  const demandes = new Set();

  for (const code of codesDe(reasons)) {
    if (MOTIFS_SANS_DEMANDE.includes(code)) continue;

    for (const doc of DOCUMENTS_PAR_MOTIF[code] || []) demandes.add(doc);
  }

  // L'ordre de la liste fermée, pas l'ordre d'insertion.
  return REQUIRED_DOCUMENTS.filter((d) => demandes.has(d));
}

/**
 * La catégorie montrée au client. Volontairement grossière.
 *
 * PURE.
 */
function clientCategoryFor(documents) {
  const liste = Array.isArray(documents) ? documents : [];

  if (liste.includes("identity")) return "verification_identite";
  if (liste.length > 0) return "verification_operation";

  return "verification_complementaire";
}

/**
 * Le dossier à ouvrir, et la notification à mettre en file.
 *
 * PURE — rend des documents, n'écrit rien. C'est la pièce qu'on peut éprouver
 * sans base, et c'est là qu'une fuite de donnée se verrait.
 *
 * @param {object} input
 * @param {object} input.tx          la transaction créée
 * @param {object} input.verdict     sortie de `computeRiskScore`
 * @param {Date}   [input.now]
 * @param {number} [input.deadlineHours]
 *
 * @returns {{reviewCase: object, notification: object, outbox: object}}
 */
function buildStepUpRecords({
  tx,
  verdict,
  now = new Date(),
  deadlineHours = DEFAULT_DEADLINE_HOURS,
} = {}) {
  const transactionId = String(tx?._id || tx?.id || "");
  const userId = String(tx?.sender || tx?.userId || "");
  const reference = tx?.reference ? String(tx.reference) : null;

  const codes = codesDe(verdict?.reasons);
  const requiredDocuments = requiredDocumentsFor(verdict?.reasons);
  const clientCategory = clientCategoryFor(requiredDocuments);

  const deadlineAt = new Date(now.getTime() + deadlineHours * 60 * 60 * 1000);

  const reviewCase = {
    transactionId,
    reference,
    userId,
    status: "awaiting_customer",
    riskScore: Number.isFinite(verdict?.score) ? verdict.score : null,
    riskReasonCodes: codes,
    requiredDocuments,
    clientCategory,
    openedAt: now,
    deadlineAt,
    customerNotifiedAt: now,
  };

  /**
   * ⚠️ CE QUE LE CLIENT REÇOIT, ET RIEN DE PLUS.
   *
   * Ni score, ni codes de motif, ni seuil. La référence lui permet de
   * retrouver SON virement — c'est déjà sa donnée. Le montant n'y figure pas :
   * il est sur la transaction, que l'application affiche déjà, et le
   * dupliquer dans une charge qui part par e-mail et par push multiplierait
   * les endroits où il peut fuir (règle B.4).
   */
  const donneesClient = {
    transactionId,
    reference,
    category: clientCategory,
    requiredDocuments,
    deadlineAt: deadlineAt.toISOString(),
  };

  const notification = {
    recipient: userId,
    type: "transaction_review_documents_required",
    data: donneesClient,
    read: false,
    date: now,
  };

  const outbox = {
    service: "notifications",
    event: "transaction_review_documents_required",
    aggregateType: "transaction",
    aggregateId: transactionId,
    payload: { userId, data: donneesClient },
    /**
     * 2 = HIGH, comme les autres notifications de transaction. PAS `CRITICAL` :
     * ce niveau est réservé à la sécurité et à l'accès au compte, et le garder
     * rare est ce qui le garde utile.
     */
    priority: 2,
    /**
     * ⚠️ IDEMPOTENT PAR TRANSACTION. Un rejeu de requête ou deux instances
     * concurrentes ne doivent pas envoyer deux fois la même demande de pièces :
     * un client qui reçoit deux demandes pense à une tentative d'hameçonnage.
     */
    idempotencyKey: `review-docs:${transactionId}`,
  };

  return { reviewCase, notification, outbox };
}

/**
 * Ouvre le dossier et met la demande en file.
 *
 * ⚠️ NE LÈVE JAMAIS. Appelée APRÈS le commit, sur une transaction déjà
 * acquise : faire échouer la réponse ici rendrait un 500 pour un virement
 * réussi, ce qui pousserait le client à rejouer.
 *
 * ⚠️ L'ERREUR EST RENDUE VISIBLE (règle B.1). Un dossier non ouvert signifie
 * qu'un virement est retenu sans que personne ne sache pourquoi ni ce qu'on
 * attend — il faut que ce soit lisible dans le journal.
 *
 * @returns {Promise<{ok: boolean, created: boolean, error: string|null}>}
 */
async function openStepUpReview({
  tx,
  verdict,
  now = new Date(),
  deadlineHours = DEFAULT_DEADLINE_HOURS,
  ReviewCase,
  Notification,
  /**
   * ⚠️ LE NOM EST EXPLICITE, ET CE N'EST PAS DU ZÈLE. Deux collections
   * `outboxes` coexistent — celle de la base users, drainée par le backend
   * principal, et celle de la base transactions, réservée au parrainage.
   * `runtime.Outbox` LÈVE volontairement pour cette raison : écrire dans la
   * mauvaise ne produit aucune erreur, seulement une notification que
   * personne ne lira jamais.
   */
  NotificationOutbox,
  logger = null,
} = {}) {
  try {
    const { reviewCase, notification, outbox } = buildStepUpRecords({
      tx,
      verdict,
      now,
      deadlineHours,
    });

    if (!reviewCase.transactionId || !reviewCase.userId) {
      return { ok: false, created: false, error: "transaction ou titulaire inconnu" };
    }

    /**
     * ⚠️ `updateOne` EN UPSERT, ET PAS `create`.
     *
     * L'index unique sur `transactionId` rendrait `create` en erreur E11000 au
     * second passage. Or le second passage est NORMAL : rejeu de requête,
     * relance, deuxième instance. Traiter le cas nominal comme une erreur
     * remplirait le journal d'un bruit qui masquerait les vraies pannes.
     *
     * `$setOnInsert` : un dossier déjà ouvert n'est PAS réécrit. Son délai, sa
     * date d'ouverture et une éventuelle décision d'opérateur doivent survivre
     * à un rejeu — les remettre à zéro rendrait du temps à un fraudeur.
     */
    const resultat = await ReviewCase.updateOne(
      { transactionId: reviewCase.transactionId },
      { $setOnInsert: reviewCase },
      { upsert: true }
    );

    const cree =
      Boolean(resultat?.upsertedCount) || Boolean(resultat?.upsertedId);

    if (!cree) {
      // Dossier déjà ouvert : la notification est déjà partie, on ne la
      // renvoie pas. Deux demandes identiques ressemblent à un hameçonnage.
      return { ok: true, created: false, error: null };
    }

    await Notification.create([notification]);

    await NotificationOutbox.insertMany([outbox], { ordered: false });

    return { ok: true, created: true, error: null };
  } catch (err) {
    const message = err?.message || String(err);

    logger?.error?.("[stepUpReview] dossier de revue NON ouvert", {
      marqueur: "REVIEW_CASE_LOST",
      transactionId: String(tx?._id || ""),
      reference: tx?.reference || null,
      message,
      consequence:
        "virement retenu en pending_review sans demande au client ni dossier pour l'opérateur",
    });

    return { ok: false, created: false, error: message };
  }
}

/**
 * Le client a fourni ce qu'on lui demandait.
 *
 * ⚠️ CE MODULE NE JUGE PAS LA PIÈCE et n'en stocke AUCUNE. Il enregistre que
 * quelque chose est arrivé et bascule le dossier dans la file de l'opérateur.
 * Le contenu d'une pièce d'identité est une donnée KYC (règle B.4) : il vit
 * dans le circuit KYC, qui a ses propres gardes, sa propre conservation et son
 * propre journal d'accès. Le dupliquer ici créerait une seconde surface à
 * protéger, dans une collection qui n'a pas été pensée pour ça.
 *
 * ⚠️ SEUL UN DOSSIER `awaiting_customer` BASCULE. Un dossier déjà tranché ne
 * doit pas rouvrir parce qu'un client renvoie un document : ce serait un moyen
 * de remettre indéfiniment une décision en cause.
 *
 * @returns {Promise<{ok: boolean, changed: boolean, error: string|null}>}
 */
async function recordCustomerSubmission({
  transactionId,
  now = new Date(),
  ReviewCase,
  logger = null,
} = {}) {
  const txId = String(transactionId || "").trim();
  if (!txId) return { ok: false, changed: false, error: "transaction inconnue" };

  try {
    const resultat = await ReviewCase.updateOne(
      { transactionId: txId, status: "awaiting_customer" },
      { $set: { status: "awaiting_operator", submittedAt: now } }
    );

    return {
      ok: true,
      changed: Boolean(resultat?.modifiedCount),
      error: null,
    };
  } catch (err) {
    const message = err?.message || String(err);
    logger?.error?.("[stepUpReview] dépôt client NON enregistré", {
      transactionId: txId,
      message,
    });
    return { ok: false, changed: false, error: message };
  }
}

/** Les deux seules issues qu'un opérateur peut poser. */
const OPERATOR_DECISIONS = Object.freeze(["approved", "rejected"]);

/**
 * Un opérateur tranche.
 *
 * ⚠️ CETTE FONCTION NE TOUCHE PAS À LA TRANSACTION. Elle referme le DOSSIER.
 * Confirmer ou annuler le virement reste l'affaire de la machine à états et
 * des gardes du grand livre — un dossier d'instruction qui déplacerait
 * lui-même de l'argent serait une seconde voie d'écriture financière, hors de
 * tous les contrôles existants (invariants A.2 et A.4).
 *
 * ⚠️ L'AUTEUR EST OBLIGATOIRE. Une décision sans auteur n'est pas auditable,
 * et c'est la première chose qu'un contrôle réclame.
 *
 * @returns {Promise<{ok: boolean, changed: boolean, error: string|null}>}
 */
async function recordOperatorDecision({
  transactionId,
  decision,
  operatorId,
  note = null,
  now = new Date(),
  ReviewCase,
  logger = null,
} = {}) {
  const txId = String(transactionId || "").trim();
  const auteur = String(operatorId || "").trim();

  if (!txId) return { ok: false, changed: false, error: "transaction inconnue" };
  if (!auteur) return { ok: false, changed: false, error: "auteur de la décision inconnu" };

  if (!OPERATOR_DECISIONS.includes(decision)) {
    return { ok: false, changed: false, error: `décision inconnue : ${decision}` };
  }

  try {
    /**
     * ⚠️ ON NE TRANCHE QUE CE QUI EST ENCORE OUVERT. Sans ce filtre, une
     * seconde décision écraserait la première — et l'identité du véritable
     * décideur disparaîtrait du dossier.
     */
    const resultat = await ReviewCase.updateOne(
      { transactionId: txId, status: { $in: ["awaiting_customer", "awaiting_operator"] } },
      {
        $set: {
          status: decision,
          decidedAt: now,
          decidedBy: auteur,
          operatorNote: note ? String(note).slice(0, 2000) : null,
        },
      }
    );

    return { ok: true, changed: Boolean(resultat?.modifiedCount), error: null };
  } catch (err) {
    const message = err?.message || String(err);
    logger?.error?.("[stepUpReview] décision NON enregistrée", {
      transactionId: txId,
      decision,
      message,
    });
    return { ok: false, changed: false, error: message };
  }
}

/**
 * Referme les dossiers dont le délai est passé sans réponse.
 *
 * ⚠️ MARQUER `expired` NE LIBÈRE AUCUN FONDS. La libération reste l'affaire de
 * `transactionAutoCancelService`, qui sait annuler proprement en passant par
 * la machine à états. Ce balayage rend seulement la file d'attente honnête :
 * sans lui, des dossiers morts s'accumulent devant les opérateurs et la file
 * finit par ne plus être lue.
 *
 * ⚠️ BORNÉ PAR PASSAGE. Un balayage non borné sur une collection qui a grossi
 * pendant un incident bloquerait la base au pire moment.
 *
 * @returns {Promise<{ok: boolean, expired: number, error: string|null}>}
 */
async function expireOverdueCases({
  now = new Date(),
  limit = 200,
  ReviewCase,
  logger = null,
} = {}) {
  try {
    const echus = await ReviewCase.find(
      {
        status: { $in: ["awaiting_customer", "awaiting_operator"] },
        deadlineAt: { $ne: null, $lte: now },
      },
      "_id"
    )
      .limit(limit)
      .lean();

    const ids = (Array.isArray(echus) ? echus : []).map((d) => d._id);

    if (!ids.length) return { ok: true, expired: 0, error: null };

    const resultat = await ReviewCase.updateMany(
      { _id: { $in: ids } },
      { $set: { status: "expired" } }
    );

    return { ok: true, expired: resultat?.modifiedCount || 0, error: null };
  } catch (err) {
    const message = err?.message || String(err);
    logger?.warn?.("[stepUpReview] balayage des dossiers échus", { message });
    return { ok: false, expired: 0, error: message };
  }
}

module.exports = {
  DEFAULT_DEADLINE_HOURS,
  OPERATOR_DECISIONS,
  recordCustomerSubmission,
  recordOperatorDecision,
  expireOverdueCases,
  DOCUMENTS_PAR_MOTIF,
  MOTIFS_SANS_DEMANDE,
  REQUIRED_DOCUMENTS,
  CLIENT_CATEGORIES,
  requiredDocumentsFor,
  clientCategoryFor,
  buildStepUpRecords,
  openStepUpReview,
};
