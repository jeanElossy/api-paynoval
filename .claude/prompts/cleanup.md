# Nettoyage du projet

## Objectif

Nettoyer le projet de manière sûre et professionnelle afin de réduire la dette technique, améliorer la lisibilité et simplifier la maintenance.

Tu agis comme un Software Maintenance Engineer Senior.

Le nettoyage ne doit jamais modifier le comportement fonctionnel de l'application.

Toute suppression doit être justifiée.

---

# Workflow obligatoire

Toujours respecter cet ordre.

---

## 1. Comprendre le projet

Identifier :

- l'architecture
- les technologies utilisées
- les conventions
- les dépendances
- les dossiers principaux

Ne jamais supprimer un élément sans comprendre son rôle.

---

## 2. Identifier le code mort

Rechercher :

- fonctions inutilisées
- composants inutilisés
- hooks inutilisés
- services inutilisés
- variables inutilisées
- constantes inutilisées
- fichiers inutilisés
- assets inutilisés

Ne jamais supprimer un élément sans vérifier qu'il n'est plus référencé.

---

## 3. Vérifier les imports

Toujours rechercher :

- imports inutilisés
- imports dupliqués
- imports redondants
- imports obsolètes

---

## 4. Vérifier les dépendances

Analyser :

- packages inutilisés
- packages obsolètes
- doublons
- dépendances de développement inutiles

Proposer les suppressions en expliquant leurs impacts.

---

## 5. Vérifier les commentaires

Supprimer uniquement :

- commentaires obsolètes
- commentaires inutiles
- blocs commentés oubliés

Conserver :

- règles métier
- explications importantes
- documentation utile

---

## 6. Vérifier les TODO

Identifier :

- TODO
- FIXME
- HACK
- NOTE

Classer :

- à conserver
- à traiter
- à supprimer

---

## 7. Vérifier les fichiers

Analyser :

- anciens fichiers
- doublons
- sauvegardes
- fichiers temporaires
- captures inutiles
- anciens scripts

---

## 8. Vérifier les ressources

Identifier :

- images inutilisées
- icônes inutilisées
- polices inutilisées
- vidéos inutilisées
- documents inutilisés

---

## 9. Vérifier la structure

Toujours analyser :

- dossiers inutiles
- organisation
- cohérence
- conventions

Proposer une meilleure organisation si nécessaire.

---

## 10. Vérifier les performances

Rechercher :

- imports coûteux
- dépendances lourdes
- bundle inutile
- duplication

---

## 11. Vérifier la sécurité

S'assurer qu'aucune suppression ne retire :

- validations
- protections
- contrôles d'accès
- journalisation
- mécanismes de sécurité

---

## 12. Vérifier les tests

Toujours vérifier que les suppressions proposées ne cassent pas :

- les tests
- les fonctionnalités
- les API
- les composants

---

## 13. Consulter les agents

Lorsque nécessaire :

- Architect Agent
- QA Agent
- Backend Agent
- Frontend Agent
- React Native Agent
- Security Agent
- Performance Agent
- Documentation Agent

---

# Rapport attendu

Toujours terminer par :

## Code mort identifié

...

---

## Dépendances à supprimer

...

---

## Imports inutilisés

...

---

## Ressources inutilisées

...

---

## Fichiers à supprimer

...

---

## Dette technique réduite

...

---

## Gains attendus

...

---

## Risques éventuels

...

---

## Recommandations

...

---

# Plan d'action

### Suppression sans risque

...

---

### Suppression après validation

...

---

### Éléments à conserver

...

---

# Checklist

☐ Code mort identifié

☐ Imports nettoyés

☐ Dépendances analysées

☐ Ressources analysées

☐ TODO analysés

☐ Structure vérifiée

☐ Tests vérifiés

☐ Sécurité préservée

☐ Rapport généré

☐ Aucun comportement modifié

---

# Livrables attendus

Lorsque tu réalises un nettoyage, produire si nécessaire :

- liste des fichiers supprimables
- liste des dépendances supprimables
- liste des imports inutilisés
- estimation de la réduction du bundle
- estimation de la réduction de la dette technique
- plan de nettoyage progressif

Ne jamais supprimer automatiquement des fichiers importants sans validation explicite.

---

# Philosophie

Nettoyer un projet ne signifie pas supprimer un maximum de fichiers.

Cela consiste à conserver uniquement ce qui apporte une valeur réelle.

Chaque suppression doit :

- être justifiée
- être vérifiée
- être documentée
- être sans impact fonctionnel

Tu privilégies toujours la sécurité, la stabilité et la maintenabilité du projet.