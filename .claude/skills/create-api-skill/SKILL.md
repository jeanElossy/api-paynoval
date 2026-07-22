---
name: create-api
description: >
  Crée une API REST complète (routes, controllers, services, models Mongoose) avec Node.js, Express et MongoDB en respectant l'architecture en couches du projet. Utiliser cette skill dès que l'utilisateur demande de créer, ajouter ou exposer un endpoint, une route API, une ressource backend, un CRUD, ou décrit un besoin fonctionnel côté serveur — même formulé indirectement (ex: "il me faut un moyen de récupérer les commandes d'un utilisateur", "ajoute la possibilité de supprimer un produit", "comment gérer l'upload d'avatar côté backend"). Pour un audit de sécurité approfondi sur une API existante plutôt qu'une création, utiliser `security-review`.
---

# Create API

## Rôle

Développeur Backend Senior spécialisé Node.js, Express, MongoDB. Objectif : produire une API robuste, sécurisée, évolutive et maintenable, respectant l'architecture et les conventions du projet.

## Règle absolue

**Aucune logique métier dans les routes ou les controllers.** Toute la logique métier va dans les services — voir architecture ci-dessous. C'est non négociable, même pour un endpoint qui semble trivial.

## Rapport avec les autres skills

Cette skill crée et sécurise une nouvelle API dès sa conception (validation, auth, gestion d'erreurs de base). Pour un audit de sécurité complet OWASP sur du code déjà existant, utiliser `security-review` — ne pas dérouler ici la checklist OWASP intégrale. Pour la conception détaillée d'un modèle (relations, index, choix référence/embedding), déléguer à `create-model` plutôt que de la refaire ici. Pour de la logique métier complexe au sein de la couche Service, déléguer à `create-service`. Pour un état des lieux général du projet, voir `audit`.

## Architecture obligatoire

```
Routes → Controllers → Services → Models → MongoDB
```

- **Routes** : reçoivent la requête, appliquent les middlewares (auth, validation), appellent le controller, retournent la réponse. Rien d'autre.
- **Controllers** : valident les données reçues, appellent les services, gèrent la réponse HTTP et les erreurs. Pas de logique métier complexe.
- **Services** : toute la logique métier. Réutilisables, testables, indépendants des routes/Express.
- **Models** : schémas Mongoose — validations, index utiles, pas de champs inutiles.

Voir `references/layered-example.md` pour un exemple complet de bout en bout sur une ressource CRUD.

## Workflow

1. **Comprendre le besoin fonctionnel** — quelle ressource, quelles opérations (CRUD, actions spécifiques).
2. **Identifier les ressources concernées** — modèle(s) Mongoose impliqué(s), relations avec d'autres ressources.
3. **Vérifier l'existant** — une route ou un service similaire existe-t-il déjà ? Peut-il être étendu ?
4. **Réutiliser les services existants** quand c'est possible plutôt que dupliquer.
5. **Proposer les fichiers à créer/modifier** et attendre validation si la modification est structurante (nouveau modèle, changement d'architecture).
6. **Générer le code** en respectant l'architecture en couches — voir `references/layered-example.md` et `references/validation-and-errors.md`.
7. **Vérifier la cohérence globale** — nommage, conventions du projet, pas de duplication.
8. **Résumer les modifications.**

## Points systématiques à chaque endpoint créé

- **Validation** : toutes les entrées (body, query, params) validées — type, format, bornes. Ne jamais faire confiance aux données reçues. Voir `references/validation-and-errors.md`.
- **Authentification/autorisation** : middleware d'auth appliqué si la route est protégée ; vérification explicite que l'utilisateur a le droit d'agir sur *cette* ressource précise (pas seulement d'être connecté).
- **Gestion des erreurs** : try/catch, codes HTTP corrects, messages clairs qui ne fuient pas de détails internes en production.
- **MongoDB** : requêtes qui sélectionnent uniquement les champs utiles, `lean()` quand la donnée n'a pas besoin d'être un document Mongoose complet, index sur les champs de filtre/tri fréquents.
- **Secrets** : jamais de clé/secret en dur — toujours via variables d'environnement.

Pour la checklist de sécurité complète (OWASP), déléguer à `security-review` plutôt que de la re-dérouler ici.

## Checklist avant de conclure

☐ Routes créées, sans logique métier
☐ Controllers créés, validation + gestion d'erreurs en place
☐ Services créés, logique métier isolée et réutilisable
☐ Models créés ou mis à jour, avec validations et index pertinents
☐ Authentification/autorisation vérifiées sur les routes protégées
☐ Aucun secret en dur
☐ Documentation minimale ajoutée si l'endpoint est non trivial

## Rapport attendu

```markdown
## Objectif
...

## Endpoints créés
Méthode + route + description courte

## Fichiers créés
...

## Fichiers modifiés
...

## Validation
Ce qui est validé et comment

## Sécurité
Auth/autorisation appliquées ; signaler si un audit `security-review` est recommandé

## Vérifications effectuées
...
```

## Référence

- `references/layered-example.md` — exemple complet Route → Controller → Service → Model sur une ressource CRUD.
- `references/validation-and-errors.md` — patterns de validation des entrées et de gestion d'erreurs avec exemples avant/après.
