# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Les explications, commentaires et messages d'erreur de ce dépôt sont en **français** (convention `.claude/context/conventions.md`). Le code reste en anglais. Règles de collaboration transverses → [`../CLAUDE.md`](../CLAUDE.md) ; vue d'ensemble de l'écosystème → [`../.claude/context/ecosystem.md`](../.claude/context/ecosystem.md).

## Vue d'ensemble

`paynoval-transactions-service` (« TX Core ») est le micro-service financier de PayNoval : il détient les soldes, le grand livre et la machine à états des transactions. Node 20, CommonJS, Express 4, Mongoose 7. **Pas de TypeScript, pas d'étape de build, pas de linter configuré.**

Il n'héberge **pas** le back-office admin (qui reste dans le backend principal) : il expose des routes utilisateur protégées par JWT et des routes `/internal/*` protégées par token interne, appelées par le backend principal et l'API Gateway.

## Commandes

```bash
npm install
npm run dev      # nodemon src/server.js
npm start        # node src/server.js
npm test         # node --test "test/**/*.test.js" — runner natif, aucune dépendance
node --test test/userScopeQuery.test.js  # un seul fichier

npm run reconcile:transactions           # reconciliation de TOUS les flux (lecture seule)
npm run reconcile:referral               # reconciliation des versements de parrainage
npm run verify:referral-idempotency      # 100 tentatives simultanees -> 1 versement

node scripts/seedBalance.js              # solde de test (utilise MONGO_URI_USERS)
node scripts/seedAppleReviewerWallet.js  # wallet du compte sandbox Apple Review
```

**Une suite de tests existe depuis le 2026-08-18** (elle n'existait pas avant, plusieurs sections de ce fichier le disaient) : runner natif `node:test`, aucune dépendance ajoutée, logique pure uniquement — aucun test ne démarre le service ni n'ouvre de connexion Mongo. **68 tests au 2026-08-19** (28 initiaux + 40 ajoutés : idempotence du parrainage, signature des webhooks, tokens internes, rejeu du commit, exécution transactionnelle, clés d'idempotence de l'API). Le glob est indispensable : `node --test test/` résout `test/` comme un module CommonJS et échoue en `MODULE_NOT_FOUND` sur Node 22.

Contrainte pratique à connaître : `require` d'un contrôleur charge `src/config.js`, donc `dotenv-safe`, qui **échoue sans `.env` complet**. Une logique qu'on veut tester doit donc vivre dans un module sans dépendance de configuration (cf. [src/utils/userScopeQuery.js](src/utils/userScopeQuery.js), extrait du contrôleur exactement pour cette raison). Le reste se vérifie par démarrage du service et appels HTTP (`/health`, `/api/v1/health`).

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
- Deux variables **optionnelles** introduites le 2026-08-19, volontairement **absentes de `.env.example`** (les y mettre les rendrait obligatoires et casserait le démarrage) :
  - `MONGO_SHARE_CLIENT=off` — rétablit deux `MongoClient` distincts, donc l'ancien mode sans transaction. Bascule de secours.
  - `WEBHOOK_ALLOW_UNSIGNED=true` — accepte les webhooks non signés **hors production uniquement**. Sans elle, un webhook sans secret configuré est refusé (voir ci-dessous).

## Les deux bases MongoDB (point le plus structurant)

[src/config/db.js](src/config/db.js) ouvre **deux connexions** :

| Connexion | Obtenue par | Modèles enregistrés |
|---|---|---|
| Users (connexion mongoose par défaut) | `getUsersConn()` | `User`, `Device` |
| Transactions | `getTxConn()` | `Transaction`, `Outbox`, `Notification`, `LedgerEntry`, `TxWalletBalance`, `TxSystemBalance`, `ReferralPayout` |

**Depuis le 2026-08-19, les deux connexions partagent le même `MongoClient`** quand les
deux URI ne diffèrent que par le nom de la base (même serveur, mêmes identifiants, mêmes
options) : la connexion transactions est alors obtenue par `usersConn.useDb(...)` et non
plus par `mongoose.createConnection()`. C'est la condition pour qu'une transaction Mongo
couvre les deux bases.

Auparavant, deux clients distincts étaient toujours ouverts, donc
`runtime.canUseSharedSession()` renvoyait **toujours `false`** et **tout le mouvement
d'argent tournait sans transaction**, silencieusement. Deux clusters distincts, ou deux
comptes aux droits différents, retombent sur l'ancien comportement. `MONGO_SHARE_CLIENT=off`
le restaure sans redéploiement. Le régime effectif est journalisé au démarrage
(« Transactions Mongo ACTIVES / INACTIVES ») — il ne faut plus le deviner.

**Tous les modèles sont des factories** : `module.exports = (conn) => conn.models.X || conn.model("X", schema)`. Il ne faut jamais faire `require("../models/Transaction").findOne(...)` — toujours `require("../models/Transaction")(conn)` avec la **bonne** connexion. `User` est enregistré sur les deux connexions ; la source de vérité profil (`country`, `accountStatus`, `isBlocked`, `isSystem`…) est la base **Users**.

[src/services/transactions/shared/runtime.js](src/services/transactions/shared/runtime.js) est l'accès canonique : un objet à getters paresseux qui expose modèles, connexions, helpers ledger et helpers de session. **Utiliser `runtime` plutôt que de résoudre les modèles à la main** dans les handlers de transaction.

Conséquence sur les sessions Mongo : `runtime.canUseSharedSession()` n'est vrai que si les deux connexions partagent le même client Mongo. Les handlers utilisent donc `startTxSession()` / `maybeSessionOpts(session)` / `safeCommit` / `safeAbort`, qui deviennent des no-op quand la session multi-documents n'est pas possible. Ne pas remplacer par `session.withTransaction()` inconditionnel.

**Le commit ne s'appelle jamais en direct.** Les 22 appels à `session.commitTransaction()` ont été migrés le 2026-08-19 vers `safeCommit(session)` (dans `runtime`) ou `commitWithRetry(session)` ([src/utils/commitWithRetry.js](src/utils/commitWithRetry.js), module pur, sans dépendance, utilisable depuis les contrôleurs qui ne peuvent pas charger `runtime` — celui-ci touche `getTxConn()` au chargement). Le rejeu applique la règle du pilote : sur `UnknownTransactionCommitResult`, on rejoue le commit dans une fenêtre de 120 s, exactement ce que fait `withTransaction()` en interne. Ce signal ne veut pas dire « échec » mais « je ne sais pas » : abandonner dessus revient à déclarer perdue une opération peut-être réussie. **Aucun nouveau code ne doit appeler `commitTransaction()` directement.**

⚠️ **Dette restante, assumée.** 14 chemins ouvrent une transaction sans rejouer l'**opération entière** sur `TransientTransactionError` (conflit d'écriture). Le remède standard est `session.withTransaction()`, mais il ne peut pas être appliqué mécaniquement ici : plusieurs de ces blocs contiennent des `return res.json(...)` **à l'intérieur** du périmètre transactionnel, et un rejeu enverrait deux réponses HTTP. La migration suppose donc d'abord de sortir l'envoi de la réponse du bloc — chantier à part, avec passage en préproduction.

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

### Idempotence de l'API (motif Stripe) — depuis le 2026-08-19

`middleware/idempotency.js` est posé sur `/initiate`, `/confirm`, `/cancel` et `/refund`, juste après `protect`. Quatre situations, quatre réponses :

| Situation | Réponse |
|---|---|
| clé inconnue | on exécute, et on fige la réponse |
| clé connue, même requête, terminée | **la réponse d'origine**, à l'identique, avec l'en-tête `Idempotency-Replayed: true` |
| clé connue, requête différente | `400` — rendre la réponse d'un virement à un autre serait mentir |
| clé connue, traitement en cours | `409` |

Les réponses **5xx ne sont pas figées** : une panne n'est pas un résultat, la clé est libérée pour que le rejeu reparte proprement. Les **4xx le sont** : un refus pour solde insuffisant est stable.

Le registre est `models/IdempotencyRecord.js` (collection `idempotency_records`, unique `{scope, key}`, TTL 24 h comme Stripe). La portée isole par utilisateur ET par endpoint. L'empreinte de requête utilise une sérialisation **stable** (clés triées) : sans elle, `{a,b}` et `{b,a}` donneraient deux empreintes et un rejeu légitime passerait pour une réutilisation abusive.

**La clé est exigée par défaut** ; `IDEMPOTENCY_REQUIRED=false` assouplit sans redéploiement, le temps que le parc mobile installé bascule. Le mobile en envoie une depuis cette version (`TransactionContext`, une clé **par intention de virement** — pas par appel, sinon elle ne protège de rien — libérée par `clearTransactionData()`). L'exigence sera activée une fois le parc à jour.

Avant cela, `utils/idempotency.js` existait mais `pickIdempotencyKey` **n'était appelée nulle part** : `/initiate` n'acceptait qu'un `body.idempotencyKey` optionnel, que le mobile n'envoyait pas. Un double appui réservait donc les fonds deux fois, la seconde réservation n'étant libérée que par le worker d'annulation, des jours plus tard.

### Montants

Tous les montants sont des `Decimal128` en base, arrondis via `roundMoney(value, currency)` ([src/services/pricingSnapshotNormalizer.js](src/services/pricingSnapshotNormalizer.js)) et reconvertis en `Number` par le `toJSON` de `Transaction` (qui supprime aussi `securityCode`, `securityAnswerHash`, `verificationToken`, `attemptCount`, `lockedUntil`). Le prix appliqué est figé dans `pricingSnapshot` / `feeSnapshot` / `money` au moment de l'initiation — la confirmation **relit** ce snapshot au lieu de recalculer.

### Ledger et trésorerie

Double écriture dans `LedgerEntry` avec des `accountId` conventionnels : `user_wallet:<userId>:<CUR>` et `treasury:<SYSTEM_TYPE>:<userId>:<CUR>`. Les types de trésorerie autorisés sont fermés (`TREASURY_SYSTEM_TYPES`) et chacun résout son user id depuis une variable d'environnement. Revenus de frais → `FEES_TREASURY`, marge de change → `FX_MARGIN_TREASURY`.

## Providers externes et webhooks

- Adapters bas niveau par rail dans [src/providers/](src/providers/) (mobilemoney : wave/orange/mtn/moov ; card : stripe/visa direct ; bank : générique). Chaque adapter normalise le statut provider vers `completed | processing | failed | cancelled | pending`.
- Au-dessus : `services/transactions/providers/` — `providerExecutorRegistry.resolveExecutor({flow, provider})` choisit l'executor, et **retourne `null` pour tout flow/provider sandbox** (garde-fou secondaire).
- Webhooks entrants : `POST /webhooks/providers/:rail/:provider` → [src/controllers/providerWebhookController.js](src/controllers/providerWebhookController.js). La signature est vérifiée par `verifyHmacWebhook()` ([shared/webhookSecurity.js](src/services/transactions/shared/webhookSecurity.js)) : HMAC sur `rawBody` ou `${timestamp}.${rawBody}`, comparaison timing-safe, fenêtre de fraîcheur. **Si aucun secret n'est configuré, la requête est REFUSÉE** (`verified: false`, 401). Ce n'était pas le cas avant le 2026-08-19 : la fonction renvoyait `verified: true`, donc un oubli de variable d'environnement transformait l'endpoint en porte ouverte — n'importe qui pouvait forger un webhook de prestataire de paiement. Échappatoire de développement : `WEBHOOK_ALLOW_UNSIGNED=true`, **sans effet en production**. Le contrôleur exige par ailleurs un `verified === true` explicite : « tout sauf `false` » laissait passer un `undefined`.
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
- **Rate limit — corrigé le 2026-08-19.** Le `sensitiveLimiter` de `routes/transactionsRoutes.js` sautait la limite dès que l'en-tête `x-internal-token` était **présent**, sans comparer sa valeur : `x-internal-token: x` suffisait à lever la limite de 10 requêtes/minute sur `/initiate`, `/confirm` et `/cancel` — donc à autoriser le martèlement des codes de sécurité de confirmation. Il appelle désormais `isValidInternalToken(req)`, exporté par `middleware/internalAuth.js`, qui délègue à [src/utils/internalTokens.js](src/utils/internalTokens.js) : **une seule implémentation** décide si un token interne est valide, en comparaison timing-safe. Couvert par `test/internalTokens.test.js`.
- **Git** : l'historique utilise des messages du type `api paynoval file update vNN---`. Les standards du dépôt (`.claude/docs/coding-standards.md`) demandent des commits conventionnels (`feat(scope): …`) — préférer ces derniers pour les nouveaux commits.
- Ce fichier CLAUDE.md fait foi pour l'architecture réelle de ce dépôt. Les **skills** de `.claude/skills/` (`create-api-skill`, `create-service-skill`, `create-model-skill`, `debug-skill`, `security-review-skill`…) sont opérationnelles et doivent être utilisées pour les tâches correspondantes.
