"use strict";

/**
 * ============================================================================
 * TRANSPORT — REDIS STREAMS, ET POURQUOI PAS PUB/SUB
 * ============================================================================
 *
 * ── Le choix, et ce qu'il exclut ────────────────────────────────────────────
 *
 * Redis expose deux mécanismes de diffusion, et un seul convient ici.
 *
 * `PUBLISH`/`SUBSCRIBE` est du « tire et oublie » : un abonné absent au moment
 * de l'envoi ne reçoit rien, jamais. Un consommateur de conformité redémarré
 * pendant un déploiement perdrait tous les événements de la fenêtre — sans
 * qu'aucune erreur ne soit levée nulle part. C'est le pire mode de perte : il
 * est silencieux et il frappe précisément pendant les opérations.
 *
 * Les FLUX (`XADD`/`XREADGROUP`) sont un journal persistant avec des groupes de
 * consommateurs : chaque groupe a son décalage, chaque message doit être
 * ACQUITTÉ, et ce qui n'est pas acquitté reste réclamable (`XAUTOCLAIM`). Un
 * consommateur qui tombe reprend où il en était.
 *
 * ── L'invariant A1 tient, et voici comment ──────────────────────────────────
 *
 * « Redis n'est jamais la source de vérité financière. » Il ne l'est pas ici :
 * la source est `domain_events`, en base, écrit dans la transaction. Le flux
 * n'est qu'un CANAL DE LIVRAISON dérivé. Une perte totale de Redis se répare en
 * remettant `publishedAt` à `null` sur la fenêtre concernée et en laissant le
 * relais republier — rien n'est perdu, tout est rejouable.
 *
 * ── L'invariant A6 tient aussi ──────────────────────────────────────────────
 *
 * « Toute donnée temporaire en Redis porte un TTL explicite. » Un flux ne
 * s'expire pas par TTL : il se TAILLE. `XADD ... MAXLEN ~ N` borne le journal à
 * N entrées environ. La borne est explicite, configurable, et annoncée au
 * démarrage — c'est l'équivalent d'un TTL pour une structure qui n'en accepte
 * pas.
 *
 * ── Invariant A8 ────────────────────────────────────────────────────────────
 *
 * Aucune connexion n'est créée ici. Le client vient de `redisClientAccessor`,
 * posé une fois par le démarrage. Sans client, ce module rend `null` et le
 * dit — Redis absent est un mode documenté, pas une panne.
 */

const { getClient } = require("../redisClientAccessor");

/** Nom du flux. Un seul flux, plusieurs groupes : c'est le motif Kafka en petit. */
const FLUX = process.env.EVENT_STREAM_KEY || "paynoval.events";

/**
 * Borne du journal, en nombre d'entrées.
 *
 * ⚠️ `~` (approximatif) et non exact : la taille exacte force Redis à tailler
 * entrée par entrée, ce qui coûte cher sur un flux actif. L'approximation
 * tronque par nœuds entiers et garde AU MOINS N entrées — jamais moins, parfois
 * un peu plus. Sur un journal de rejeu, garder un peu trop est sans conséquence.
 */
const TAILLE_MAX = Math.max(
  1000,
  Number(process.env.EVENT_STREAM_MAXLEN || 100000)
);

function clientOuNull() {
  return getClient() || null;
}

function fluxKey() {
  return FLUX;
}

/**
 * Publie une entrée sur le flux.
 *
 * Rend l'identifiant Redis de l'entrée, ou `null` si Redis est absent — auquel
 * cas l'appelant NE DOIT PAS marquer l'événement comme publié.
 */
async function xadd(evenement) {
  const client = clientOuNull();
  if (!client) return null;

  /**
   * ⚠️ Les champs d'un flux sont des CHAÎNES. La charge utile est sérialisée en
   * JSON dans un champ unique plutôt qu'aplatie en paires : aplatir perdrait
   * les types (un montant deviendrait une chaîne) et les objets imbriqués.
   *
   * `eventId` est l'identifiant Mongo de l'événement : c'est LUI que les
   * consommateurs utilisent pour dédoublonner, pas l'identifiant Redis. Un
   * rejeu du relais produit un nouvel identifiant Redis pour le même
   * `eventId` — c'est exactement le cas que la livraison « au moins une fois »
   * impose de gérer.
   */
  return client.xadd(
    FLUX,
    "MAXLEN",
    "~",
    String(TAILLE_MAX),
    "*",
    "eventId",
    String(evenement._id),
    "name",
    String(evenement.name),
    "aggregateType",
    String(evenement.aggregateType || ""),
    "aggregateId",
    String(evenement.aggregateId || ""),
    "occurredAt",
    new Date(evenement.occurredAt || Date.now()).toISOString(),
    "payload",
    JSON.stringify(evenement.payload || {})
  );
}

/**
 * Crée le groupe de consommateurs s'il n'existe pas.
 *
 * ⚠️ `MKSTREAM` est indispensable : sans lui, créer un groupe sur un flux qui
 * n'a jamais reçu d'entrée échoue en `NOGROUP`, et un consommateur démarré
 * avant le premier producteur ne se rattraperait jamais.
 *
 * ⚠️ Le décalage de départ est `0`, PAS `$`. `$` signifie « seulement ce qui
 * arrive après moi » : à la création du groupe, tout l'historique déjà présent
 * dans le flux serait sauté en silence. Pour de la surveillance de conformité,
 * sauter des événements existants est exactement ce qu'il ne faut pas faire.
 */
async function ensureGroup(groupe) {
  const client = clientOuNull();
  if (!client) return false;

  try {
    await client.xgroup("CREATE", FLUX, groupe, "0", "MKSTREAM");
    return true;
  } catch (err) {
    /** `BUSYGROUP` = le groupe existe déjà. C'est le cas nominal au redémarrage. */
    if (String(err?.message || "").includes("BUSYGROUP")) return false;
    throw err;
  }
}

/** Décode une entrée de flux vers la forme que voit un gestionnaire. */
function decoder(entree) {
  const [redisId, champs] = entree;

  const brut = {};
  for (let i = 0; i < champs.length; i += 2) brut[champs[i]] = champs[i + 1];

  let payload = {};

  try {
    payload = JSON.parse(brut.payload || "{}");
  } catch {
    /**
     * Une charge illisible n'est pas ignorée : elle est rendue avec un drapeau,
     * et le cadre de consommation l'enverra en lettre morte. L'ignorer ferait
     * disparaître un événement sans trace (règle B.1).
     */
    return {
      redisId,
      eventId: brut.eventId || "",
      name: brut.name || "",
      corrompu: true,
      payload: {},
    };
  }

  return {
    redisId,
    eventId: brut.eventId || "",
    name: brut.name || "",
    aggregateType: brut.aggregateType || "",
    aggregateId: brut.aggregateId || "",
    occurredAt: brut.occurredAt || "",
    payload,
    corrompu: false,
  };
}

/**
 * Lit les nouveaux messages du groupe.
 *
 * ⚠️ `blockMs: 0` SIGNIFIE « NE BLOQUE PAS », ET C'EST L'INVERSE DE CE QUE
 * REDIS COMPREND.
 *
 * En Redis, `BLOCK 0` veut dire « attends INDÉFINIMENT jusqu'à ce qu'un message
 * arrive ». Le cadre de consommation appelait `readGroup({ blockMs: 0 })` en
 * pensant demander une lecture non bloquante : sur un flux vide, le tour ne
 * rendait jamais la main, le consommateur se figeait, et l'arrêt sur SIGTERM ne
 * se déclenchait pas non plus.
 *
 * Le défaut ne s'est jamais manifesté dans les tests unitaires — ils n'ouvrent
 * aucun Redis — ni dans les premiers essais de bout en bout, où il y avait
 * toujours des messages à lire. Il est apparu au premier tour SUIVANT la
 * consommation, c'est-à-dire au régime nominal.
 *
 * `BLOCK` n'est donc envoyé que si une attente est réellement demandée. Sans
 * lui, `XREADGROUP` rend immédiatement ce qui est disponible, ou rien.
 */
async function readGroup({ groupe, consommateur, count = 32, blockMs = 0 }) {
  const client = clientOuNull();
  if (!client) return [];

  const attente = Number(blockMs) > 0 ? ["BLOCK", String(blockMs)] : [];

  const reponse = await client.xreadgroup(
    "GROUP",
    groupe,
    consommateur,
    "COUNT",
    String(count),
    ...attente,
    "STREAMS",
    FLUX,
    ">"
  );

  if (!reponse || !reponse.length) return [];

  const [, entrees] = reponse[0];
  return entrees.map(decoder);
}

/**
 * Réclame les messages livrés à un consommateur qui ne les a jamais acquittés.
 *
 * C'est ce qui rend le système tolérant à la mort d'un processus : sans
 * réclamation, un message livré à une instance disparue reste « en cours » pour
 * toujours et n'est jamais retraité.
 */
async function autoClaim({ groupe, consommateur, minIdleMs, count = 32 }) {
  const client = clientOuNull();
  if (!client) return { entrees: [], curseur: "0-0" };

  const reponse = await client.xautoclaim(
    FLUX,
    groupe,
    consommateur,
    String(minIdleMs),
    "0-0",
    "COUNT",
    String(count)
  );

  const curseur = reponse?.[0] || "0-0";
  const entrees = (reponse?.[1] || [])
    /** Une entrée taillée entre-temps arrive à `null` : on ne la décode pas. */
    .filter((e) => Array.isArray(e) && e[1])
    .map(decoder);

  return { entrees, curseur };
}

async function ack({ groupe, redisId }) {
  const client = clientOuNull();
  if (!client) return 0;

  return client.xack(FLUX, groupe, redisId);
}

/** Nombre de tentatives de livraison d'un message — sert au seuil de lettre morte. */
async function livraisons({ groupe, redisId }) {
  const client = clientOuNull();
  if (!client) return 0;

  const reponse = await client.xpending(FLUX, groupe, redisId, redisId, 1);

  /** Forme : [[id, consommateur, msInactif, nbLivraisons]] */
  return Number(reponse?.[0]?.[3] || 0);
}

async function longueur() {
  const client = clientOuNull();
  if (!client) return null;

  return client.xlen(FLUX);
}

module.exports = {
  FLUX,
  TAILLE_MAX,
  fluxKey,
  clientOuNull,
  xadd,
  ensureGroup,
  readGroup,
  autoClaim,
  ack,
  livraisons,
  longueur,
  decoder,
};
