# Création d'une API

## Objectif

Créer une API REST professionnelle en respectant l'architecture du projet.

L'API doit être :

- sécurisée
- performante
- maintenable
- documentée
- testable
- cohérente avec l'architecture existante

Ne jamais créer un simple endpoint isolé.

---

# Workflow obligatoire

Toujours respecter cet ordre.

---

## 1. Comprendre le besoin

Identifier :

- l'objectif métier
- les utilisateurs concernés
- les données manipulées
- les règles métier
- les contraintes de sécurité

Si une information manque, poser les questions nécessaires.

---

## 2. Vérifier l'existant

Analyser :

- les routes existantes
- les contrôleurs
- les services
- les modèles
- les middlewares
- les validations
- les conventions du projet

Toujours privilégier la réutilisation.

---

## 3. Définir les endpoints

Lister :

- Méthode HTTP
- URL
- Description
- Authentification requise
- Permissions nécessaires

Exemple :

GET /users

POST /transactions

PATCH /profile

DELETE /notifications/:id

---

## 4. Identifier les fichiers

Créer uniquement les fichiers nécessaires.

Exemple :

routes/

controllers/

services/

validators/

middlewares/

models/

tests/

documentation/

---

## 5. Vérifier l'architecture

Respecter impérativement :

Routes

↓

Controllers

↓

Services

↓

Repositories (si présents)

↓

Database

Aucune logique métier dans les routes.

Les contrôleurs restent légers.

Toute la logique métier appartient aux services.

---

## 6. Validation

Toujours valider :

- body
- query
- params
- headers
- fichiers

Ne jamais faire confiance aux données reçues.

---

## 7. Sécurité

Toujours vérifier :

- authentification
- autorisations
- rôles
- validation
- protection OWASP
- limitation du rate limiting si nécessaire

Aucune donnée sensible ne doit être exposée.

---

## 8. MongoDB

Toujours vérifier :

- schéma
- index
- validations
- performances
- relations
- transactions si nécessaires

Utiliser `lean()` lorsque pertinent pour les requêtes en lecture.

---

## 9. Gestion des erreurs

Toujours prévoir :

- erreurs métier
- erreurs système
- ressources inexistantes
- validation
- permissions

Les réponses doivent être cohérentes.

Exemple :

400

401

403

404

409

422

500

---

## 10. Documentation

Documenter :

- endpoints
- paramètres
- réponses
- exemples
- erreurs possibles

---

## 11. Tests

Toujours prévoir :

- cas nominal
- validation
- authentification
- autorisations
- erreurs
- cas limites

---

## 12. Résumé

Toujours terminer par :

## Endpoints créés

...

---

## Fichiers créés

...

---

## Fichiers modifiés

...

---

## Validation

...

---

## Sécurité

...

---

## Tests

...

---

## Documentation

...

---

## Recommandations

...

---

# Checklist

☐ Architecture respectée

☐ Validation des données

☐ Authentification

☐ Autorisations

☐ Gestion des erreurs

☐ Sécurité vérifiée

☐ MongoDB optimisée

☐ Documentation créée

☐ Tests prévus

☐ Aucune duplication

---

# Philosophie

Une API doit être conçue comme un contrat fiable entre le client et le serveur.

Elle doit être :

- prévisible
- sécurisée
- évolutive
- performante
- documentée

Tu refuses toute API qui ne respecte pas les standards d'architecture du projet.