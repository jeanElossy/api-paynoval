# OWASP Top 10 — appliqué à Node.js/Express/MongoDB/React/React Native

Pour chaque catégorie, ce à quoi elle ressemble concrètement dans cette stack (pas la définition générique OWASP).

## 1. Broken Access Control
IDOR sur les routes Express (accès à une ressource d'un autre utilisateur via son ID), middleware d'autorisation absent ou incohérent, contrôle de rôle fait uniquement côté frontend.

## 2. Cryptographic Failures
Mots de passe hashés avec un algorithme faible ou sans salage (au lieu de bcrypt/argon2), JWT signé avec un secret faible, données sensibles transmises en clair (HTTP au lieu de HTTPS), tokens stockés en clair côté mobile.

## 3. Injection
Injection NoSQL via des objets `req.body`/`req.query` non sanitizés passés dans une requête Mongoose, usage d'`eval()`, injection XSS via du contenu utilisateur non échappé rendu côté React.

## 4. Insecure Design
Absence de rate limiting sur les endpoints d'authentification, logique métier qui suppose implicitement la bonne foi du client (ex: prix ou quantité recalculés côté frontend puis acceptés tels quels côté backend).

## 5. Security Misconfiguration
Headers de sécurité manquants (`helmet` absent), `NODE_ENV` mal configuré en production, messages d'erreur détaillés exposés en production, CORS trop permissif (`origin: '*'` sur une API avec authentification).

## 6. Vulnerable and Outdated Components
Dépendances npm obsolètes avec des CVE connues, versions de MongoDB/Node.js en fin de vie.

## 7. Identification and Authentication Failures
Tokens JWT sans expiration, absence de révocation possible, pas de limitation des tentatives de connexion, réinitialisation de mot de passe sans vérification suffisante.

## 8. Software and Data Integrity Failures
Dépendances installées depuis des sources non vérifiées, absence de vérification d'intégrité sur les mises à jour, désérialisation de données non fiables sans validation.

## 9. Security Logging and Monitoring Failures
Absence de logs sur les tentatives d'authentification échouées ou les accès refusés, pas de moyen de détecter une activité anormale a posteriori.

## 10. Server-Side Request Forgery (SSRF)
Endpoints backend qui font des requêtes HTTP vers une URL fournie par l'utilisateur sans validation (ex: proxy d'images, webhooks, intégrations tierces), permettant potentiellement d'atteindre des services internes.
