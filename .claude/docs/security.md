# Security Guidelines

## Objectif

La sécurité est une priorité absolue.

Toute nouvelle fonctionnalité doit être conçue en intégrant les bonnes pratiques de sécurité dès sa conception.

Ne jamais privilégier la rapidité au détriment de la sécurité.

---

# Règles générales

Toujours :

- valider toutes les données reçues
- nettoyer les données utilisateur
- vérifier les autorisations
- appliquer le principe du moindre privilège
- protéger les données sensibles

Ne jamais faire confiance aux données provenant du client.

---

# Authentification

Toujours :

- utiliser JWT de manière sécurisée
- vérifier l'expiration des tokens
- protéger les routes privées
- invalider les tokens si nécessaire

Ne jamais stocker un mot de passe en clair.

---

# Autorisations

Toujours vérifier :

- le rôle utilisateur
- les permissions
- les droits d'accès

Un utilisateur ne doit jamais accéder à des données qui ne lui appartiennent pas.

---

# Mots de passe

Toujours :

- utiliser bcrypt
- imposer une longueur minimale
- ne jamais afficher les mots de passe
- ne jamais enregistrer un mot de passe en clair

---

# Variables d'environnement

Toutes les informations sensibles doivent être placées dans :

.env

Exemples :

JWT_SECRET

DATABASE_URL

API_KEY

SMTP_PASSWORD

Ne jamais écrire une clé directement dans le code.

---

# Validation des données

Toujours :

- vérifier les types
- vérifier les valeurs attendues
- rejeter les données invalides

Les validations doivent être effectuées côté serveur.

---

# MongoDB

Toujours :

- utiliser Mongoose
- limiter les données retournées
- éviter les requêtes inutiles
- protéger contre les injections NoSQL

---

# API

Toutes les routes sensibles doivent :

- être authentifiées
- être autorisées
- être validées

Retourner des messages d'erreur clairs sans divulguer d'informations sensibles.

---

# Upload de fichiers

Toujours vérifier :

- le type MIME
- la taille
- l'extension
- le nom du fichier

Ne jamais exécuter un fichier envoyé par un utilisateur.

---

# Journalisation

Toujours enregistrer :

- les erreurs importantes
- les tentatives de connexion échouées
- les actions administrateur

Ne jamais enregistrer :

- les mots de passe
- les tokens
- les clés API
- les données bancaires complètes

---

# Dépendances

Avant d'installer une nouvelle bibliothèque :

- vérifier sa réputation
- vérifier sa maintenance
- vérifier les vulnérabilités connues

Éviter les dépendances inutiles.

---

# Sécurité Frontend

Toujours :

- protéger les routes privées
- masquer les informations sensibles
- éviter le stockage de données critiques en local
- sécuriser les appels API

---

# Sécurité Backend

Toujours :

- utiliser Helmet
- limiter le nombre de requêtes (Rate Limiting)
- activer CORS correctement
- gérer les erreurs proprement

---

# OWASP

Toujours vérifier les risques suivants :

- Injection
- Broken Authentication
- Sensitive Data Exposure
- Broken Access Control
- Security Misconfiguration
- Cross-Site Scripting (XSS)
- Cross-Site Request Forgery (CSRF)
- Server-Side Request Forgery (SSRF)

---

# Avant chaque livraison

Toujours vérifier :

☐ Aucun secret dans le dépôt Git

☐ Toutes les routes sensibles sont protégées

☐ Toutes les entrées sont validées

☐ Les erreurs sont correctement gérées

☐ Les permissions sont vérifiées

☐ Les dépendances sont à jour

☐ Les journaux ne contiennent aucune information sensible

---

# Philosophie

Chaque nouvelle fonctionnalité doit être conçue comme si elle allait être utilisée par des milliers d'utilisateurs.

La sécurité fait partie de la qualité du logiciel.