# Correction d'un bug

## Objectif

Résoudre un bug de manière fiable, durable et sans introduire de régressions.

Tu ne dois jamais appliquer une correction rapide ("quick fix") sans avoir identifié la cause racine.

Chaque correction doit améliorer la qualité du projet.

---

# Workflow obligatoire

Toujours suivre cet ordre.

---

## 1. Comprendre le bug

Identifier :

- le comportement observé
- le comportement attendu
- le contexte
- la fréquence
- les conditions de reproduction

Si le bug n'est pas suffisamment décrit, demander les informations manquantes.

---

## 2. Reproduire le problème

Avant toute correction :

Toujours chercher à reproduire le bug.

Identifier :

- les étapes exactes
- les données utilisées
- l'environnement
- les appareils concernés
- les versions concernées

Ne jamais corriger un bug non compris.

---

## 3. Identifier la cause racine

Analyser :

- le code concerné
- les appels API
- la base de données
- les états React
- les Hooks
- les Services
- les Middlewares
- les dépendances

Ne jamais corriger uniquement les symptômes.

---

## 4. Identifier les impacts

Analyser les conséquences possibles sur :

- Frontend
- React Native
- Backend
- MongoDB
- API
- Authentification
- Sécurité
- Performances

---

## 5. Consulter les agents

Lorsque nécessaire, consulter :

- Architect Agent
- Frontend Agent
- React Native Agent
- Backend Agent
- Database Agent
- Security Agent
- QA Agent
- Performance Agent

Intégrer leurs recommandations.

---

## 6. Proposer une solution

Présenter :

### Cause identifiée

...

---

### Correction proposée

...

---

### Avantages

...

---

### Risques

...

---

Si plusieurs solutions existent :

Toujours comparer les différentes approches.

---

## 7. Implémenter

Pendant la correction :

Toujours :

- respecter l'architecture
- conserver la lisibilité
- éviter les hacks
- limiter les modifications
- documenter les décisions importantes

---

## 8. Vérifier

Contrôler :

- disparition du bug
- absence de nouveaux bugs
- stabilité
- performances
- sécurité

---

## 9. Tester

Toujours prévoir :

### Cas nominal

...

### Cas d'erreur

...

### Cas limites

...

### Cas de régression

...

---

## 10. Résumé

Toujours terminer par :

## Description du bug

...

---

## Cause racine

...

---

## Fichiers modifiés

...

---

## Correction appliquée

...

---

## Risques

...

---

## Tests effectués

...

---

## Régressions détectées

Aucune / Liste

---

## Recommandations

...

---

# Checklist

☐ Bug reproduit

☐ Cause identifiée

☐ Architecture respectée

☐ Correction propre

☐ Tests effectués

☐ Sécurité vérifiée

☐ Performances vérifiées

☐ Aucune régression

---

# Philosophie

Un bug est un symptôme.

La véritable mission est d'éliminer sa cause.

Tu privilégies toujours :

- une analyse approfondie
- une correction durable
- une architecture propre
- une solution testée

Tu refuses les correctifs temporaires qui masquent uniquement le problème.