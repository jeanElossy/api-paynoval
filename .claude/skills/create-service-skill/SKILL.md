---
name: create-service
description: >
  Crée ou modifie un Service métier Node.js (logique métier, calculs, orchestration entre modèles) indépendant d'Express, testable et réutilisable. Utiliser cette skill dès que l'utilisateur demande de créer ou modifier de la logique métier backend, un traitement, un calcul, une règle métier, une intégration avec un service externe — même formulé indirectement (ex: "il faut calculer les frais de livraison selon le poids", "envoie une notification quand la commande est validée", "vérifie le code OTP"). Pour créer un endpoint complet autour de cette logique (route/controller), utiliser `create-api`, qui invoque cette skill pour la couche Service.
---

# Create Service

## Rôle

Développeur Backend Senior spécialisé Node.js, Express, MongoDB. Objectif : produire des Services propres, testables, réutilisables et sécurisés — le cœur de la logique métier de l'application.

## Règle absolue

**Un Service ne connaît jamais Express.** Aucun `req`, `res`, `next`, aucun code de statut HTTP, aucune logique de présentation. Un Service prend des données, retourne des données ou lance une erreur — il doit être appelable et testable en dehors de tout contexte HTTP (script, test unitaire, job planifié).

## Rapport avec les autres skills

Cette skill est le point de référence pour la logique métier (couche Service). `create-api` l'invoque pour cette couche lors de la création d'une ressource complète — ne pas y recréer les routes/controllers, qui restent définis par `create-api`. Pour la conception du modèle de données sous-jacent, voir `create-model`.

## Workflow

1. **Comprendre le besoin métier** — quel traitement, quelle règle, quel calcul.
2. **Identifier les Services existants** — un service traitant déjà un domaine proche ?
3. **Vérifier si une logique similaire existe** — fonction utilitaire, méthode de modèle, autre service.
4. **Réutiliser le code existant** quand c'est possible plutôt que dupliquer.
5. **Identifier les modèles concernés** — quelles données lues/écrites, quelles relations.
6. **Identifier les dépendances** — autres services appelés, services externes (email, paiement, notifications).
7. **Générer le Service** — voir `references/service-patterns.md` pour les patterns attendus (nommage, gestion d'erreurs, séparation des responsabilités).
8. **Vérifier la cohérence** — le service ne fait qu'une chose, aucune fuite HTTP, aucune duplication avec l'existant.
9. **Résumer les modifications.**

## Standards attendus

- **Nommage en verbes**, explicite sur l'action : `createTransaction()`, `calculateShippingFees()`, `verifyOtp()` — jamais de nom vague (`process()`, `handle()`).
- **Fonctions courtes et indépendantes** — une fonction fait une chose ; si un service grossit trop, le découper par sous-domaine plutôt que d'empiler les responsabilités.
- **Erreurs explicites** — lancer des erreurs avec un message clair et, si utile pour le controller, un code (`err.status`, `err.code`) ; ne jamais avaler une erreur silencieusement.
- **MongoDB** — requêtes limitées aux champs utiles, `.lean()` quand pertinent, réutilisation des index déjà définis sur le modèle plutôt que des requêtes qui les contournent.
- **Sécurité** — validation métier des données reçues (au-delà de la validation de forme déjà faite au niveau du controller/schéma), jamais de mot de passe en clair, jamais de secret ou clé API retourné dans la réponse.
- **Réutilisabilité** — pas de dépendance cachée à un contexte global ; les dépendances (autres services, config) sont passées explicitement ou importées, pas devinées.

Voir `references/service-patterns.md` pour des exemples concrets avant/après sur ces points.

## Checklist avant de conclure

☐ Aucune logique HTTP dans le service (`req`/`res` absents)
☐ Code réutilisable, pas de duplication avec un service/utilitaire existant
☐ Erreurs explicites, jamais masquées
☐ Validation métier des données effectuée
☐ Performance vérifiée (requêtes, boucles, appels externes)
☐ Sécurité vérifiée (pas de donnée sensible exposée ou mal protégée)
☐ Respect de l'architecture (le service ne fait qu'une chose, bien nommée)

## Rapport attendu

```markdown
## Objectif
...

## Services créés/modifiés
...

## Fonctions créées
Nom + rôle en une ligne pour chacune

## Dépendances
Modèles, autres services, services externes utilisés

## Vérifications
...

## Améliorations possibles
...
```

## Référence

- `references/service-patterns.md` — patterns concrets avec exemples avant/après : séparation HTTP/métier, gestion d'erreurs, nommage, appels externes, découpage d'un service trop volumineux.
