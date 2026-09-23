"use strict";

/**
 * ============================================================================
 * NOTIFICATIONS SUR LE BUS — la branche « Notification » du schéma cible
 * ============================================================================
 *
 * ── Le couplage que ce consommateur referme ─────────────────────────────────
 *
 * Jusqu'au 2026-09-10, `transactionNotificationService` écrivait DIRECTEMENT
 * dans deux collections du backend principal : `notifications` (la boîte de
 * réception de l'application) et `outboxes` (la file de livraison). Deux
 * services écrivant les mêmes collections, chacun avec sa propre déclaration de
 * schéma.
 *
 * C'est la classe de défaut refermée sur `tx_wallet_balances` (R-06) : la
 * validation, les index et la machine à états vivent d'un côté, l'autre écrit
 * sans les connaître, et les deux divergent à la première évolution. Là-bas,
 * cela stockait un flottant sous un champ relu comme décimal exact ; ici
 * l'enjeu n'est pas monétaire, mais le mécanisme est identique.
 *
 * ── Ce qui le remplace ──────────────────────────────────────────────────────
 *
 * Tx-Core publie `notification.requested.v1` DANS la transaction qui déplace
 * l'argent — l'équivalence « la transaction est confirmée ⟺ la notification est
 * demandée » est donc conservée. Ce consommateur appelle
 * `POST /api/v1/internal/notifications/enqueue`, et le backend redevient le
 * SEUL écrivain de ses collections.
 *
 * ── L'idempotence est portée par la clé, pas par le transport ───────────────
 *
 * `idempotencyKey` est construite par le producteur à partir de la transaction,
 * du destinataire, du statut et du canal : elle est STABLE d'un rejeu à l'autre.
 * Le backend s'en sert deux fois — `dedupeKey` sur la notification affichée, et
 * clé d'unicité de l'outbox. Un redéploiement du consommateur ne produit donc
 * aucun doublon visible pour l'utilisateur.
 */

const { getTxConn } = require("../../config/db");
const { createConsumer } = require("../events/consumer");
const logger = require("../../utils/logger");
const {
  basePrincipal,
  jetonPrincipal,
} = require("../../utils/principalEndpoint");

const GROUPE = "notification-dispatch";

const EVENEMENTS = Object.freeze(["notification.requested.v1"]);

const DELAI_MS = Math.max(
  2000,
  Number(process.env.NOTIFICATION_DISPATCH_TIMEOUT_MS || 10000)
);

let _ProcessedEvent = null;

function ProcessedEvent() {
  if (!_ProcessedEvent) {
    _ProcessedEvent = require("../../models/ProcessedEvent")(getTxConn());
  }
  return _ProcessedEvent;
}

/**
 * ⚠️ Résolution DÉLÉGUÉE : sept noms de variable désignaient le principal dans
 * ce service, chaque appelant lisant sa propre sous-liste. Voir
 * `utils/principalEndpoint.js`.
 */

async function livrer(charge) {
  const base = basePrincipal();
  const jeton = jetonPrincipal();

  /**
   * ⚠️ ON LÈVE PLUTÔT QUE DE RENDRE UN ÉCHEC SILENCIEUX.
   *
   * Sans cible ni jeton, le cadre de consommation n'acquitte pas et Redis
   * relivrera : la notification part dès que la configuration est corrigée.
   * Rendre « ok » ici ferait acquitter des messages jamais livrés — perdus
   * définitivement, et sans trace côté appelant.
   */
  if (!base) {
    throw Object.assign(new Error("PRINCIPAL_URL_MISSING"), {
      code: "PRINCIPAL_URL_MISSING",
    });
  }

  if (!jeton) {
    throw Object.assign(new Error("PRINCIPAL_INTERNAL_TOKEN_MISSING"), {
      code: "PRINCIPAL_INTERNAL_TOKEN_MISSING",
    });
  }

  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), DELAI_MS);

  try {
    const reponse = await fetch(`${base}/api/v1/internal/notifications/enqueue`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-token": jeton,
      },
      /**
       * ⚠️ CE CORPS EST UN RELAIS, PAS UNE DÉCISION.
       *
       * Deux champs ont disparu de ce relais, et leur disparition est le
       * correctif :
       *
       * 1. `channels` N'EST PLUS FORCÉ À `["push"]`. Il était posé en dur quand
       *    le producteur n'en envoyait pas — donc un e-mail demandé par le
       *    catalogue ne partait jamais par ce chemin. Le champ n'est transmis
       *    QUE si le producteur l'a explicitement rempli : côté backend,
       *    `channels` absent signifie « ceux du catalogue », alors que
       *    `channels: ['push']` est une RESTRICTION qui coupe l'e-mail.
       *
       * 2. `meta` EST DÉSORMAIS TRANSMIS. Il ne l'était pas : le producteur le
       *    plaçait dans `data.meta`, la route interne lisait `corps.meta`, et
       *    la valeur n'arrivait donc jamais. Comme c'est `meta.category ===
       *    'transaction'` qui fait choisir le gabarit e-mail transactionnel,
       *    **l'e-mail de confirmation de virement partait habillé en message
       *    générique** — sans tableau montant/frais/total, sans date au fuseau
       *    du destinataire. Rien ne le signalait.
       *
       * `variables` est ajouté : ce sont les valeurs des `{{variables}}` des
       * gabarits. Le backend leur applique une liste blanche par type
       * (`template.render()`), donc rien d'autre que les variables déclarées
       * n'atteint le message.
       */
      body: JSON.stringify({
        recipient: charge.recipient,
        type: charge.notificationType || charge.legacyType || "",
        title: charge.title || "",
        message: charge.message || "",
        ...(Array.isArray(charge.channels) && charge.channels.length
          ? { channels: charge.channels }
          : {}),
        priority: charge.priority,
        idempotencyKey: charge.idempotencyKey,
        aggregateType: charge.aggregateType || "transaction",
        aggregateId: charge.aggregateId || "",
        variables: charge.variables || {},
        meta: charge.meta || {},
        data: charge.data || {},
      }),
      signal: controleur.signal,
    });

    if (!reponse.ok) {
      /**
       * Un 4xx ne se rejoue pas : la demande est malformée ou refusée sur le
       * fond, la répéter donnerait le même résultat. On l'étiquette permanent
       * pour éviter cinq tentatives inutiles qui retarderaient les suivantes.
       */
      const permanent = reponse.status >= 400 && reponse.status < 500;

      throw Object.assign(new Error(`PRINCIPAL_HTTP_${reponse.status}`), {
        code: `PRINCIPAL_HTTP_${reponse.status}`,
        permanent,
      });
    }

    return true;
  } finally {
    clearTimeout(minuteur);
  }
}

async function marquerTraite(message, outcome) {
  await ProcessedEvent().create({
    group: GROUPE,
    eventId: message.eventId,
    eventName: message.name,
    processedAt: new Date(),
    outcome,
  });
}

async function handler(message) {
  const charge = message?.payload || {};

  try {
    await livrer(charge);
  } catch (err) {
    if (err?.permanent) {
      logger.error("[notifications] refus DÉFINITIF du principal", {
        recipient: String(charge.recipient || ""),
        idempotencyKey: String(charge.idempotencyKey || ""),
        code: err?.code,
        consequence: "cette notification ne sera jamais affichée ni envoyée",
      });

      await marquerTraite(message, `refus-permanent:${err?.code || "?"}`);
      return;
    }

    throw err;
  }

  await marquerTraite(message, "livre");
}

async function dejaTraite(eventId) {
  if (!eventId) return false;

  const trouve = await ProcessedEvent()
    .findOne({ group: GROUPE, eventId: String(eventId) })
    .select({ _id: 1 })
    .lean();

  return Boolean(trouve);
}

async function onDeadLetter(message, err) {
  /**
   * Une notification perdue n'est pas un défaut financier — mais c'est un
   * utilisateur qui ne saura pas que son argent est arrivé. Le journal porte de
   * quoi la retrouver ; son contenu, lui, n'y figure pas (règle B.4).
   */
  logger.error("[notifications] notification NON LIVRÉE — lettre morte", {
    eventId: message?.eventId,
    recipient: String(message?.payload?.recipient || ""),
    idempotencyKey: String(message?.payload?.idempotencyKey || ""),
    message: err?.message,
    consequence:
      "l'utilisateur ne sera pas prévenu ; l'événement reste consultable dans " +
      "domain_events par son eventId",
  });

  try {
    await marquerTraite(message, "lettre-morte");
  } catch {
    /** L'essentiel est déjà journalisé. */
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

function annoncer(journal = logger) {
  const base = basePrincipal();

  if (!base) {
    journal.error?.(
      "❌ PRINCIPAL_URL absente — CONSÉQUENCE : aucune notification ne sera " +
        "livrée. Les événements restent dans `domain_events` et repartiront " +
        "une fois la variable renseignée ; rien n'est perdu."
    );

    return;
  }

  journal.info?.(
    `✅ Notifications sur le bus — ${EVENEMENTS.join(", ")} → ` +
      `${base}/api/v1/internal/notifications/enqueue (délai ${DELAI_MS} ms).`
  );
}

module.exports = {
  GROUPE,
  EVENEMENTS,
  handler,
  dejaTraite,
  build,
  annoncer,
  livrer,
};
