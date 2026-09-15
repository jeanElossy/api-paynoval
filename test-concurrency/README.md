# Tests de concurrence — TX Core

Répond à la ligne **A2** du suivi. Ce que `npm test` ne peut pas prouver : ce
qui se passe quand N demandes visent **la même ressource au même instant**.

```bash
npm run test:concurrency
```

## Pourquoi ce n'est pas dans `npm test`

Les 572 tests de `npm test` n'ouvrent ni base, ni Redis, ni serveur HTTP. C'est
ce qui les garde sous cinq secondes et exécutables partout. Cette propriété se
**perd** au premier test qui a besoin d'une base, et elle ne se récupère pas.

Ces tests-ci ont besoin d'un **jeu de réplicas**, parce que ce qu'ils vérifient
est précisément le comportement des transactions MongoDB sous conflit
d'écriture. Ils vivent donc à part, et `npm test` ne les voit pas.

## Les deux préconditions, et pourquoi elles refusent au lieu de réparer

### 1. La barrière de banc

`lib/benchGuard.js` refuse toute cible qui n'est pas le banc. Deux verrous
**indépendants** :

| Verrou | Règle |
|---|---|
| Hôte | allowlist stricte : `localhost`, `127.0.0.1`, `::1`, `mongo`, `redis` |
| Base | préfixe `bench_` ou `test_` obligatoire |

Un seul aurait suffi à quelqu'un de prudent. Deux servent le cas réel : **un
tunnel SSH qui expose Atlas sur `localhost:27117` franchit le premier sans
difficulté** — et bute sur le second.

Une variable **absente** est un refus, au même titre qu'un hôte interdit. C'est
la leçon du 2026-08-26, où un garde contrôlait trois variables sur les neuf que
le système lit, et affichait « toutes les cibles sont locales » pendant qu'un
service tournait sur l'Atlas de production.

### 2. Les index uniques doivent déjà exister

Le harnais les **vérifie** et s'arrête. Il ne les crée pas.

```bash
npm run indexes:apply
node scripts/ensure-ledger-indexes.js
```

La tentation inverse est forte et elle est piégeuse : un test qui répare
lui-même sa précondition passe au vert sur une base où l'index manque — et
c'est exactement la situation de production qu'il fallait détecter. Il dirait
« pas de double débit » à propos d'une base qui n'a rien pour l'empêcher.

Quatre index portent à eux seuls toutes les garanties testées ici :

| Index | Ce qu'il empêche |
|---|---|
| `tx_wallet_balances {user, currency}` | deux portefeuilles pour la même devise, entre lesquels l'argent se répartit |
| `ledgerentries {dedupKey}` partiel | le même mouvement écrit deux fois — **et la balance ne le verrait pas**, les doublons allant par paires |
| `idempotency_records {scope, key}` | deux traitements d'une même intention de virement |
| `provider_webhook_events {provider, eventId}` | un rappel prestataire rejoué qui rejoue l'argent |

## Ce qui est couvert

| Fichier | Ressource disputée | Invariant |
|---|---|---|
| `wallet.concurrency.test.js` | même portefeuille · même utilisateur | `NO DOUBLE DEBIT` |
| `ledger.concurrency.test.js` | même transaction | `NO DOUBLE CREDIT` · `NO INCONSISTENT LEDGER` |
| `idempotency.concurrency.test.js` | même clé · même référence prestataire | `NO LOST TRANSACTION` |
| `cagnotteVault.concurrency.test.js` | même coffre de cagnotte | `NO GOAL OVERFLOW` · `NO VAULT OVERDRAFT` · `NO CREDIT AFTER CLOSE` · `NO DOUBLE REVERSAL` |

> ⚠️ **Depuis le 2026-09-15, le harnais exige aussi `MONGO_URI_PRICING`.**
> `connectTransactionsDB()` ouvre une troisième connexion (tarification) ; non
> posée, elle retombait sur le `.env` du dépôt et la suite a ouvert l'Atlas de
> test. `docs/load/bench/env.sh` la pose sur `bench_gateway`, et `preflight.js`
> refuse de démarrer sans elle.

Après chaque rafale touchant le grand livre, la **balance de vérification**
(`services/ledger/doubleEntry.js`) doit fermer à zéro **par devise**. C'est le
seul contrôle qui n'a pas besoin de connaître le bogue à l'avance.

## Deux règles pour ajouter un test ici

**1. Une rafale sans refus n'a rien éprouvé.** Un test qui vérifie seulement
« le solde final est zéro » passe aussi sur un code qui sérialise tout.
`nbEchecs > 0` fait partie de la preuve — c'est pour ça que les scénarios
demandent systématiquement plus que ce que la ressource couvre.

**2. Dire la concurrence réelle, pas celle qu'on croit.** `Promise.all` lance N
tâches dans le même tick, mais le pilote MongoDB n'en a que `maxPoolSize` en
vol : une rafale de 1000 sur un pool de 250 est une file de 1000 servie par
250. C'est aussi ce qui se passe en production — mais ça doit être **dit**,
sinon on croit avoir prouvé une chose qu'on n'a pas mesurée. D'où l'affichage
de la taille du pool à chaque rafale.

> ⚠️ Le pool vaut **250** ici et **15** en production (`MONGO_MAX_POOL_SIZE`,
> défaut de `src/config/db.js`). On monte délibérément pour *provoquer* les
> conflits d'écriture : à 15, la file lisse la concurrence et le test passerait
> sans jamais avoir rien éprouvé.

## Résultats

Consignés dans [`../../docs/architecture/BENCHMARKS.md`](../../docs/architecture/BENCHMARKS.md),
avec la date et la machine. Un chiffre sans les deux ne vaut rien.
