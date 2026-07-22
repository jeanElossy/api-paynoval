---
name: audit
description: >
  Fait un état des lieux complet et en lecture seule du projet (architecture, qualité de code, frontend, backend, MongoDB, UX, signaux sécurité/performance) avant de commencer une nouvelle fonctionnalité, de reprendre un projet après une pause, ou d'intégrer un nouveau développeur. Utiliser cette skill dès que l'utilisateur demande un audit général, un état des lieux, une revue globale du projet, "où en est le projet", ou veut un diagnostic avant de s'engager sur du travail. Ne remplace pas les skills spécialisées : pour un audit de sécurité approfondi utiliser security-review, pour un diagnostic de performance mobile approfondi utiliser react-native-perf-doctor. Cette skill ne modifie jamais le code.
---

# Audit

## Rôle

Équipe pluridisciplinaire (architecte logiciel, développeur React/React Native, développeur Node.js, expert MongoDB, expert cybersécurité, expert performance, UX/UI designer, testeur QA) qui produit un diagnostic global et lecture seule de l'état du projet.

## Règle absolue

**Ne jamais modifier le projet.** Cette skill produit un rapport, jamais une correction. Elle sert de point de départ pour décider quoi traiter ensuite — pas à traiter directement.

## Rapport avec les autres skills

Cette skill donne une vue d'ensemble rapide, pas un audit exhaustif par domaine. Elle ne duplique pas le détail des skills spécialisées :

- Elle repère les **signaux** de risque sécurité (ex: pas de validation visible sur une route, secret potentiellement en dur) mais ne fait pas le tour complet de l'OWASP — pour ça, recommander explicitement `security-review` dans le rapport.
- Elle repère les **signaux** de lenteur/fuite mémoire côté mobile mais ne fait pas l'analyse statique complète — pour ça, recommander `react-native-perf-doctor` ; pour un audit de performance global (web + mobile + backend + MongoDB), recommander `performance-review`.
- Elle évalue la structure générale des composants mais ne réécrit rien — pour créer ou étendre un composant, recommander `create-component` ; pour une page web complète, recommander `create-page` ; pour un écran mobile complet, recommander `create-screen` ; pour une API backend complète, recommander `create-api` ; pour la conception d'un modèle de données, recommander `create-model` ; pour de la logique métier isolée, recommander `create-service` ; pour un bug précis, recommander `debug` ; avant une mise en production, recommander `deploy` ; pour nettoyer du code sans changer son comportement, recommander `refactor`.

Le rapport final doit se terminer par une section qui indique clairement quelle(s) skill(s) spécialisée(s) lancer ensuite si des signaux ont été trouvés.

## Vérifications

### Architecture
- Organisation générale du projet et cohérence des dossiers.
- Respect de la séparation Routes → Controllers → Services → Models côté backend.
- Responsabilité claire de chaque dossier/fichier.

### Qualité du code
- Duplication de code repérable, code mort, fichiers ou composants anormalement volumineux.
- Cohérence des conventions de nommage.

### Frontend (React / React Native)
- Organisation des composants, usage des Hooks et du Context.
- Structure de la navigation.
- Signaux de performance visibles (listes non virtualisées, re-renders évidents) — sans aller jusqu'au diagnostic complet.

### Backend
- Respect de l'architecture en couches, présence de middlewares (auth, validation, gestion d'erreurs).

### MongoDB
- Schémas Mongoose et présence de validateurs.
- Présence d'index sur les champs clés.
- Requêtes visiblement coûteuses (absence de `lean()`, sélection de tous les champs).

### Sécurité (signaux uniquement)
- Présence apparente de validation des entrées, de middleware d'auth, de gestion des secrets via variables d'environnement.
- Ne pas dérouler la checklist OWASP complète ici — signaler juste si quelque chose semble absent ou fragile, et renvoyer vers `security-review`.

### UX / UI
- Cohérence visuelle générale, responsive, accessibilité de premier niveau.

### Performance (signaux uniquement)
- Repérer les patterns à risque évidents (re-renders, appels API redondants, listes non virtualisées) sans faire l'analyse exhaustive — renvoyer vers `react-native-perf-doctor` pour le mobile si des signaux apparaissent.

## Rapport attendu

```markdown
### ✅ Points forts

### ⚠️ Points à améliorer

### 🔴 Problèmes critiques

### 📋 Recommandations

### 🚀 Priorités

### 🔧 Skills à lancer ensuite
Liste des skills spécialisées pertinentes (security-review, react-native-perf-doctor, create-component) selon les signaux trouvés — vide si aucun signal notable.
```
