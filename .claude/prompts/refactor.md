# Refactorisation de code

## Objectif

Améliorer la qualité du code existant sans modifier son comportement fonctionnel.

La refactorisation doit rendre le code plus :

- lisible
- maintenable
- réutilisable
- performant
- sécurisé
- évolutif

Le comportement de l'application doit rester strictement identique.

---

# Workflow obligatoire

Toujours respecter cet ordre.

---

## 1. Comprendre le code existant

Avant toute modification :

Identifier :

- l'objectif du code
- son fonctionnement
- ses dépendances
- ses responsabilités
- les fichiers concernés

Ne jamais refactoriser un code qui n'est pas compris.

---

## 2. Identifier les problèmes

Rechercher :

- duplication
- dette technique
- code mort
- fonctions trop longues
- composants trop volumineux
- responsabilités multiples
- noms peu explicites
- logique complexe
- dépendances inutiles

---

## 3. Vérifier l'architecture

Toujours contrôler :

- séparation des responsabilités
- respect des conventions
- cohérence avec l'architecture existante

Le refactoring ne doit pas casser l'organisation du projet.

---

## 4. Identifier les opportunités

Chercher à :

- simplifier le code
- améliorer la lisibilité
- factoriser les éléments communs
- réduire la complexité
- améliorer la réutilisation
- améliorer les performances lorsque cela est pertinent

---

## 5. Consulter les agents

Lorsque nécessaire :

- Architect Agent
- Frontend Agent
- React Native Agent
- Backend Agent
- Database Agent
- Performance Agent
- Security Agent
- QA Agent

Intégrer leurs recommandations avant toute modification.

---

## 6. Proposer une stratégie

Présenter :

### Situation actuelle

...

---

### Problèmes identifiés

...

---

### Refactorisation proposée

...

---

### Avantages

...

---

### Risques

...

---

Si plusieurs approches sont possibles :

Toujours comparer les solutions.

---

## 7. Implémenter

Pendant la refactorisation :

Toujours :

- conserver le comportement existant
- respecter les Coding Standards
- utiliser des noms explicites
- supprimer le code mort
- limiter les dépendances
- améliorer la lisibilité

Ne jamais :

- modifier la logique métier
- introduire une nouvelle fonctionnalité
- casser la compatibilité

---

## 8. Vérifier

Contrôler :

- comportement inchangé
- architecture respectée
- qualité améliorée
- sécurité conservée
- performances conservées ou améliorées

---

## 9. Tester

Toujours vérifier :

- cas nominal
- cas limites
- cas d'erreur
- absence de régression

---

## 10. Documentation

Si nécessaire :

Mettre à jour :

- commentaires utiles
- documentation technique
- README
- architecture

---

# Rapport attendu

Toujours terminer par :

## Objectif du refactoring

...

---

## Problèmes détectés

...

---

## Améliorations réalisées

...

---

## Fichiers modifiés

...

---

## Impact sur les performances

...

---

## Impact sur la maintenabilité

...

---

## Risque de régression

Faible / Moyen / Élevé

---

## Tests effectués

...

---

## Recommandations

...

---

# Score du refactoring

Attribuer une note sur 100.

Exemple :

Lisibilité : 20 / 20

Maintenabilité : 20 / 20

Architecture : 19 / 20

Performance : 18 / 20

Sécurité : 20 / 20

Score global : 97 / 100

---

# Checklist

☐ Comportement inchangé

☐ Architecture respectée

☐ Code simplifié

☐ Duplication supprimée

☐ Code mort supprimé

☐ Sécurité préservée

☐ Performances vérifiées

☐ Tests réalisés

☐ Documentation mise à jour si nécessaire

---

# Philosophie

Refactoriser signifie améliorer le code, pas changer ce qu'il fait.

Chaque modification doit rendre le projet plus simple, plus robuste et plus facile à maintenir.

Tu refuses toute refactorisation qui introduit un risque inutile ou qui modifie le comportement attendu de l'application.