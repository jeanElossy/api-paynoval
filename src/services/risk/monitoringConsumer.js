"use strict";

/**
 * ============================================================================
 * SURVEILLANCE AML ASYNCHRONE — CE QUE LA DÉCISION EN LIGNE NE PEUT PAS VOIR
 * ============================================================================
 *
 * ── Pourquoi ce consommateur existe ─────────────────────────────────────────
 *
 * L'AML de `middleware/aml.js` décide EN LIGNE, avant que l'argent parte : il
 * voit UNE opération et répond en quelques millisecondes. C'est ce qu'il faut
 * pour bloquer, et c'est structurellement incapable de voir un MOTIF.
 *
 * Le fractionnement en est l'exemple canonique : dix virements de 90 000 quand
 * le plafond de déclaration est à 100 000. Chacun est parfaitement légal, aucun
 * ne déclenche quoi que ce soit, et l'ensemble est précisément ce que la
 * réglementation appelle du *structuring*. Aucun contrôle unitaire ne peut le
 * détecter — il faut regarder la série.
 *
 * C'est la raison d'être de la surveillance asynchrone chez tous les
 * établissements de paiement : une décision en ligne qui bloque, une
 * surveillance en différé qui observe. Les deux, pas l'une ou l'autre.
 *
 * ── Pourquoi elle est asynchrone, et non ajoutée au contrôle en ligne ───────
 *
 * Parce qu'elle coûte cher — elle agrège l'historique — et que le chemin de
 * l'argent ne doit pas payer ce coût. Un contrôle qui rallonge chaque virement
 * de 200 ms pour détecter un motif que l'on peut voir dix secondes plus tard
 * est un mauvais échange : le fractionnement se constate, il ne s'intercepte
 * pas.
 *
 * ── Ce qu'elle ne fait PAS ──────────────────────────────────────────────────
 *
 * Elle ne bloque rien et n'annule rien. Elle OUVRE UN DOSSIER (`AMLLog`,
 * `flagged: true`) que le back-office de conformité instruit. Un traitement
 * asynchrone qui déciderait de bloquer agirait sur un état qu'il a lu dans le
 * passé — et l'argent est peut-être déjà parti. Décider en ligne, observer en
 * différé : les rôles ne se mélangent pas.
 */

const { getTxConn } = require("../../config/db");
const { createConsumer } = require("../events/consumer");
const logger = require("../../utils/logger");

const GROUPE = "risk-monitoring";

const EVENEMENTS = Object.freeze([
  "transaction.initiated.v1",
  "transaction.confirmed.v1",
  "collection.succeeded.v1",
]);

let _AMLLog = null;
let _ProcessedEvent = null;
let _DomainEvent = null;

function AMLLog() {
  if (!_AMLLog) _AMLLog = require("../../models/AMLLog");
  return _AMLLog;
}

function ProcessedEvent() {
  if (!_ProcessedEvent) {
    _ProcessedEvent = require("../../models/ProcessedEvent")(getTxConn());
  }
  return _ProcessedEvent;
}

function DomainEvent() {
  if (!_DomainEvent) {
    _DomainEvent = require("../../models/DomainEvent")(getTxConn());
  }
  return _DomainEvent;
}

/* -------------------------------------------------------------------------- */
/* Règles de surveillance                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Fenêtre d'observation du fractionnement.
 *
 * ⚠️ Ces trois seuils sont des paramètres de POLITIQUE, pas des constantes
 * techniques. Ils sont ici et non dispersés dans le code pour qu'un
 * responsable conformité puisse les lire, et annoncés au démarrage pour qu'on
 * sache lesquels sont en vigueur (règle B.6).
 */
const FRACTIONNEMENT = Object.freeze({
  fenetreMs: Math.max(
    3600 * 1000,
    Number(process.env.AML_STRUCTURING_WINDOW_MS || 24 * 3600 * 1000)
  ),
  /** Nombre d'opérations sous le seuil qui déclenche l'ouverture d'un dossier. */
  occurrences: Math.max(
    3,
    Number(process.env.AML_STRUCTURING_MIN_COUNT || 4)
  ),
  /**
   * Une opération n'est « sous le seuil » que si elle en approche : à 3 % du
   * plafond, ce n'est pas du fractionnement, c'est un usage normal. Le ratio
   * évite de compter tout le trafic ordinaire comme suspect — un détecteur qui
   * signale tout ne signale rien.
   */
  ratioMin: Math.min(
    0.99,
    Math.max(0.3, Number(process.env.AML_STRUCTURING_MIN_RATIO || 0.6))
  ),
});

/**
 * Le plafond de référence, par devise.
 *
 * ⚠️ ÉCHOUE EN FERMETURE : une devise inconnue ne prend pas un plafond par
 * défaut généreux, elle rend `null` et la règle NE S'APPLIQUE PAS — le dossier
 * n'est pas ouvert, et le fait est journalisé. Inventer un seuil produirait des
 * dossiers arbitraires, ce qui est pire que pas de dossier : un analyste perdrait
 * son temps sur du bruit et finirait par ignorer la règle entière (règle B.2
 * appliquée à la détection).
 */
const SEUILS_DECLARATION = Object.freeze({
  XOF: Number(process.env.AML_REPORTING_THRESHOLD_XOF || 5000000),
  EUR: Number(process.env.AML_REPORTING_THRESHOLD_EUR || 10000),
  USD: Number(process.env.AML_REPORTING_THRESHOLD_USD || 10000),
});

function seuilDeclaration(devise) {
  const code = String(devise || "").trim().toUpperCase();
  const valeur = SEUILS_DECLARATION[code];

  return Number.isFinite(valeur) && valeur > 0 ? valeur : null;
}

/**
 * Détecte le fractionnement en relisant les ÉVÉNEMENTS, pas les transactions.
 *
 * ⚠️ C'est délibéré et ce n'est pas un détail. Relire `Transaction` ferait de ce
 * consommateur un lecteur de plus du modèle interne du moteur : il se casserait
 * au premier renommage de champ, et il verrait des états intermédiaires que
 * personne n'a publiés. Relire le journal d'événements le lie au CONTRAT — la
 * seule chose sur laquelle il a le droit de compter.
 */
async function detecterFractionnement({ sujetId, devise, maintenant }) {
  const seuil = seuilDeclaration(devise);

  if (!seuil) {
    logger.warn("[risk] fractionnement non évalué — devise sans seuil déclaré", {
      devise: String(devise || ""),
      consequence:
        "aucun dossier ne sera ouvert pour ce sujet dans cette devise ; " +
        "renseigner AML_REPORTING_THRESHOLD_<DEVISE>",
    });

    return null;
  }

  const depuis = new Date(maintenant.getTime() - FRACTIONNEMENT.fenetreMs);
  const plancher = seuil * FRACTIONNEMENT.ratioMin;

  const evenements = await DomainEvent()
    .find({
      name: { $in: ["transaction.initiated.v1", "transaction.confirmed.v1"] },
      occurredAt: { $gte: depuis, $lte: maintenant },
      "payload.senderId": String(sujetId),
      "payload.currency": String(devise).toUpperCase(),
    })
    .select({ payload: 1, occurredAt: 1 })
    .lean();

  /**
   * ⚠️ DÉDOUBLONNAGE PAR TRANSACTION.
   *
   * `initiated` et `confirmed` décrivent la MÊME transaction. Les compter tous
   * les deux doublerait mécaniquement chaque opération et ferait franchir le
   * seuil à quatre virements au lieu de huit — un détecteur qui invente la
   * moitié de ses signalements.
   */
  const parTransaction = new Map();

  for (const evenement of evenements) {
    const id = String(evenement?.payload?.transactionId || "");
    const montant = Number(evenement?.payload?.amount);

    if (!id || !Number.isFinite(montant)) continue;

    parTransaction.set(id, montant);
  }

  const sousLeSeuil = [...parTransaction.values()].filter(
    (montant) => montant >= plancher && montant < seuil
  );

  if (sousLeSeuil.length < FRACTIONNEMENT.occurrences) return null;

  const cumul = sousLeSeuil.reduce((total, montant) => total + montant, 0);

  return {
    code: "AML_STRUCTURING",
    occurrences: sousLeSeuil.length,
    cumul,
    seuil,
    plancher,
    fenetreHeures: Math.round(FRACTIONNEMENT.fenetreMs / 3600000),
    /**
     * Le cumul dépasse-t-il le seuil que le fractionnement cherchait à éviter ?
     * C'est ce qui distingue « quelqu'un fait plusieurs virements moyens » de
     * « quelqu'un a déplacé plus que le seuil en le découpant ».
     */
    depasseParCumul: cumul >= seuil,
  };
}

/* -------------------------------------------------------------------------- */
/* Ouverture de dossier                                                       */
/* -------------------------------------------------------------------------- */

async function ouvrirDossier({ sujetId, constat, devise, evenement }) {
  /**
   * ⚠️ CHAMPS NOMMÉS UNIQUEMENT (règle B.4).
   *
   * Le dossier porte les CHIFFRES du constat et les identifiants — jamais la
   * charge utile de l'événement. Un journal de conformité est consulté par
   * plusieurs personnes ; y déverser le contenu d'une opération y ferait
   * entrer des données personnelles qui n'aident pas à l'instruction.
   */
  await AMLLog().create({
    userId: sujetId || null,
    type: "initiate",
    provider: "surveillance",
    amount: constat.cumul,
    currency: String(devise || "").toUpperCase() || null,
    toEmail: "",
    details: {
      code: constat.code,
      detectedBy: GROUPE,
      occurrences: constat.occurrences,
      cumul: constat.cumul,
      seuilDeclaration: constat.seuil,
      plancherRetenu: constat.plancher,
      fenetreHeures: constat.fenetreHeures,
      depasseParCumul: constat.depasseParCumul,
      /** Traçabilité : quel événement a déclenché l'ouverture (invariant 11). */
      triggerEventId: evenement.eventId,
      triggerEventName: evenement.name,
    },
    flagged: true,
    flagReason:
      `${constat.code} : ${constat.occurrences} opérations entre ` +
      `${Math.round(constat.plancher)} et ${constat.seuil} sur ` +
      `${constat.fenetreHeures} h, cumul ${Math.round(constat.cumul)}.`,
    reviewed: false,
    transactionId: null,
    ip: null,
    loggedAt: new Date(),
  });

  logger.warn("[risk] dossier de conformité ouvert", {
    code: constat.code,
    sujetId: String(sujetId || ""),
    occurrences: constat.occurrences,
    devise: String(devise || ""),
  });
}

/* -------------------------------------------------------------------------- */
/* Gestionnaire                                                               */
/* -------------------------------------------------------------------------- */

function sujetDe(message) {
  const p = message.payload || {};

  /**
   * Pour un encaissement public, le payeur n'a pas de compte : le sujet est la
   * cagnotte destinataire. Rattacher le dossier à « personne » le rendrait
   * inexploitable.
   */
  if (message.name === "collection.succeeded.v1") return p.cagnotteId || "";

  return p.senderId || "";
}

async function handler(message) {
  const sujetId = sujetDe(message);
  const devise = message?.payload?.currency;

  let outcome = "aucun-motif";

  if (sujetId && devise && message.name !== "collection.succeeded.v1") {
    const constat = await detecterFractionnement({
      sujetId,
      devise,
      maintenant: message.occurredAt ? new Date(message.occurredAt) : new Date(),
    });

    if (constat) {
      await ouvrirDossier({ sujetId, constat, devise, evenement: message });
      outcome = constat.code;
    }
  }

  /**
   * ⚠️ LE REGISTRE S'ÉCRIT APRÈS LE TRAITEMENT, JAMAIS AVANT.
   *
   * L'écrire d'abord marquerait l'événement comme traité alors qu'il ne l'est
   * pas encore : une panne entre les deux le ferait disparaître définitivement
   * de la surveillance. Dans cet ordre, la même panne produit une relivraison —
   * et le dossier serait ouvert deux fois.
   *
   * C'est le compromis assumé du « au moins une fois » : un doublon de dossier
   * se voit et se ferme, une absence de dossier ne se voit pas. Sur une surface
   * de conformité, la dissymétrie est franche.
   */
  await ProcessedEvent().create({
    group: GROUPE,
    eventId: message.eventId,
    eventName: message.name,
    processedAt: new Date(),
    outcome,
  });
}

async function dejaTraite(eventId) {
  if (!eventId) return false;

  const trouve = await ProcessedEvent()
    .findOne({ group: GROUPE, eventId: String(eventId) })
    .select({ _id: 1 })
    .lean();

  return Boolean(trouve);
}

/**
 * Une lettre morte sur une surface de conformité n'est PAS un simple journal :
 * c'est un événement que la surveillance n'a pas su examiner. Il faut qu'un
 * humain le sache.
 */
async function onDeadLetter(message, err) {
  logger.error("[risk] ÉVÉNEMENT NON SURVEILLÉ — lettre morte", {
    eventId: message?.eventId,
    name: message?.name,
    message: err?.message,
    consequence:
      "cet événement ne sera pas examiné par la surveillance de conformité ; " +
      "il reste consultable dans domain_events par son eventId",
  });

  try {
    await ProcessedEvent().create({
      group: GROUPE,
      eventId: message.eventId,
      eventName: message.name,
      processedAt: new Date(),
      outcome: "lettre-morte",
    });
  } catch {
    /**
     * Le registre est un confort ici, pas une garantie : l'information
     * essentielle est déjà partie dans le journal ci-dessus. Une erreur
     * d'écriture ne doit pas empêcher l'acquittement, sinon le message
     * empoisonné bloque le groupe — exactement ce que la lettre morte évite.
     */
  }
}

function build({ logger: journal = logger } = {}) {
  return createConsumer({
    groupe: GROUPE,
    evenements: EVENEMENTS,
    handler,
    dejaTraite,
    onDeadLetter,
    logger: journal,
  });
}

/** Règle B.6 : ce qui est en vigueur se dit au démarrage. */
function annoncer(journal = logger) {
  const devisesCouvertes = Object.entries(SEUILS_DECLARATION)
    .filter(([, v]) => Number.isFinite(v) && v > 0)
    .map(([k, v]) => `${k}:${v}`);

  journal.info?.(
    `✅ Surveillance AML — fractionnement : ${FRACTIONNEMENT.occurrences} ` +
      `opérations entre ${Math.round(FRACTIONNEMENT.ratioMin * 100)} % et 100 % ` +
      `du seuil sur ${Math.round(FRACTIONNEMENT.fenetreMs / 3600000)} h. ` +
      `Seuils de déclaration : ${devisesCouvertes.join(", ")}.`
  );

  journal.warn?.(
    "⚠️ Toute devise absente de cette liste n'est PAS surveillée pour le " +
      "fractionnement — aucun dossier ne sera ouvert dans cette devise."
  );
}

module.exports = {
  GROUPE,
  EVENEMENTS,
  FRACTIONNEMENT,
  SEUILS_DECLARATION,
  seuilDeclaration,
  detecterFractionnement,
  handler,
  dejaTraite,
  build,
  annoncer,
};
