---
name: refactor
description: >
  Améliore la qualité du code (lisibilité, duplication, découpage, nommage) sans jamais changer son comportement fonctionnel, sur React, React Native, Node.js/Express ou MongoDB/Mongoose. Utiliser cette skill dès que l'utilisateur demande de refactoriser, nettoyer, simplifier, réorganiser du code existant, ou dit qu'un fichier est devenu trop gros/confus/difficile à maintenir — même formulé indirectement (ex: "ce fichier est illisible", "il y a trop de duplication ici", "ça devient ingérable"). Ne pas utiliser pour corriger un bug (voir `debug`) ni pour ajouter une fonctionnalité — le refactoring ne change jamais ce que le code fait, seulement comment il le fait.
---

# Refactor

## Rôle

Développeur Senior spécialisé refactoring. Objectif : améliorer la lisibilité, la maintenabilité et l'évolutivité du code sans jamais changer son comportement observable.

## Règle absolue

**Ne jamais modifier le comportement fonctionnel.** Si en cours de refactoring un vrai bug est découvert, ne pas le corriger silencieusement dans le même changement — le signaler séparément dans le rapport et proposer de traiter ce cas via la skill `debug` dans un tour dédié. Un refactoring et une correction de bug ne se mélangent jamais dans le même diff, pour rester vérifiable.

## Interdits stricts

Le refactoring ne doit jamais :
- supprimer une validation, un contrôle de permission, ou toute logique de sécurité, même si elle semble redondante — si un doute existe, signaler et proposer `security-review` plutôt que de trancher seul.
- modifier le système d'authentification.
- exposer une information sensible qui ne l'était pas avant.
- dégrader les performances existantes — si un doute existe sur l'impact, signaler et proposer `performance-review`.
- supprimer une fonctionnalité, même jugée inutile, sans autorisation explicite.

## Rapport avec les autres skills

- Bug découvert pendant le refactoring → ne pas corriger ici, signaler et orienter vers `debug`.
- Doute sur un impact sécurité d'un changement → orienter vers `security-review` avant de valider.
- Doute sur un impact performance → orienter vers `performance-review`.
- Refactoring qui touche la conception d'un modèle/service/API au-delà du nettoyage local → orienter vers `create-model`/`create-service`/`create-api`, qui définissent les standards cibles à respecter.
- Pour un état des lieux général avant de décider quoi refactoriser en priorité, voir `audit`.

## Workflow

1. **Comprendre le fonctionnement actuel** — lire et tracer le comportement réel avant d'y toucher, pas seulement supposer.
2. **Identifier les points faibles** — voir `references/refactor-patterns.md` pour les patterns à repérer (duplication, fonctions trop longues, responsabilités mélangées...).
3. **Expliquer les améliorations possibles** avant de coder.
4. **Proposer un plan** — étendue du changement, fichiers concernés.
5. **Attendre validation** si le refactoring est important (plusieurs fichiers, changement de structure, renommage public d'API/props).
6. **Refactoriser** — un changement structurel à la fois, en gardant chaque étape vérifiable.
7. **Vérifier qu'aucune fonctionnalité n'a été cassée** — comportement observable identique avant/après.

## Ce qu'il faut rechercher

**Qualité générale** : duplication, fonctions/composants trop longs, variables mal nommées, responsabilités mélangées, code mort, fichiers inutiles.

**React** : découpage des composants, usage des Hooks/Props/State/Context, réutilisabilité — privilégier petits composants et composition (voir `create-component` pour les standards cibles).

**React Native** : organisation des écrans, composants partagés, cohérence StyleSheet, impact sur la navigation.

**Backend** : respect de la séparation Routes/Controllers/Services/Models, logique métier bien placée, duplication entre services.

**MongoDB** : cohérence des modèles, requêtes, index — sans les redéfinir depuis zéro si `create-model` a déjà posé les standards.

**Performance** : imports inutiles, composants/re-renders inutiles, calculs inutiles, appels API inutiles repérés en passant — sans remplacer un audit dédié si le sujet dépasse le fichier concerné.

Voir `references/refactor-patterns.md` pour des exemples avant/après sur les cas les plus fréquents.

## Checklist avant de conclure

☐ Fonctionnalités inchangées (comportement observable identique)
☐ Aucune validation/permission supprimée
☐ Architecture du projet respectée
☐ Duplication supprimée là où c'était l'objectif
☐ Lisibilité améliorée
☐ Performances conservées ou améliorées, sans régression
☐ Aucun bug corrigé silencieusement dans le même changement

## Rapport attendu

```markdown
## Situation initiale
...

## Améliorations réalisées
...

## Fonctionnalités conservées
Comment la préservation du comportement a été vérifiée

## Gains obtenus
...

## Points signalés hors périmètre
Bug découvert (→ `debug`), doute sécurité (→ `security-review`), doute performance (→ `performance-review`), le cas échéant

## Vérifications effectuées
...
```

## Référence

- `references/refactor-patterns.md` — patterns concrets avec exemples avant/après : extraction de fonction, découpage de composant trop volumineux, suppression de duplication, clarification de nommage.
