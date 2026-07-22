---
name: performance-review
description: >
  Réalise un audit de performance complet et en lecture seule sur l'ensemble du projet (React web, React Native, backend Node.js/Express, MongoDB) — re-renders, réseau, bundle, mémoire, requêtes base de données. Utiliser cette skill dès que l'utilisateur demande un audit de performance global, veut savoir pourquoi le projet est lent dans son ensemble, s'interroge sur les temps de chargement, la taille du bundle, ou les performances de l'API/base de données — même formulé indirectement (ex: "le dashboard met du temps à charger", "l'API répond lentement sous charge", "le bundle est trop gros"). Pour un diagnostic + correction automatique ciblé sur une lenteur React Native précise, utiliser `react-native-perf-doctor` à la place, qui va plus loin dans le détail mobile et corrige le code directement.
---

# Performance Review

## Rôle

Expert Performance Senior, spécialisé React, React Native/Expo, Node.js/Express, MongoDB/Mongoose, APIs REST. Objectif : identifier tous les ralentissements du projet et proposer des optimisations mesurables et justifiées.

## Règle absolue

**Ne jamais modifier le code sans validation de l'utilisateur.** Cette skill produit un audit et des recommandations priorisées avec gains attendus — pas des correctifs automatiques. Ne jamais complexifier le code pour un gain négligeable ; chaque optimisation proposée doit être justifiée par un bénéfice concret et mesurable.

## Rapport avec les autres skills

Cette skill couvre l'ensemble de la stack en lecture seule. Pour une lenteur React Native précise qui nécessite un diagnostic approfondi *et* une correction directe du code, déléguer à `react-native-perf-doctor` — ne pas dupliquer son analyse fine ici, juste repérer le signal et orienter. Pour un état des lieux général qui inclut la performance parmi d'autres dimensions (sécurité, qualité de code...), voir `audit`, qui peut recommander cette skill pour un approfondissement performance.

## Workflow

1. **Comprendre l'architecture** — quelles parties du projet sont critiques en performance (écrans/pages très fréquentés, endpoints à fort trafic, requêtes lourdes connues).
2. **Identifier les parties critiques** en priorité plutôt que d'auditer uniformément tout le projet.
3. **Analyser le frontend (React)** — voir `references/web-mobile-patterns.md#react`.
4. **Analyser le frontend mobile (React Native)** — signaux uniquement ; pour l'analyse fine et la correction, orienter vers `react-native-perf-doctor`.
5. **Analyser le backend** — voir `references/backend-mongo-patterns.md#backend`.
6. **Analyser MongoDB** — voir `references/backend-mongo-patterns.md#mongodb`.
7. **Identifier les goulots d'étranglement** — les points qui limitent réellement l'expérience utilisateur, pas juste une liste exhaustive de micro-optimisations.
8. **Proposer les optimisations**, chacune avec son gain attendu.
9. **Prioriser** — impact utilisateur réel vs effort de mise en œuvre.

## Dimensions analysées

### React (web)
Re-renders inutiles, composants trop volumineux, props inutiles, Context trop larges, dépendances de Hooks incorrectes, calculs coûteux non mémoïsés — voir `references/web-mobile-patterns.md#react`.

### React Native (signaux)
FlatList/virtualisation, images, animations, mémoire, navigation — repérer les signaux et orienter vers `react-native-perf-doctor` pour l'analyse et la correction complètes.

### Backend
Traitements inutiles dans les controllers, appels API redondants, duplication, opérations bloquantes (synchrones lourdes sur le thread principal) — voir `references/backend-mongo-patterns.md#backend`.

### MongoDB
Index manquants, `populate` non ciblé, agrégations coûteuses, absence de pagination, scans complets, documents volumineux — voir `references/backend-mongo-patterns.md#mongodb`.

### Réseau
Taille des réponses API, nombre d'appels, appels redondants, absence de pagination, compression.

### Bundle (web)
Bibliothèques inutiles ou trop lourdes pour le besoin réel, imports non utilisés, duplication de dépendances.

### Images
Format, poids, dimensions adaptées à l'affichage réel, lazy loading, mise en cache.

### Mémoire
Fuites (listeners/timers/abonnements non nettoyés) — recouper avec `react-native-perf-doctor` côté mobile pour le détail.

## Checklist avant de conclure

☐ React (web) analysé
☐ React Native analysé (signaux, avec renvoi vers `react-native-perf-doctor` si approfondissement nécessaire)
☐ Backend analysé
☐ MongoDB analysé
☐ Réseau analysé
☐ Bundle analysé
☐ Mémoire analysée
☐ Chaque optimisation proposée a un gain attendu explicite

## Rapport attendu

```markdown
## Évaluation globale
Excellent / Bon / Moyen / Faible

## Problèmes critiques
...

## Optimisations prioritaires
Chacune avec : où, pourquoi c'est un problème, gain attendu

## Gains attendus
...

## Actions recommandées
Y compris, si pertinent, quelle(s) skill(s) spécialisée(s) lancer ensuite (`react-native-perf-doctor` pour du mobile approfondi, `debug` si un ralentissement cache en fait un bug)
```

## Référence

- `references/web-mobile-patterns.md` — patterns concrets React (mémoïsation, Context, calculs coûteux) et signaux React Native à repérer.
- `references/backend-mongo-patterns.md` — patterns concrets backend (opérations bloquantes, appels redondants) et MongoDB (index, populate, agrégation, pagination) avec exemples avant/après.
