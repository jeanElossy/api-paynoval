"use strict";

/**
 * MÉTRIQUES PROMETHEUS
 * =============================================================================
 *
 * ═══ CE QUI EXISTAIT ══════════════════════════════════════════════════════
 *
 * `prom-client` était installé mais jamais chargé, et `routes/ops.routes.js`
 * — jamais monté — renvoyait `app_up 1` **en dur**. Autrement dit : aucune
 * mesure. Impossible de dire si une route est lente, si la file de
 * notifications prend du retard, ou combien de requêtes une instance encaisse.
 *
 * C'est bloquant pour la suite : régler un disjoncteur ou un délai d'expiration
 * demande de connaître les p99 réels. Les deviner, c'est inventer des chiffres.
 *
 * ═══ LE PIÈGE QUI TUE PROMETHEUS : LA CARDINALITÉ ════════════════════════
 *
 * Chaque combinaison distincte d'étiquettes crée une **série temporelle**
 * conservée en mémoire. Étiqueter par URL brute produit une série par
 * identifiant : `/api/v1/users/64f…a1`, `/api/v1/users/64f…a2`, … Sur ce
 * service, cela ferait des centaines de milliers de séries et ferait tomber
 * Prometheus — plus sûrement que l'incident qu'on cherchait à observer.
 *
 * `normalizeRoute` ramène donc chaque requête à son MOTIF (`/api/v1/users/:id`),
 * en privilégiant le motif reconnu par Express, et en repliant sur un
 * remplacement des segments variables quand il n'y en a pas. Un plafond dur
 * (`MAX_ROUTES`) fait basculer tout le surplus sur `other` : même en cas
 * d'erreur de normalisation, la cardinalité reste bornée.
 *
 * ═══ POURQUOI `/metrics` N'EST PAS PUBLIC ════════════════════════════════
 *
 * Une page de métriques divulgue la carte complète du service : noms de routes
 * internes, volumes, taux d'erreur, versions. C'est un plan de reconnaissance
 * offert. Elle est montée derrière la protection interne, comme le reste de
 * `/api/v1/internal`.
 *
 * Module écrit en **injection** : `client` et `registry` sont fournis, donc la
 * normalisation et l'observation se testent sans registre global partagé entre
 * fichiers de tests.
 */

/** Au-delà, tout est replié sur `other`. Borne dure de la cardinalité. */
const MAX_ROUTES = 200;

/**
 * Bornes du histogramme, en secondes.
 *
 * Choisies pour ce service, pas reprises d'un exemple : le p50 attendu est de
 * quelques dizaines de millisecondes, et ce qui intéresse vraiment est la
 * queue — d'où des bornes resserrées en bas et étalées jusqu'à 10 s, la limite
 * au-delà de laquelle un client mobile a de toute façon abandonné.
 */
const DURATION_BUCKETS = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
]);

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const NUMERIC = /^\d+$/;
const LONG_OPAQUE = /^[A-Za-z0-9_-]{20,}$/;

/**
 * Remplace les segments variables d'un chemin par `:id`.
 *
 * Fonction **pure**, et c'est la pièce à tester en priorité : c'est elle qui
 * empêche l'explosion de cardinalité.
 */
function genericizePath(path) {
  const clean = String(path || "/").split("?")[0];

  return (
    "/" +
    clean
      .split("/")
      .filter(Boolean)
      .map((seg) => {
        if (OBJECT_ID.test(seg)) return ":id";
        if (UUID.test(seg)) return ":id";
        if (NUMERIC.test(seg)) return ":id";

        // Jetons, clés d'idempotence, identifiants opaques.
        if (LONG_OPAQUE.test(seg)) return ":id";

        return seg;
      })
      .join("/")
  );
}

/**
 * Motif de route d'une requête.
 *
 * On préfère le motif reconnu par Express (`req.route.path` préfixé de
 * `req.baseUrl`) : c'est la vérité, pas une heuristique. Le repli ne sert que
 * pour les 404 et les requêtes rejetées avant tout routage.
 */
function normalizeRoute(req) {
  try {
    if (req?.route?.path) {
      const base = genericizePath(req.baseUrl || "");
      const own = String(req.route.path);

      const joined = `${base === "/" ? "" : base}${own === "/" ? "" : own}`;
      return joined || "/";
    }
  } catch {}

  return genericizePath(req?.path || req?.originalUrl || "/");
}

/**
 * Construit le jeu de métriques.
 *
 * @param {object} deps
 * @param {object} deps.client  Module `prom-client` (ou un double).
 * @param {object} [deps.registry]
 * @param {boolean} [deps.collectDefault] métriques processus / GC / boucle d’événements.
 */
function createMetrics({ client, registry = null, collectDefault = true } = {}) {
  if (!client) throw new Error("metrics : dépendance `client` manquante");

  const register = registry || new client.Registry();

  if (collectDefault && typeof client.collectDefaultMetrics === "function") {
    /**
     * Ce sont ces métriques-là qui expliquent la plupart des incidents Node :
     * retard de la boucle d'événements, pauses du ramasse-miettes, descripteurs
     * de fichiers. Bien plus utiles que n'importe quel compteur métier.
     */
    client.collectDefaultMetrics({ register });
  }

  const httpDuration = new client.Histogram({
    name: "http_request_duration_seconds",
    help: "Durée des requêtes HTTP, par motif de route",
    labelNames: ["method", "route", "status"],
    buckets: DURATION_BUCKETS,
    registers: [register],
  });

  const httpInFlight = new client.Gauge({
    name: "http_requests_in_flight",
    help: "Requêtes HTTP en cours de traitement",
    registers: [register],
  });

  /** Motifs déjà vus. Sert uniquement à faire respecter le plafond. */
  const seenRoutes = new Set();

  function boundRoute(route) {
    if (seenRoutes.has(route)) return route;

    if (seenRoutes.size >= MAX_ROUTES) return "other";

    seenRoutes.add(route);
    return route;
  }

  /**
   * Intergiciel de mesure. À monter TÔT — il doit englober le temps passé dans
   * les autres intergiciels, pas seulement dans le contrôleur.
   */
  function httpMiddleware(req, res, next) {
    const started = process.hrtime.bigint();
    httpInFlight.inc();

    let done = false;

    const finish = () => {
      if (done) return;
      done = true;

      httpInFlight.dec();

      try {
        const seconds = Number(process.hrtime.bigint() - started) / 1e9;

        httpDuration.observe(
          {
            method: req.method,
            route: boundRoute(normalizeRoute(req)),
            status: String(res.statusCode),
          },
          seconds
        );
      } catch {
        // Une métrique ne doit jamais faire échouer une requête.
      }
    };

    /**
     * `close` en plus de `finish` : une requête abandonnée par le client
     * n'émet pas `finish`. Sans lui, `http_requests_in_flight` ne redescend
     * jamais et dérive vers l'infini — la fuite classique de ce compteur.
     */
    res.once("finish", finish);
    res.once("close", finish);

    next();
  }

  /**
   * Enregistre une jauge dont la valeur est lue au moment de la collecte.
   *
   * `collect` peut être asynchrone : c'est ce qui permet d'exposer la
   * profondeur de la file de notifications sans la sonder en permanence — elle
   * n'est lue qu'à chaque scrutation, toutes les quinze ou trente secondes.
   */
  function registerAsyncGauge({ name, help, labelNames = [], collect }) {
    return new client.Gauge({
      name,
      help,
      labelNames,
      registers: [register],
      async collect() {
        try {
          await collect(this);
        } catch {
          // Une source indisponible ne doit pas casser toute la page.
        }
      },
    });
  }

  return {
    register,
    httpMiddleware,
    registerAsyncGauge,
    normalizeRoute,
    contentType: register.contentType,
    metrics: () => register.metrics(),

    /** Diagnostic : combien de motifs distincts ont été vus. */
    __routeCount: () => seenRoutes.size,
  };
}

module.exports = {
  createMetrics,
  normalizeRoute,
  genericizePath,
  MAX_ROUTES,
  DURATION_BUCKETS,
};
