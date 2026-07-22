---
name: create-model
description: >
  Conçoit ou modifie un modèle Mongoose (schéma, validations, relations, index) optimisé pour MongoDB et pensé pour l'évolution du projet. Utiliser cette skill dès que l'utilisateur demande de créer, modifier ou concevoir un modèle, un schéma, une collection MongoDB, ou décrit une nouvelle entité métier à stocker — même formulé indirectement (ex: "je dois stocker les avis clients", "comment relier un produit à sa catégorie", "cette collection devient trop lente"). Pour créer une API complète autour d'un modèle (routes/controllers/services), utiliser `create-api`, qui invoque cette skill pour la conception du modèle sous-jacent.
---

# Create Model

## Rôle

Architecte base de données et expert MongoDB/Mongoose. Objectif : concevoir des modèles robustes, performants, évolutifs et sécurisés, qui représentent fidèlement le métier — pas seulement le besoin immédiat.

## Règle absolue

**Ne jamais stocker de donnée sensible sans protection** (mot de passe en clair, secret, clé API, donnée personnelle non justifiée). Un mot de passe est toujours hashé (bcrypt/argon2) avant stockage, jamais en clair même temporairement.

## Rapport avec les autres skills

Cette skill est le point de référence pour la conception de schéma (structure, validations, relations, index). `create-api` l'invoque pour la couche Model lors de la création d'une ressource complète — ne pas dupliquer ici le reste de l'architecture (routes/controllers/services). Pour l'audit de sécurité complet d'un modèle déjà en production, voir `security-review`.

## Workflow

1. **Comprendre le besoin métier** — quelle entité, quel rôle joue-t-elle dans le produit.
2. **Identifier les données à stocker** — champs réellement nécessaires, éviter d'anticiper des champs "au cas où".
3. **Déterminer les relations** — avec quelles autres collections, référence (`ObjectId` + `ref`) ou embedding — voir `references/schema-patterns.md#relations`.
4. **Identifier les contraintes métier** — unicité, valeurs autorisées, bornes, champs obligatoires.
5. **Déterminer les index nécessaires** — champs de filtre/tri fréquents, contraintes d'unicité — voir `references/schema-patterns.md#index`.
6. **Proposer la structure** avant de générer si la modification impacte des données existantes.
7. **Attendre validation** si le changement casse la compatibilité (renommage/suppression de champ, changement de type).
8. **Générer le modèle** — voir `references/schema-patterns.md` pour les patterns attendus.
9. **Vérifier les performances** — taille des documents, tableaux non bornés, requêtes que ce modèle rendra possibles ou coûteuses.
10. **Vérifier la compatibilité** — impact sur les services, controllers, routes et données déjà existantes qui utilisent ce modèle.

## Standards attendus

- Chaque champ : type adapté, validation (`required`, `enum`, `min`/`max`, `minlength`/`maxlength`, `match`), valeur par défaut si pertinent, nom explicite.
- `timestamps: true` par défaut sauf raison contraire.
- Relations via `ObjectId` + `ref` quand l'entité liée a un cycle de vie indépendant ; embedding quand la donnée est intrinsèquement liée et peu volumineuse (voir `references/schema-patterns.md#relations` pour le critère de choix).
- `populate` seulement quand la donnée liée est réellement nécessaire à l'usage — jamais par défaut "au cas où".
- Méthodes statiques/d'instance pour la logique directement liée à la forme des données (ex: `user.comparePassword()`), le reste va dans les services.
- Éviter les tableaux non bornés dans un document (risque de documents trop volumineux) — envisager une collection séparée au-delà d'une taille raisonnable.

## Checklist avant de conclure

☐ Schéma cohérent avec le besoin métier
☐ Validations présentes sur chaque champ pertinent
☐ Relations choisies (référence vs embedding) avec justification
☐ Index proposés sur les champs de filtre/tri/unicité fréquents, sans index inutile
☐ Aucune donnée sensible stockée sans protection
☐ Impact sur les services/controllers/routes existants vérifié
☐ Compatibilité avec les données déjà en base vérifiée

## Rapport attendu

```markdown
## Objectif
...

## Modèles créés/modifiés
...

## Champs
...

## Relations
Choix référence/embedding et justification

## Index
...

## Validations
...

## Vérifications effectuées
Performance, sécurité, compatibilité

## Recommandations
...
```

## Référence

- `references/schema-patterns.md` — patterns concrets avec exemples : validations, choix référence vs embedding, stratégie d'index, méthodes statiques/d'instance, virtuals.
