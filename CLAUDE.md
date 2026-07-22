# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Les explications, commentaires et messages d'erreur de ce dépôt sont en **français** (convention `.claude/memory/conventions.md`). Le code reste en anglais.

## Vue d'ensemble

`paynoval-transactions-service` (« TX Core ») est le micro-service financier de PayNoval : il détient les soldes, le grand livre et la machine à états des transactions. Node 20, CommonJS, Express 4, Mongoose 7. **Pas de TypeScript, pas d'étape de build, pas de tests ni de linter configurés.**

Il n'héberge **pas** le back-office admin (qui reste dans le backend principal) : il expose des routes utilisateur protégées par JWT et des routes `/internal/*` protégées par token interne, appelées par le backend principal et l'API Gateway.

## Commandes

```bash
npm install
npm run dev      # nodemon src/server.js
npm start        # node src/server.js

node scripts/seedBalance.js              # solde de test (utilise MONGO_URI_USERS)
node scripts/seedAppleReviewerWallet.js  # wallet du compte sandbox Apple Review
```

Aucun `npm test` / `npm run lint` n'existe — ne pas en inventer. La vérification se fait par démarrage du service et appels HTTP (`/health`, `/api/v1/health`), ou par `node -e "require('./src/...')"` pour valider qu'un module charge.

Surfaces utiles au runtime : `/docs` (Swagger, protégé par JWT + rôle admin/developer/superadmin en production), `/openapi.yaml`, `/openapi.json`.

## Configuration

- Le module de config est le **fichier** [src/config.js](src/config.js) — attention, un **dossier** [src/config/](src/config/) existe aussi (`db.js`, `cancellationFees.js`) ; `require("./config")` résout vers le fichier, pas vers le dossier.
- `dotenv-safe` valide `.env` **contre `.env.example`** (dev uniquement ; en production les variables viennent de la plateforme). Ajouter une variable requise implique de l'ajouter à [.env.example](.env.example), sinon le démarrage dev casse.
- `.env.example` est **incomplet** par rapport aux variables réellement lues. Pour la liste réelle : `grep -roE "process\.env\.[A-Z0-9_]+" src | sort -u`. Familles importantes :
  - trésoreries : `FEES_TREASURY_USER_ID`, `FX_MARGIN_TREASURY_USER_ID`, `REFERRAL_TREASURY_USER_ID`, `OPERATIONS_TREASURY_USER_ID`, `CAGNOTTE_FEES_TREASURY_USER_ID` ;
  - tokens internes : `GATEWAY_INTERNAL_TOKEN`, `PRINCIPAL_INTERNAL_TOKEN`, `TX_CORE_INTERNAL_TOKEN`, `INTERNAL_TOKEN` (legacy, fallback partout) ;
  - providers : `WAVE_*`, `ORANGE_*`, `MTN_*`, `MOOV_*`, `STRIPE_*`, `VISA_DIRECT_*`, `BANK_GENERIC_*` (chacun avec `_BASE_URL`, `_API_KEY`, `_WEBHOOK_SECRET`, `_MOCK`) ;
  - worker : `TX_AUTO_CANCEL_WORKER`, `TX_AUTO_CANCEL_INTERVAL_MS`, `TX_AUTO_CANCEL_AFTER_DAYS`, `TX_AUTO_CANCEL_REQUIRED`.
- `<PROVIDER>_MOCK=true` fait tourner un adapter sans appel réseau réel — c'est le mode de développement local.

## Les deux bases MongoDB (point le plus structurant)

[src/config/db.js](src/config/db.js) ouvre **deux connexions distinctes** :

| Connexion | Obtenue par | Modèles enregistrés |
|---|---|---|
| Users (connexion mongoose par défaut) | `getUsersConn()` | `User`, `Device` |
| Transactions (`mongoose.createConnection`) | `getTxConn()` | `Transaction`, `Outbox`, `Notification`, `LedgerEntry`, `TxWalletBalance`, `TxSystemBalance` |

**Tous les modèles sont des factories** : `module.exports = (conn) => conn.models.X || conn.model("X", schema)`. Il ne faut jamais faire `require("../models/Transaction").findOne(...)` — toujours `require("../models/Transaction")(conn)` avec la **bonne** connexion. `User` est enregistré sur les deux connexions ; la source de vérité profil (`country`, `accountStatus`, `isBlocked`, `isSystem`…) est la base **Users**.

[src/services/transactions/shared/runtime.js](src/services/transactions/shared/runtime.js) est l'accès canonique : un objet à getters paresseux qui expose modèles, connexions, helpers ledger et helpers de session. **Utiliser `runtime` plutôt que de résoudre les modèles à la main** dans les handlers de transaction.

Conséquence sur les sessions Mongo : `runtime.canUseSharedSession()` n'est vrai que si les deux connexions partagent le même client Mongo. Les handlers utilisent donc `startTxSession()` / `maybeSessionOpts(session)` / `safeCommit` / `safeAbort`, qui deviennent des no-op quand la session multi-documents n'est pas possible. Ne pas remplacer par `session.withTransaction()` inconditionnel.

## Chaîne de traitement d'une transaction

```
routes/*.js  →  controllers/transactionsController.js  →  services/transactions/handlers/*  →  services/ledgerService.js  →  models/*
```

- Les **routes** ([src/routes/transactionsRoutes.js](src/routes/transactionsRoutes.js)) portent : rate limit, middlewares de normalisation du payload (`normalizeProviderRails`, `normalizeInitiateBody`), validateurs `express-validator`, puis `requestValidator`, `requireTransactionEligibility`, `amlMiddleware`.
- Le **contrôleur** [src/controllers/transactionsController.js](src/controllers/transactionsController.js) ne contient aucune logique : il ré-exporte les handlers via `wrapController()` (log entrée/sortie + `next(err)`).
- Les **handlers** dans [src/services/transactions/handlers/](src/services/transactions/handlers/) contiennent toute la logique métier. `initiateByFlow` est l'aiguilleur : sandbox → interne (`initiateInternal`) → externe sortant/entrant (`initiateExternalTransactions`), selon `funds` / `destination` / `provider` / `method`.

### Flows et rails

`flow` (voir `FLOWS` dans [src/models/Transaction.js](src/models/Transaction.js)) est l'axe principal : `PAYNOVAL_INTERNAL_TRANSFER`, `*_COLLECTION_TO_PAYNOVAL` / `*_TO_PAYNOVAL` (entrant), `PAYNOVAL_TO_*_PAYOUT` (sortant). Le schéma en dérive les champs obligatoires (`sender` requis pour interne + payout, `receiver` pour interne + collecte) et la nécessité d'un challenge de sécurité.

### Machine à états

[src/services/transactionStateMachine.js](src/services/transactionStateMachine.js) est la seule autorité sur les transitions (`assertTransition(from, to)`). Toute nouvelle transition passe par ce fichier — ne pas écrire `tx.status = ...` sans vérifier la transition.

### Mouvement d'argent et idempotence

Le cycle est **réserver → capturer → créditer** et chaque étape est protégée par un booléen persistant sur la transaction : `fundsReserved`, `fundsCaptured`, `beneficiaryCredited`, `treasuryRevenueCredited`, `reserveReleased` (+ leurs `*At`). Les handlers testent systématiquement `if (!tx.fundsCaptured) { … }` afin qu'un rejeu ne double pas l'opération. **Conserver ce motif** dans tout nouveau code de règlement.

Les primitives sont dans [src/services/ledgerService.js](src/services/ledgerService.js) : `reserveSenderFunds`, `captureSenderReserve`, `releaseSenderReserve`, `creditReceiverFunds`, `debitReceiverFunds`, `refundSenderFunds`, `creditTreasuryRevenue`, `chargeCancellationFee`, `createLedgerEntry`. Les statics wallet (`reserve`, `captureReserve`, `releaseReserve`, `credit`, `debit`, `cancelReservedWithFee`) vivent sur [src/models/TxWalletBalance.js](src/models/TxWalletBalance.js) (collection `tx_wallet_balances`, unique `{user, currency}`, `optimisticConcurrency`).

Idempotence côté requête : `utils/idempotency.js` + index uniques partiels `{sender, idempotencyKey}` et `{userId, idempotencyKey}` sur `Transaction`.

### Montants

Tous les montants sont des `Decimal128` en base, arrondis via `roundMoney(value, currency)` ([src/services/pricingSnapshotNormalizer.js](src/services/pricingSnapshotNormalizer.js)) et reconvertis en `Number` par le `toJSON` de `Transaction` (qui supprime aussi `securityCode`, `securityAnswerHash`, `verificationToken`, `attemptCount`, `lockedUntil`). Le prix appliqué est figé dans `pricingSnapshot` / `feeSnapshot` / `money` au moment de l'initiation — la confirmation **relit** ce snapshot au lieu de recalculer.

### Ledger et trésorerie

Double écriture dans `LedgerEntry` avec des `accountId` conventionnels : `user_wallet:<userId>:<CUR>` et `treasury:<SYSTEM_TYPE>:<userId>:<CUR>`. Les types de trésorerie autorisés sont fermés (`TREASURY_SYSTEM_TYPES`) et chacun résout son user id depuis une variable d'environnement. Revenus de frais → `FEES_TREASURY`, marge de change → `FX_MARGIN_TREASURY`.

## Providers externes et webhooks

- Adapters bas niveau par rail dans [src/providers/](src/providers/) (mobilemoney : wave/orange/mtn/moov ; card : stripe/visa direct ; bank : générique). Chaque adapter normalise le statut provider vers `completed | processing | failed | cancelled | pending`.
- Au-dessus : `services/transactions/providers/` — `providerExecutorRegistry.resolveExecutor({flow, provider})` choisit l'executor, et **retourne `null` pour tout flow/provider sandbox** (garde-fou secondaire).
- Webhooks entrants : `POST /webhooks/providers/:rail/:provider` → [src/controllers/providerWebhookController.js](src/controllers/providerWebhookController.js). La signature est vérifiée par `verifyHmacWebhook()` ([shared/webhookSecurity.js](src/services/transactions/shared/webhookSecurity.js)) : HMAC sur `rawBody` ou `${timestamp}.${rawBody}`, comparaison timing-safe, fenêtre de fraîcheur. Si aucun secret n'est configuré, la vérification est **désactivée** (`verified: true`) — attention en production.
- **Ordre de montage critique** dans [src/server.js](src/server.js) : `/webhooks/providers` est monté **avant** `mountSanitizers()` (`express-mongo-sanitize`, `xss-clean`, `hpp`) pour préserver la charge utile ; `express.json({ verify })` alimente `req.rawBody`, indispensable au HMAC. Ne pas déplacer ces appels.

## Authentification — trois mécanismes coexistants

1. **JWT utilisateur** — `protect` ([src/middleware/authMiddleware.js](src/middleware/authMiddleware.js)) : HS256 via `JWT_SECRET`, ou RS256 via `JWKS_URI` si défini ; multi-audience. Rôles via `requireRole` ([middleware/requireRole.js](src/middleware/requireRole.js), signature `requireRole(['admin'])`) — noter le doublon `middleware/authz.js` qui exporte `{ requireRole }` et est utilisé par `server.js` pour `/docs`.
2. **Token interne** — en-tête `x-internal-token` (ou `x-paynoval-internal-token`), comparaison timing-safe. Trois implémentations coexistent : `middleware/internalAuth.js` (`requireInternalAuth('gateway'|'principal'|'any')`), `middleware/onlyGateway.js`, et des fonctions locales dans `routes/cagnotte*Routes.js` et `routes/internalAdminTransactions.routes.js`. Chacune a sa propre chaîne de fallback de variables d'environnement — vérifier laquelle s'applique avant d'ajouter une route interne.
3. **Éligibilité métier** — `requireTransactionEligibility` (email/téléphone vérifiés, KYC/KYB, statut du compte, rechargement du profil frais depuis la base Users) puis `amlMiddleware` (blacklist [src/aml/blacklist.json](src/aml/blacklist.json), limites, sanctions, alerte fraude). Ces deux middlewares s'appliquent à `/initiate` et `/confirm`, **pas** à `/cancel` (un compte bloqué doit pouvoir libérer ses fonds).

## Sandbox / Apple Review

Un chemin parallèle complet existe pour le compte de revue Apple : `utils/sandboxUser.js` (détection), `services/sandboxTransaction.service.js` (simulation), `utils/sandboxProviderGuard.js`. L'interception se fait **en tête de `initiateByFlow`** et via `isSandboxTx(tx)` dans `confirmTransaction`, avant tout appel provider réel et tout crédit d'un vrai bénéficiaire. Toute nouvelle route financière doit préserver cette interception.

## Worker auto-cancel

[src/services/transactionAutoCancelService.js](src/services/transactionAutoCancelService.js) démarre dans `bootstrap()` après la connexion DB. Il annule les transactions non confirmées passé `TX_AUTO_CANCEL_AFTER_DAYS`, avec verrou distribué (`autoCancelLockAt` + `autoCancelWorkerId` + TTL) pour supporter plusieurs instances. Désactivable via `TX_AUTO_CANCEL_WORKER=false` ; par défaut un échec de démarrage du worker fait échouer le boot (`TX_AUTO_CANCEL_REQUIRED`). Il est arrêté proprement dans le handler `SIGTERM`/`SIGINT`.

## Conventions et pièges du dépôt

- **Blocs hérités commentés** : une dizaine de fichiers commencent par une ancienne version intégralement commentée, la version vivante étant plus bas (`server.js` : ~650 lignes ; `routes/transactionsRoutes.js` : le code réel commence ligne ~740 ; aussi `handlers/initiateByFlow.js`, `handlers/cancelTransaction.js`, `handlers/submitExternalExecution.js`, `providers/providerExecutorRegistry.js`, `models/User.js`, `models/LedgerEntry.js`, `controllers/providerWebhook*`, `controllers/cagnotte*`). **Toujours vérifier qu'on édite le bloc actif**, et ne pas supprimer ces blocs sans demande explicite.
- **Format de réponse** : succès `{ success: true, ... }` ; erreur produite par [src/middleware/errorHandler.js](src/middleware/errorHandler.js) → `{ success, status, message }` (+ `errors` pour la validation, `stack` hors production). Les erreurs métier se lèvent avec `http-errors` (`createError(409, "…")`), jamais en renvoyant un 200.
- **Deux loggers winston** : [src/logger.js](src/logger.js) (nommé, niveau/fichiers configurables, utilisé par `server.js`) et [src/utils/logger.js](src/utils/logger.js) (minimal, utilisé par `errorHandler` et les modèles). Suivre celui déjà importé dans le fichier édité.
- **Code mort connu** : `src/services/balance.js` n'est référencé nulle part et appellerait une factory de modèle comme un modèle (il lèverait au premier appel) — ne pas s'en inspirer ; l'équivalent vivant est `TxWalletBalance` + `ledgerService`.
- **Bypass de rate limit** : le `sensitiveLimiter` de `routes/transactionsRoutes.js` saute la limite dès que l'en-tête `x-internal-token` est **présent**, sans comparer sa valeur (contrairement à `server.js` qui compare en timing-safe). En tenir compte avant de s'appuyer sur ce limiteur.
- **Git** : l'historique utilise des messages du type `api paynoval file update vNN---`. Les standards du dépôt (`.claude/docs/coding-standards.md`) demandent des commits conventionnels (`feat(scope): …`) — préférer ces derniers pour les nouveaux commits.
- Les documents de `.claude/docs/` et `.claude/memory/` sont des gabarits largement génériques (l'un décrit même un autre projet) : ce fichier CLAUDE.md fait foi pour l'architecture réelle. Les **skills** de `.claude/skills/` (`create-api-skill`, `create-service-skill`, `create-model-skill`, `debug-skill`, `security-review-skill`…) sont en revanche opérationnelles et doivent être utilisées pour les tâches correspondantes.
