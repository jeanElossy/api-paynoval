# API Guidelines

## Objectif

Toutes les API doivent être :

- Simples
- Cohérentes
- Sécurisées
- Performantes
- Documentées
- Faciles à maintenir

Chaque nouvelle API doit respecter les mêmes conventions.

---

# Architecture

Toujours respecter cette architecture :

Routes

↓

Controllers

↓

Services

↓

Models

↓

Database

Les routes ne doivent contenir aucune logique métier.

Les contrôleurs orchestrent les requêtes.

Les services contiennent la logique métier.

Les modèles représentent les données.

---

# Structure des dossiers

backend/

routes/

controllers/

services/

models/

middlewares/

utils/

config/

---

# Routes

Les routes doivent uniquement :

- recevoir la requête
- appeler le contrôleur
- appliquer les middlewares

Ne jamais écrire de logique métier dans les routes.

---

# Controllers

Les contrôleurs doivent :

- récupérer les paramètres
- appeler le service correspondant
- retourner la réponse HTTP

Ils doivent rester courts.

---

# Services

Les services doivent contenir :

- toute la logique métier
- les calculs
- les traitements
- les appels à la base de données

Ils doivent être réutilisables.

---

# Models

Les modèles Mongoose doivent :

- définir clairement les champs
- utiliser les validations
- utiliser les index lorsque nécessaire
- éviter les champs inutiles

---

# Réponses API

Toujours retourner des réponses cohérentes.

Succès :

{
    success: true,
    message: "...",
    data: {}
}

Erreur :

{
    success: false,
    message: "...",
    error: {}
}

---

# Codes HTTP

Toujours utiliser le bon code.

200 OK

201 Created

400 Bad Request

401 Unauthorized

403 Forbidden

404 Not Found

409 Conflict

422 Unprocessable Entity

500 Internal Server Error

---

# Validation

Toujours valider :

- body
- params
- query

Ne jamais faire confiance aux données reçues.

---

# Authentification

Les routes privées doivent être protégées.

Toujours vérifier :

- JWT
- utilisateur
- permissions

---

# Gestion des erreurs

Toujours utiliser :

try/catch

Les erreurs doivent être :

- claires
- utiles
- sans fuite d'informations sensibles

---

# Base de données

Toujours :

- limiter les requêtes
- sélectionner uniquement les champs utiles
- utiliser les index
- éviter les doublons

---

# Pagination

Les listes doivent supporter :

- page
- limit
- tri
- recherche

Éviter de retourner des milliers d'enregistrements.

---

# Logs

Journaliser :

- erreurs importantes
- connexions
- actions administrateur

Ne jamais journaliser :

- mots de passe
- tokens
- secrets
- clés API

---

# Documentation

Chaque nouvelle API doit préciser :

- son objectif
- les paramètres attendus
- les réponses possibles
- les erreurs possibles

---

# Performance

Toujours rechercher :

- requêtes inutiles
- appels multiples
- traitements coûteux
- duplication

---

# Versionnement

Prévoir un versionnement.

Exemple :

/api/v1/

/api/v2/

---

# Checklist avant livraison

☐ Route créée

☐ Contrôleur créé

☐ Service créé

☐ Validation ajoutée

☐ Authentification vérifiée

☐ Permissions vérifiées

☐ Gestion des erreurs

☐ Réponse cohérente

☐ Code HTTP correct

☐ Tests réalisés

---

# Philosophie

Une API doit être :

- prévisible
- robuste
- sécurisée
- facile à maintenir

Le frontend ne doit jamais avoir à deviner le fonctionnement de l'API.