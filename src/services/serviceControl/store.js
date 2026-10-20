"use strict";

/**
 * ============================================================================
 * SERVICE CONTROL — IN-PROCESS STATE (pure orchestration, injected I/O)
 * ============================================================================
 *
 * Contract: docs/architecture/service-control.md §7.
 *
 * ⚠️ Same file in `api-paynoval/src/services/serviceControl/store.js` — the
 * loaders are injected, so the two copies stay identical.
 *
 * Every request reads the state from memory: no database round trip on the
 * hot path. At most every `ttlMs` (5 s), ONE background refresh reads the
 * tiny `revision` document and reloads everything only if it changed. Every
 * instance therefore applies a change within ~5 s, with one indexed read per
 * 5 s per process — not per request.
 *
 * Failure handling (decision of 2026-10-17):
 *   · read failure ≤ `lkgMaxMs` (5 min): the last known state applies as is;
 *   · beyond, or never read: status `unavailable` — the caller closes money
 *     operations and keeps the rest open;
 *   · an EMERGENCY_LOCKDOWN known before the failure stays applied forever
 *     (`stickyRules` in policy.js): a read failure never lifts it.
 */

const DEFAULT_TTL_MS = 5000;
const DEFAULT_LKG_MAX_MS = 5 * 60 * 1000;

function readPositiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * @param {object} deps
 * @param {() => Promise<number>} deps.loadRevision   cheap: the revision counter
 * @param {() => Promise<object>} deps.loadSnapshot   full state (states, windows, bypasses, versionPolicies)
 * @param {() => number} [deps.now]
 * @param {number} [deps.ttlMs]
 * @param {number} [deps.lkgMaxMs]
 * @param {object} [deps.logger]
 */
function createServiceControlStore(deps) {
  const loadRevision = deps.loadRevision;
  const loadSnapshot = deps.loadSnapshot;
  const now = deps.now || (() => Date.now());
  const ttlMs = readPositiveInt(deps.ttlMs, DEFAULT_TTL_MS);
  const lkgMaxMs = readPositiveInt(deps.lkgMaxMs, DEFAULT_LKG_MAX_MS);
  const logger = deps.logger || console;

  let snapshot = null;
  let revision = null;
  let lastCheckAt = 0;
  let lastSuccessAt = 0;
  let lastError = null;
  let inflight = null;
  let unavailableLogged = false;

  async function doRefresh(force) {
    try {
      const rev = Number(await loadRevision());
      const changed = force || snapshot === null || !Number.isFinite(rev) || rev !== revision;

      if (changed) {
        const next = await loadSnapshot();
        snapshot = { ...next, revision: Number.isFinite(rev) ? rev : next.revision ?? null, loadedAt: now() };
        revision = snapshot.revision;
      }

      lastSuccessAt = now();
      lastError = null;

      if (unavailableLogged) {
        unavailableLogged = false;
        logger.info?.("[service-control] état de nouveau lisible", { revision });
      }
    } catch (err) {
      lastError = err;

      const age = lastSuccessAt ? now() - lastSuccessAt : Infinity;

      if (age > lkgMaxMs && !unavailableLogged) {
        unavailableLogged = true;
        logger.error?.(
          "[service-control] état ILLISIBLE au-delà de la durée de grâce — opérations d'argent REFUSÉES " +
            "(SERVICE_STATUS_UNAVAILABLE), lecture et connexion ouvertes ; un verrouillage d'urgence connu reste appliqué",
          { message: err && err.message, lkgMaxMs }
        );
      } else if (!unavailableLogged) {
        logger.warn?.("[service-control] lecture de l'état échouée — dernier état connu appliqué", {
          message: err && err.message,
        });
      }
    } finally {
      lastCheckAt = now();
      inflight = null;
    }
  }

  function refresh({ force = false } = {}) {
    if (!inflight) inflight = doRefresh(force);
    return inflight;
  }

  function status() {
    if (!snapshot || !lastSuccessAt) return "unavailable";
    const age = now() - lastSuccessAt;
    if (age > lkgMaxMs) return "unavailable";
    return lastError ? "stale" : "fresh";
  }

  /**
   * Synchronous read for the hot path. Triggers a background refresh when the
   * cache is older than `ttlMs`; never waits for it.
   */
  function get() {
    if (now() - lastCheckAt >= ttlMs) refresh().catch(() => {});

    return {
      status: status(),
      snapshot,
      revision,
      ageMs: lastSuccessAt ? now() - lastSuccessAt : null,
    };
  }

  /**
   * Waits for the first load (boot), bounded: a request arriving in the very
   * first second must not be refused "status unavailable" only because the
   * process just started.
   */
  async function ready(timeoutMs = 1500) {
    if (snapshot) return get();

    const pending = refresh();
    let timer = null;

    await Promise.race([
      pending,
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        if (timer && typeof timer.unref === "function") timer.unref();
      }),
    ]);

    if (timer) clearTimeout(timer);
    return get();
  }

  /** After a local write: the next read reloads immediately. */
  function invalidate() {
    lastCheckAt = 0;
    revision = null;
  }

  return { get, ready, refresh, invalidate, status, config: { ttlMs, lkgMaxMs } };
}

module.exports = { createServiceControlStore, DEFAULT_TTL_MS, DEFAULT_LKG_MAX_MS };
