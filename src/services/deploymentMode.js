'use strict';

/**
 * MODE DE DÉPLOIEMENT — OÙ TOURNENT LES PROCESSUS DE FOND
 * =============================================================================
 *
 * ⚠️ FICHIER RÉPLIQUÉ À L'IDENTIQUE dans `paynoval-backend/services/` et
 * `api-paynoval/src/services/`. Toute modification se porte dans les deux, dans
 * le même mouvement : `paynoval-backend/tests/replicationGuard.test.js` le
 * vérifie.
 *
 * Logique pure, aucune dépendance.
 *
 * ═══ LE PROBLÈME ═══════════════════════════════════════════════════════════
 *
 * Plusieurs processus de fond peuvent tourner soit DANS le web service, soit
 * dans un service dédié :
 *
 *   Tx-Core  → les quatre consommateurs du bus         EVENT_CONSUMERS_INLINE
 *   Backend  → la file de notifications                 OUTBOX_WORKER_INLINE
 *            → l'ouverture des portefeuilles            WALLET_PROVISIONING_WORKER_INLINE
 *            → les tâches planifiées                    CRON_INLINE
 *
 * Sur un hébergement sans service de fond (Render gratuit), ils DOIVENT tourner
 * dans le web — sinon rien ne tourne : c'est l'incident du 2026-09-23, où aucune
 * notification de transaction n'arrivait. Sur l'hébergement de production (OVH),
 * ils doivent être ISOLÉS : un consommateur qui fuit en mémoire ne doit pas
 * redémarrer le moteur d'argent.
 *
 * Quatre interrupteurs à basculer à la main le jour de la bascule, dans trois
 * services, c'est exactement le genre d'oubli qui a produit l'incident.
 *
 * ═══ LA RÉPONSE : UNE DÉCLARATION, PAS QUATRE ══════════════════════════════
 *
 *   DEPLOYMENT_MODE=single    (défaut) tout tourne dans le web service ;
 *   DEPLOYMENT_MODE=isolated  rien ne tourne dans le web ; les services dédiés
 *                             (`workers:all`, `worker:notifications`, …) portent
 *                             le travail.
 *
 * La variable individuelle, quand elle est posée, a toujours le dernier mot —
 * pour isoler un seul processus, ou pour garder une exception temporaire.
 *
 * ⚠️ LE DÉFAUT RESTE `single`, ET C'EST VOLONTAIRE. Un défaut `isolated`
 * reproduirait l'incident sur tout déploiement qui n'a pas (encore) ses services
 * dédiés. L'isolement doit être DÉCLARÉ ; son absence ne doit jamais produire le
 * silence.
 */

const MODES = Object.freeze({ SINGLE: 'single', ISOLATED: 'isolated' });

const VRAI = new Set(['true', '1', 'yes', 'oui', 'on']);
const FAUX = new Set(['false', '0', 'no', 'non', 'off']);

/**
 * Le mode déclaré.
 *
 * Une valeur non reconnue retombe sur `single` ET se signale : une faute de
 * frappe (`isolate`) ne doit ni couper les processus de fond, ni passer
 * inaperçue.
 *
 * @returns {{mode: string, warning: string|null}}
 */
function deploymentMode(env = process.env) {
  const brut = String(env?.DEPLOYMENT_MODE ?? '').trim().toLowerCase();

  if (!brut || brut === MODES.SINGLE) return { mode: MODES.SINGLE, warning: null };
  if (brut === MODES.ISOLATED) return { mode: MODES.ISOLATED, warning: null };

  return {
    mode: MODES.SINGLE,
    warning:
      `DEPLOYMENT_MODE="${brut}" n'est pas reconnu (attendu : single ou ` +
      `isolated). Repli sur « single » : les processus de fond tournent dans ` +
      `ce web service.`,
  };
}

/**
 * Tel processus de fond doit-il tourner DANS ce processus ?
 *
 * Ordre de décision : la variable individuelle si elle est posée et lisible,
 * sinon le mode de déploiement.
 *
 * @param {string} variable  ex. 'OUTBOX_WORKER_INLINE'
 * @returns {{inline: boolean, source: 'variable'|'mode', mode: string}}
 */
function inlineEnabled(variable, env = process.env) {
  const { mode } = deploymentMode(env);
  const brut = String(env?.[variable] ?? '').trim().toLowerCase();

  if (VRAI.has(brut)) return { inline: true, source: 'variable', mode };
  if (FAUX.has(brut)) return { inline: false, source: 'variable', mode };

  return { inline: mode !== MODES.ISOLATED, source: 'mode', mode };
}

module.exports = { MODES, deploymentMode, inlineEnabled };
