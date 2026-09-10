"use strict";

/**
 * ============================================================================
 * ENCAISSEMENT ENTRANT — L'ARGENT QUI ENTRE
 * ============================================================================
 *
 * ── Ce que ce service ferme ─────────────────────────────────────────────────
 *
 * Les cinq adaptateurs exposent `collect()`. Rien ne l'appelait. La capacité
 * d'encaisser était écrite et morte, et c'est la vraie raison pour laquelle la
 * participation à une cagnotte par lien public ne fonctionnait pas — pas
 * seulement l'URL fermée en 410 côté passerelle, qui n'en était que la partie
 * visible.
 *
 * ── La forme, celle de Stripe et d'Adyen ────────────────────────────────────
 *
 *   1. INITIER   → on crée une intention et on demande au prestataire de
 *                  prélever. **Aucune écriture au grand livre.**
 *   2. ATTENDRE  → le prestataire prélève chez le payeur. Cela prend de
 *                  quelques secondes (carte) à plusieurs minutes (mobile money,
 *                  où le client doit saisir son code sur son téléphone).
 *   3. CONFIRMER → le rappel SIGNÉ du prestataire dit que l'argent est prélevé.
 *                  C'est là, et seulement là, que le grand livre est écrit.
 *
 * L'étape 1 ne rend jamais « payé ». Elle rend « en cours ». Confondre les deux
 * est la faute que la règle B.3 nomme : une 200 HTTP ne vaut pas succès
 * financier. C'est précisément ce que faisait la passerelle, qui créditait la
 * cagnotte sur la réponse HTTP du prestataire, sans attendre aucun rappel.
 *
 * ── Pourquoi aucun appel prestataire dans une transaction Mongo ─────────────
 *
 * `collect()` parle au réseau, avec un délai d'attente pouvant atteindre 30 s.
 * Une transaction MongoDB vit 60 s par défaut : la tenir ouverte pendant
 * l'attente réseau garde des verrous sur des documents que d'autres requêtes
 * veulent lire, et au-delà de la limite le serveur tue la transaction sous nos
 * pieds — après que le prestataire a, lui, bien reçu l'ordre.
 *
 * Ici la question ne se pose même pas : à l'initiation, il n'y a AUCUN
 * mouvement d'argent à rendre atomique. Un document d'intention, un appel
 * réseau, une mise à jour de statut.
 */

const crypto = require("crypto");
const mongoose = require("mongoose");

const logger = require("../../logger");
const { publishDomainEvent } = require("../events/publisher");
const { getProviderAdapter } = require("../../providers/providerSelector");

/**
 * Rails et prestataires SERVIS. Table close, alignée sur
 * `cagnotteController.RAIL_PAR_OPERATEUR` côté backend principal et sur
 * `providerSelector`.
 *
 * ⚠️ Aucun défaut, aucune inférence. Le rail désigne le compte de compensation
 * d'entrée (`PROVIDER_INBOUND:<RAIL>`), donc le relevé prestataire auquel
 * l'écriture sera rapprochée. En deviner un rendrait le rapprochement impossible
 * sans qu'aucune erreur ne le signale (règle B.2).
 */
const RAILS = Object.freeze({
  mobilemoney: Object.freeze(["wave", "orange", "mtn", "moov"]),
  card: Object.freeze(["visa_direct"]),
});

/** Motifs d'encaissement servis. Un motif inconnu n'a pas de destinataire. */
const PURPOSES = Object.freeze(["cagnotte_participation"]);

/**
 * ============================================================================
 * ⚠️ LE PAN N'ENTRE PAS SUR NOS SERVEURS
 * ============================================================================
 *
 * `visaDirectAdapter.collect()` acceptait `source.pan`, et la page de paiement
 * publique postait `cardNumber` et `cvc` en clair vers la passerelle. Le numéro
 * de carte traversait donc la passerelle ET Tx-Core.
 *
 * Ce n'est pas une question de stockage — rien n'était stocké. C'est une
 * question de PÉRIMÈTRE : dès qu'un PAN transite par un serveur, ce serveur
 * entre dans le périmètre PCI-DSS, et l'attestation applicable passe de SAQ A
 * (une trentaine de contrôles) à SAQ D (plus de trois cents, avec analyse de
 * vulnérabilités trimestrielle et test d'intrusion annuel).
 *
 * Stripe, Adyen et Checkout.com règlent cela de la même façon : le navigateur
 * envoie les données de carte DIRECTEMENT au prestataire, qui rend un jeton
 * opaque. Le serveur du marchand ne voit qu'un jeton. C'est la voie retenue.
 *
 * Ces champs sont donc REFUSÉS, en fermeture. Les ignorer silencieusement
 * serait pire : la page publique continuerait de les envoyer, ils
 * traverseraient les journaux d'accès et les traces d'erreur du réseau, et
 * personne ne saurait que le périmètre PCI est ouvert.
 */
const CHAMPS_CARTE_INTERDITS = Object.freeze([
  "pan",
  "cardnumber",
  "card_number",
  "cvc",
  "cvv",
  "cvv2",
  "securitycode",
  "security_code",
  "expmonth",
  "exp_month",
  "expyear",
  "exp_year",
  "expirymonth",
  "expiryyear",
  "track2",
]);

class CollectionError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function norm(v) {
  return String(v ?? "").trim();
}

function lower(v) {
  return norm(v).toLowerCase();
}

/**
 * Cherche un champ de carte n'importe où dans la charge utile, à n'importe
 * quelle profondeur. Un contrôle limité au premier niveau se contourne en
 * emballant les données dans un sous-objet — ce que fait déjà l'adaptateur avec
 * `source.pan`.
 */
function trouverChampCarte(valeur, profondeur = 0) {
  if (!valeur || typeof valeur !== "object" || profondeur > 6) return null;

  for (const [cle, sousValeur] of Object.entries(valeur)) {
    if (CHAMPS_CARTE_INTERDITS.includes(lower(cle).replace(/[^a-z0-9_]/g, ""))) {
      return cle;
    }
    const trouve = trouverChampCarte(sousValeur, profondeur + 1);
    if (trouve) return trouve;
  }

  return null;
}

function assertAucuneDonneeCarte(charge) {
  const champ = trouverChampCarte(charge);
  if (!champ) return;

  /**
   * ⚠️ Le message ne cite QUE le nom du champ, jamais sa valeur. Journaliser
   * « pan=4242… » pour expliquer qu'on refuse les PAN serait le comble.
   */
  throw new CollectionError(
    400,
    "RAW_CARD_DATA_REFUSED",
    `Donnée de carte en clair refusée (champ « ${champ} »). PayNoval n'accepte ` +
      "qu'un jeton opaque émis par le prestataire depuis le navigateur du " +
      "payeur — le numéro de carte ne doit jamais atteindre nos serveurs."
  );
}

function assertRailEtPrestataire(rail, provider) {
  const r = lower(rail);
  const p = lower(provider);

  if (!Object.prototype.hasOwnProperty.call(RAILS, r)) {
    throw new CollectionError(
      400,
      "UNKNOWN_RAIL",
      `Rail d'encaissement inconnu : « ${r || "(absent)"} ».`
    );
  }

  if (!RAILS[r].includes(p)) {
    throw new CollectionError(
      400,
      "UNKNOWN_PROVIDER",
      `Prestataire « ${p || "(absent)"} » non servi sur le rail « ${r} ».`
    );
  }

  return { rail: r, provider: p };
}

/**
 * Référence PayNoval de l'encaissement, DÉRIVÉE de la clé d'idempotence.
 *
 * Elle doit être stable d'une tentative à l'autre : c'est elle qui produit le
 * `_id` du document, donc la collision qui empêche le doublon même quand la
 * transaction MongoDB n'est pas disponible. Une référence tirée au hasard
 * rendrait chaque rejeu unique — c'est-à-dire non idempotent, sans qu'aucune
 * erreur ne le signale.
 */
function referenceFromIdempotencyKey(idempotencyKey) {
  const cle = norm(idempotencyKey);

  if (cle.length < 8) {
    throw new CollectionError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Clé d'idempotence absente ou trop courte : un encaissement non " +
        "idempotent se double au premier rejeu du client."
    );
  }

  const empreinte = crypto
    .createHash("sha256")
    .update(`collection.intent|${cle}`)
    .digest("hex")
    .slice(0, 24)
    .toUpperCase();

  return `PNVIN_${empreinte}`;
}

function objectIdFromReference(reference) {
  const hex = crypto
    .createHash("sha256")
    .update(`collection.intent|${reference}`)
    .digest("hex")
    .slice(0, 24);

  return new mongoose.Types.ObjectId(hex);
}

function last4(valeur) {
  const chiffres = norm(valeur).replace(/\D/g, "");
  return chiffres ? chiffres.slice(-4) : "";
}

function getModel(conn) {
  const model = conn?.models?.CollectionIntent;

  if (!model) {
    throw new CollectionError(
      503,
      "MODEL_UNAVAILABLE",
      "CollectionIntent non enregistré sur la connexion transactions."
    );
  }

  return model;
}

/**
 * ============================================================================
 * INITIER UN ENCAISSEMENT
 * ============================================================================
 *
 * Rend `{ intent, replayed }`. `replayed` vaut `true` quand la demande existait
 * déjà : on rend alors l'état courant SANS rappeler le prestataire. Redemander
 * un prélèvement déjà demandé, c'est prélever deux fois le payeur.
 */
async function initiateCollection(conn, entree = {}) {
  assertAucuneDonneeCarte(entree);

  const { rail, provider } = assertRailEtPrestataire(entree.rail, entree.provider);

  const purpose = lower(entree.purpose);
  if (!PURPOSES.includes(purpose)) {
    throw new CollectionError(
      400,
      "UNKNOWN_PURPOSE",
      `Motif d'encaissement inconnu : « ${purpose || "(absent)"} ». Un motif ` +
        "sans destinataire encaisserait de l'argent que personne n'apprendrait."
    );
  }

  const amount = Number(entree.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new CollectionError(400, "INVALID_AMOUNT", "Montant invalide.");
  }

  const currency = norm(entree.currency).toUpperCase();
  if (currency.length < 3 || currency.length > 4) {
    throw new CollectionError(400, "INVALID_CURRENCY", "Devise invalide.");
  }

  if (purpose === "cagnotte_participation" && !norm(entree.target?.cagnotteCode)) {
    throw new CollectionError(
      400,
      "TARGET_REQUIRED",
      "Code de participation absent : l'encaissement ne serait rattachable à " +
        "aucune cagnotte."
    );
  }

  const reference = referenceFromIdempotencyKey(entree.idempotencyKey);
  const Model = getModel(conn);

  const existant = await Model.findById(objectIdFromReference(reference)).lean();

  if (existant) {
    /**
     * ⚠️ ON NE RAPPELLE PAS LE PRESTATAIRE. Un rejeu de la page de paiement —
     * double clic, réseau qui bégaie, bouton « réessayer » — ne doit pas
     * produire un second prélèvement chez le payeur.
     */
    logger.info("[collection] rejeu — intention déjà connue", {
      reference,
      status: existant.status,
      rail,
      provider,
    });

    return { intent: existant, replayed: true };
  }

  const doc = {
    _id: objectIdFromReference(reference),
    reference,
    idempotencyKey: norm(entree.idempotencyKey),
    rail,
    provider,
    amount,
    currency,
    purpose,
    target: {
      cagnotteId: norm(entree.target?.cagnotteId),
      cagnotteCode: norm(entree.target?.cagnotteCode),
    },
    payerPhoneLast4: rail === "mobilemoney" ? last4(entree.payer?.phone) : "",
    payerDisplayName: norm(entree.payer?.displayName).slice(0, 120),
    status: "created",
    requestId: norm(entree.requestId),
  };

  let intent;

  try {
    intent = await Model.create(doc);
  } catch (err) {
    /**
     * Course entre deux requêtes portant la même clé d'idempotence : la seconde
     * entre en collision sur `_id`. Ce n'est pas une erreur, c'est l'idempotence
     * qui fonctionne — on rend l'état écrit par la première.
     */
    if (err?.code === 11000) {
      const gagnant = await Model.findById(doc._id).lean();
      if (gagnant) return { intent: gagnant, replayed: true };
    }
    throw err;
  }

  /**
   * ── APPEL PRESTATAIRE, HORS DE TOUTE TRANSACTION ──────────────────────────
   *
   * L'intention est déjà persistée : si le processus meurt pendant cet appel,
   * le document reste en `created` et le rapprochement le verra. L'inverse —
   * appeler d'abord, écrire ensuite — perdrait la trace d'un prélèvement
   * réellement demandé au prestataire.
   */
  const adapter = getProviderAdapter({ rail, provider });

  if (!adapter || typeof adapter.collect !== "function") {
    await Model.updateOne(
      { _id: doc._id },
      {
        $set: {
          status: "failed",
          lastErrorCode: "COLLECT_UNSUPPORTED",
          lastErrorMessage: `L'adaptateur ${provider} n'expose pas collect().`,
        },
      }
    );

    throw new CollectionError(
      501,
      "COLLECT_UNSUPPORTED",
      `Le prestataire ${provider} ne sait pas encaisser.`
    );
  }

  let resultat;

  try {
    resultat = await adapter.collect({
      reference,
      txReference: reference,
      idempotencyKey: doc.idempotencyKey,
      amount,
      currency,
      phone: norm(entree.payer?.phone) || null,
      customerName: doc.payerDisplayName || null,
      country: norm(entree.payer?.country) || null,
      operator: provider,
      /**
       * ⚠️ Jeton opaque du prestataire, JAMAIS un PAN. `assertAucuneDonneeCarte`
       * a déjà refusé la charge utile si elle en portait un.
       */
      cardToken: norm(entree.cardToken) || null,
      description: `PayNoval ${purpose}`,
      metadata: {
        purpose,
        cagnotteCode: doc.target.cagnotteCode,
      },
    });
  } catch (err) {
    await Model.updateOne(
      { _id: doc._id },
      {
        $set: {
          status: "failed",
          lastErrorCode: "COLLECT_CALL_FAILED",
          lastErrorMessage: norm(err?.message).slice(0, 500),
        },
      }
    );

    logger.error("[collection] appel prestataire en échec", {
      reference,
      rail,
      provider,
      error: err?.message,
    });

    throw new CollectionError(
      502,
      "COLLECT_CALL_FAILED",
      "Le prestataire n'a pas pu être joint."
    );
  }

  const accepte = resultat?.success === true || resultat?.ok === true;

  const maj = accepte
    ? {
        status: "pending",
        providerReference: norm(resultat.providerReference),
        providerStatus: norm(resultat.externalStatus || resultat.status),
      }
    : {
        status: "failed",
        providerReference: norm(resultat?.providerReference),
        providerStatus: norm(resultat?.externalStatus || resultat?.status),
        lastErrorCode: norm(resultat?.errorCode) || "COLLECT_REFUSED",
        lastErrorMessage: norm(resultat?.errorMessage).slice(0, 500),
      };

  await Model.updateOne({ _id: doc._id }, { $set: maj });

  logger.info("[collection] intention initiée", {
    reference,
    rail,
    provider,
    status: maj.status,
    providerReference: maj.providerReference || null,
  });

  if (!accepte) {
    throw new CollectionError(
      402,
      maj.lastErrorCode,
      maj.lastErrorMessage || "Le prestataire a refusé l'encaissement."
    );
  }

  return { intent: { ...doc, ...maj }, replayed: false };
}

/**
 * ============================================================================
 * CONFIRMER UN ENCAISSEMENT — LE SEUL ENDROIT OÙ L'ARGENT DEVIENT RÉEL
 * ============================================================================
 *
 * Appelée par `providerWebhookController` APRÈS vérification de la signature et
 * APRÈS la réservation de l'événement dans le registre d'idempotence.
 *
 * ⚠️ Cette fonction n'écrit PAS au grand livre elle-même. Elle constate l'état
 * chez le prestataire, puis PRÉVIENT le propriétaire du produit — le backend
 * principal pour une cagnotte — qui décide de l'effet métier et demande le
 * règlement à `/api/v1/cagnotte/external-participation/settle`.
 *
 * Pourquoi ce détour plutôt qu'écrire directement : la cagnotte appartient au
 * backend principal. C'est lui qui sait si elle est close, si l'objectif est
 * atteint, quels frais s'appliquent et qui doit être notifié. Écrire le grand
 * livre ici obligerait Tx-Core à connaître tout cela — c'est-à-dire à
 * réimplémenter le produit, avec la divergence garantie qui va avec.
 */
async function confirmCollection(conn, entree = {}) {
  const Model = getModel(conn);

  const reference = norm(entree.reference);
  const providerReference = norm(entree.providerReference);

  if (!reference && !providerReference) return null;

  const intent = await Model.findOne(
    reference ? { reference } : { providerReference }
  ).lean();

  if (!intent) return null;

  const statutPrestataire = lower(entree.providerStatus);

  const reussi = ["succeeded", "success", "completed", "confirmed", "paid"].includes(
    statutPrestataire
  );
  const echoue = ["failed", "declined", "cancelled", "canceled", "expired"].includes(
    statutPrestataire
  );

  if (!reussi && !echoue) {
    /**
     * Un statut intermédiaire (`pending`, `processing`) n'est pas une
     * confirmation. On l'enregistre pour le diagnostic et on ne change rien
     * d'autre — surtout pas vers `succeeded`.
     */
    await Model.updateOne(
      { _id: intent._id },
      { $set: { providerStatus: statutPrestataire } }
    );

    return { intent, changed: false, outcome: "pending" };
  }

  if (intent.status === "succeeded" || intent.status === "failed") {
    /**
     * Déjà tranché. Un prestataire réémet ses rappels, c'est le protocole et
     * non un accident : on ne rejoue rien.
     */
    return { intent, changed: false, outcome: "replay" };
  }

  const changement = {
    $set: {
      status: reussi ? "succeeded" : "failed",
      providerStatus: statutPrestataire,
      providerReference: providerReference || intent.providerReference || "",
      confirmedAt: new Date(),
      ...(echoue
        ? {
            lastErrorCode: "PROVIDER_DECLINED",
            lastErrorMessage: `Le prestataire a rendu « ${statutPrestataire} ».`,
          }
        : {}),
    },
  };

  /**
   * ══════════════════════════════════════════════════════════════════════════
   * LE CHANGEMENT D'ÉTAT ET SON ÉVÉNEMENT, ENSEMBLE OU PAS DU TOUT
   * ══════════════════════════════════════════════════════════════════════════
   *
   * Ce chemin n'ouvrait aucune transaction — et il n'en avait pas besoin tant
   * qu'il n'écrivait qu'un document. Publier un événement en change la donne :
   * deux écritures séparées peuvent diverger, et un encaissement confirmé sans
   * événement échapperait DÉFINITIVEMENT à la surveillance de conformité, sans
   * que rien ne le signale.
   *
   * ⚠️ La transaction reste STRICTEMENT LOCALE : deux écritures Mongo sur la
   * même connexion, aucun appel réseau à l'intérieur. C'est l'invariant que
   * l'en-tête de `initiateInternal.js` défend — un appel réseau enfermé dans une
   * transaction tient des verrous pendant l'attente, et au-delà de 60 s le
   * serveur tue la transaction sous nos pieds.
   *
   * Repli assumé si les transactions ne sont pas disponibles (instance Mongo
   * autonome, sans jeu de réplicas) : on écrit les deux à la suite et on le DIT.
   * La fenêtre est de quelques millisecondes, elle est nommée, et elle ne se
   * découvre pas dans un rapport de conformité six mois plus tard.
   */
  const evenementCollection = reussi
    ? {
        name: "collection.succeeded.v1",
        aggregateId: String(intent._id),
        occurredAt: new Date(),
        payload: {
          collectionId: String(intent._id),
          reference: intent.reference || "",
          rail: intent.rail || "",
          provider: intent.provider || "",
          amount: Number(intent.amount ?? 0),
          currency: String(intent.currency || ""),
          cagnotteId: String(intent.cagnotteId || ""),
          /** Quatre derniers chiffres, jamais le numéro (règle B.4). */
          payerPhoneLast4: intent.payerPhoneLast4 || "",
          payerCountry: intent.payerCountry || "",
          succeededAt: new Date().toISOString(),
        },
      }
    : null;

  let session = null;

  try {
    session = await conn.startSession();
  } catch {
    session = null;
  }

  if (session && evenementCollection) {
    try {
      await session.withTransaction(async () => {
        await Model.updateOne({ _id: intent._id }, changement, { session });
        await publishDomainEvent(evenementCollection, session);
      });
    } finally {
      try {
        await session.endSession();
      } catch {}
    }
  } else {
    if (evenementCollection) {
      logger.warn("[collection] état et événement écrits SANS transaction", {
        reference: intent.reference,
        consequence:
          "une panne entre les deux écritures laisserait un encaissement " +
          "confirmé sans événement — invisible de la surveillance",
      });
    }

    await Model.updateOne({ _id: intent._id }, changement);

    if (evenementCollection) {
      await publishDomainEvent(evenementCollection);
    }
  }

  logger.info("[collection] encaissement confirmé", {
    reference: intent.reference,
    rail: intent.rail,
    provider: intent.provider,
    outcome: reussi ? "succeeded" : "failed",
  });

  return {
    intent: { ...intent, status: reussi ? "succeeded" : "failed" },
    changed: true,
    outcome: reussi ? "succeeded" : "failed",
  };
}

/**
 * Marque l'encaissement comme réglé au grand livre.
 *
 * Séparé de `confirmCollection` à dessein : entre la confirmation et le
 * règlement il n'y a pas d'atomicité, et un encaissement `succeeded` sans
 * `settlementReference` est exactement l'écart que le rapprochement doit
 * pouvoir voir. Fondre les deux le rendrait invisible.
 */
async function markCollectionSettled(conn, reference, settlementReference) {
  const Model = getModel(conn);

  await Model.updateOne(
    { reference: norm(reference) },
    {
      $set: {
        settlementReference: norm(settlementReference),
        settledAt: new Date(),
      },
    }
  );
}

module.exports = {
  RAILS,
  PURPOSES,
  CHAMPS_CARTE_INTERDITS,
  CollectionError,
  assertAucuneDonneeCarte,
  assertRailEtPrestataire,
  referenceFromIdempotencyKey,
  objectIdFromReference,
  initiateCollection,
  confirmCollection,
  markCollectionSettled,
};
