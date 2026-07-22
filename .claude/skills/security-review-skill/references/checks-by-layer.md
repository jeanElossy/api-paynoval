# Vérifications détaillées par couche

## Frontend (React / React Native)

- **Stockage des tokens** : `localStorage`/`sessionStorage` pour un JWT côté web = vulnérable au XSS. Sur React Native, `AsyncStorage` seul n'est pas chiffré — préférer `expo-secure-store` ou `react-native-keychain` pour les tokens.
- **Protection des routes** : vérifier que les routes/écrans sensibles contrôlent bien l'état d'authentification côté client ET que le backend revalide (le frontend seul n'est jamais une barrière de sécurité).
- **Validation des formulaires** : la validation côté client est un confort UX, jamais une garantie — vérifier qu'elle est dupliquée côté backend.
- **Gestion des erreurs** : les messages d'erreur affichés à l'utilisateur ne doivent jamais exposer de détails d'implémentation (stack trace, requête SQL/Mongo, chemin serveur).
- **Exposition d'informations sensibles** : chercher des clés API, secrets ou URLs internes codées en dur dans le code frontend (bundlé et donc lisible par n'importe qui).

## Backend (Express)

- **Validation des entrées** : chaque route qui reçoit du `body`/`query`/`params` doit valider le type, le format et les bornes (ex: `express-validator`, `zod`, `joi`) — pas juste vérifier la présence du champ.
- **Contrôle des permissions** : chaque route protégée doit vérifier explicitement le rôle/la propriété de la ressource, pas seulement la présence d'un token valide (ex: un user A peut-il modifier une ressource de l'user B en changeant juste l'ID dans l'URL ?).
- **Authentification** : vérifier que le middleware d'auth est bien appliqué à toutes les routes sensibles, pas seulement à certaines (chercher les routes qui l'auraient "oublié").
- **Gestion des erreurs** : un handler d'erreur global qui ne fuit pas la stack trace en production (`NODE_ENV=production`).
- **Protection contre les injections** : recherche de concaténation de strings dans des requêtes, d'usage de `eval`, de `$where` MongoDB avec de l'input utilisateur.
- **Rate limiting** : présence de `express-rate-limit` ou équivalent sur les endpoints sensibles (login, reset password, endpoints coûteux) pour limiter le brute-force et le credential stuffing.

## MongoDB

- **Injections NoSQL** : chercher les cas où un objet venant directement de `req.body`/`req.query` est passé tel quel dans une requête Mongoose/MongoDB (permet d'injecter des opérateurs comme `$gt`, `$ne`, `$where`). Vérifier la sanitization (ex: `express-mongo-sanitize`).
- **Validations** : les schémas Mongoose définissent-ils bien `required`, `type`, et des validateurs métier, ou est-ce que tout est accepté ?
- **Index** : présence d'index sur les champs utilisés pour l'authentification/autorisation (ex: `email` unique) pour éviter les incohérences et les attaques par timing.
- **Accès aux collections** : vérifier qu'aucune route n'expose une opération de lecture/écriture non filtrée par utilisateur (ex: `find()` sans filtre `{ userId: req.user.id }` là où c'est attendu).
- **Protection des données** : les champs sensibles (mots de passe, tokens) sont-ils exclus des réponses API par défaut (`select: false` côté schéma, ou `.select('-password')` systématique) ?

## Authentification

- **JWT — algorithme et secret** : vérifier que l'algorithme n'est pas `none`, que le secret n'est pas hardcodé dans le code, et qu'il a une entropie suffisante.
- **Durée de vie des tokens** : un access token sans `expiresIn` (ou avec une durée très longue) est un risque — vérifier la présence et la valeur de l'expiration.
- **Refresh token** : stocké de façon sécurisée (httpOnly cookie côté web, stockage sécurisé côté mobile), avec rotation à chaque utilisation si possible.
- **Révocation** : existe-t-il un mécanisme pour invalider un token compromis avant son expiration (blacklist, versioning des tokens) ?
- **Protection contre l'usurpation** : le payload du JWT est-il vérifié côté serveur à chaque requête (pas seulement décodé et fait confiance) ?

## Autorisations

- **Rôles** : le modèle de rôles est-il appliqué de façon cohérente sur toutes les routes qui en ont besoin ?
- **Permissions** : distinction claire entre "authentifié" et "autorisé à faire cette action précise sur cette ressource précise".
- **Contrôle d'accès** : recherche spécifique d'IDOR (Insecure Direct Object Reference) — un utilisateur peut-il accéder aux données d'un autre en modifiant un ID dans la requête ?
- **Endpoints protégés** : lister les endpoints qui devraient être protégés et vérifier qu'aucun n'a été oublié (comparer la liste des routes au middleware appliqué).

## Variables d'environnement

- **Secrets en dur** : recherche de clés API, mots de passe, `JWT_SECRET` codés en dur dans le code source plutôt que dans `.env`.
- **`.env` versionné** : vérifier que `.env` est bien dans `.gitignore` et n'a jamais été commité (y compris dans l'historique git).
- **Secrets par défaut** : des valeurs par défaut faibles ou de démonstration (`"secret"`, `"changeme"`) laissées dans le code de fallback.
- **Séparation des environnements** : les secrets de production ne doivent jamais être identiques à ceux de dev/staging.

Ne jamais afficher la valeur réelle d'un secret trouvé dans le rapport — signaler uniquement sa présence et son emplacement.

## Dépendances

- **Bibliothèques obsolètes** : comparer les versions installées aux dernières versions stables.
- **Vulnérabilités connues** : s'appuyer sur les avis de sécurité connus pour les dépendances identifiées (ex: `npm audit` si disponible dans l'environnement).
- **Dépendances inutiles** : signaler les packages présents mais non utilisés dans le code, qui élargissent la surface d'attaque sans bénéfice.

## API

- **Validation** : cohérence avec les vérifications backend ci-dessus, au niveau du contrat d'API dans son ensemble.
- **Authentification** : chaque endpoint documente/applique-t-il clairement son niveau d'accès requis ?
- **Permissions** : cohérence avec la section Autorisations ci-dessus.
- **Réponses HTTP** : les codes de statut sont-ils cohérents (401 vs 403 vs 404) sans fuiter d'information (ex: ne pas révéler qu'une ressource existe via un 403 alors qu'un 404 serait plus sûr) ?
- **Erreurs** : format d'erreur cohérent qui ne fuit pas de détails internes.
