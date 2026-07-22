# Checklist de déploiement détaillée par cible

## Git

- Branche actuelle : bien celle attendue pour la cible (ex: `main`/`production`, pas une branche de feature).
- `git status` propre : aucun fichier non commité oublié dans le déploiement, aucun fichier sensible (`.env`) sur le point d'être commité.
- Historique récent cohérent avec ce qui est censé partir en production — pas de commit "en trop" issu d'une autre branche.
- Aucun `push --force` sur une branche partagée sans confirmation explicite de l'utilisateur.

## Frontend React (Vercel / autre hébergeur statique)

- `npm run build` (ou équivalent) réussit sans erreur ni warning bloquant.
- Variables d'environnement de production définies sur la plateforme d'hébergement (pas seulement en local dans `.env`).
- Routes testées après build (notamment les routes dynamiques, souvent oubliées en config de rewrite/hébergement statique).
- Images et assets optimisés, pas de fichier de développement (sourcemaps volumineuses, données de test) inclus dans le bundle de prod.
- Meta SEO présentes sur les pages qui en ont besoin (voir skill `create-page` si des pages ont été créées récemment sans ce point vérifié).

## React Native / Expo / EAS Build

- Version (`version` dans `app.json`/`app.config.js`) et build number (`buildNumber`/`versionCode`) incrémentés par rapport à la dernière version publiée.
- Permissions déclarées dans la config correspondent exactement à ce que l'app utilise réellement (ne pas en laisser une inutilisée, ne pas en oublier une utilisée).
- Icônes et splash screen à jour avec la dernière identité visuelle.
- Variables d'environnement/secrets gérés via EAS Secrets, jamais commités dans le repo.
- Profil de build EAS (`eas.json`) correspond à l'environnement visé (development/preview/production).
- Pour une soumission aux stores : notes de version rédigées, captures d'écran à jour si l'UI a changé significativement.

## Backend Node.js / Express

- `NODE_ENV=production` correctement défini sur l'environnement cible.
- Variables d'environnement de production distinctes de celles de dev/staging (jamais le même `JWT_SECRET`, jamais la même base de données).
- CORS restreint aux domaines réellement attendus, pas `origin: '*'` en production si l'API nécessite une authentification.
- `helmet` (ou équivalent) actif, rate limiting actif sur les endpoints sensibles.
- Logs configurés pour être exploitables en production (niveau de log adapté, pas de `console.log` de debug oublié qui fuit des données sensibles).
- Healthcheck/endpoint de statut disponible si la plateforme d'hébergement en a besoin pour le monitoring.

## MongoDB Atlas

- Connexion testée depuis l'environnement de production (IP whitelist/VPC peering correctement configurés si utilisés).
- Sauvegarde récente disponible et vérifiée **avant** toute migration ou modification de schéma en production.
- Index en place correspondant à ceux définis dans les modèles (une migration de schéma n'applique pas toujours les nouveaux index automatiquement selon la méthode utilisée).
- Si une migration de données est nécessaire : script de migration testé sur une copie/staging avant exécution en production, et procédure de rollback des données documentée.

## CI/CD (si présent)

- Pipeline vert sur la branche à déployer.
- Artefacts générés correspondent bien à la version attendue (pas un cache périmé).
- Tests automatiques passants ; ne jamais déployer en ignorant un échec de test sans que l'utilisateur en soit informé et l'accepte explicitement.

## Après déploiement

- Vérifier l'absence d'erreurs serveur nouvelles dans les logs sur les premières minutes.
- Vérifier un parcours utilisateur clé manuellement (connexion, action principale de l'app) sur l'environnement de production.
- Confirmer que le point de rollback identifié avant déploiement reste valide et accessible rapidement si un problème apparaît.
