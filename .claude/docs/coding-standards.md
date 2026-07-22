# Coding Standards

## Objectif

Tous les projets doivent respecter un niveau de qualité professionnel.

Chaque modification doit être :

- Lisible
- Maintenable
- Sécurisée
- Performante
- Réutilisable
- Évolutive

La qualité est toujours prioritaire sur la rapidité.

---

# Principes de développement

Toujours :

- écrire un code simple et clair
- respecter l'architecture existante
- éviter la duplication (DRY)
- privilégier les composants réutilisables
- appliquer le principe de responsabilité unique (Single Responsibility)
- produire un code facile à maintenir

---

# Conventions de nommage

## Fichiers

### React

Composants :

UserCard.jsx

Pages :

HomePage.jsx

Layouts :

MainLayout.jsx

### React Native

Écrans :

HomeScreen.jsx

TransferScreen.jsx

ProfileScreen.jsx

### Hooks

useAuth.js

useNotification.js

useBalance.js

### Services

userService.js

paymentService.js

notificationService.js

### Contextes

AuthContext.jsx

ThemeContext.jsx

BalanceContext.jsx

### Backend

Routes :

authRoutes.js

userRoutes.js

Controllers :

authController.js

userController.js

Services :

authService.js

paymentService.js

Models :

User.js

Transaction.js

---

# Variables

Toujours utiliser des noms explicites.

✅

const authenticatedUser

const transactionAmount

const notificationCount

❌

const data

const obj

const test

const x

---

# Constantes

Utiliser :

const

par défaut.

Utiliser :

let

uniquement lorsque la valeur doit changer.

Ne jamais utiliser :

var

---

# Fonctions

Toujours utiliser des verbes.

Exemples :

createUser()

deleteTransaction()

updateProfile()

calculateFees()

sendNotification()

generateQRCode()

Les fonctions doivent avoir une seule responsabilité.

Éviter les fonctions très longues.

---

# JavaScript

Utiliser :

- import / export
- async / await
- Optional Chaining (?.)
- Nullish Coalescing (??)
- Destructuring
- Template Strings

Éviter :

- callbacks imbriqués
- Promise.then() lorsque async/await suffit
- fonctions de plusieurs centaines de lignes

---

# React

Toujours :

- utiliser des composants fonctionnels
- utiliser les Hooks
- créer des composants réutilisables
- découper les gros composants
- limiter les re-render inutiles
- utiliser useMemo et useCallback uniquement lorsqu'ils apportent un bénéfice réel

Éviter :

- la logique métier directement dans les composants
- les composants trop volumineux

---

# React Native

Toujours privilégier :

- Flexbox
- SafeAreaView
- StyleSheet
- FlatList
- composants réutilisables

Éviter :

- ScrollView pour de longues listes
- styles inline complexes
- logique métier dans les écrans

---

# Backend

Architecture recommandée :

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

Toute la logique doit être placée dans les services.

Les contrôleurs doivent rester simples.

---

# MongoDB / Mongoose

Toujours :

- créer des schémas clairs
- ajouter des index lorsque nécessaire
- limiter les documents volumineux
- sélectionner uniquement les champs utiles
- utiliser lean() lorsque c'est pertinent
- éviter les requêtes inutiles

---

# Gestion des erreurs

Toujours :

- utiliser try/catch
- retourner des messages d'erreur clairs
- journaliser les erreurs importantes
- gérer les cas d'échec

Ne jamais :

- laisser un catch vide
- masquer une erreur importante

---

# Sécurité

Toujours vérifier :

- validation des entrées
- authentification
- autorisations
- protection des routes sensibles
- variables d'environnement
- gestion des secrets

Ne jamais exposer :

- mots de passe
- tokens
- clés API
- secrets

---

# Performances

Toujours rechercher :

- code dupliqué
- imports inutiles
- composants inutiles
- re-render inutiles
- calculs inutiles
- appels API inutiles

Optimiser avant d'ajouter de nouvelles dépendances.

---

# Commentaires

Commenter uniquement :

- les règles métier complexes
- les décisions importantes
- les algorithmes difficiles à comprendre

Ne jamais commenter une évidence.

Le code doit être compréhensible sans commentaires inutiles.

---

# Tests

Chaque fonctionnalité importante doit être vérifiée.

Toujours tester :

- le cas normal
- les cas d'erreur
- les cas limites

Corriger les avertissements avant de terminer une tâche.

---

# Git

Les commits doivent être :

- petits
- clairs
- atomiques

Exemples :

feat(auth): add biometric login

fix(api): handle expired JWT

refactor(ui): simplify dashboard cards

docs: update authentication guide

---

# Vérifications avant chaque livraison

Toujours vérifier :

☐ Aucune erreur JavaScript

☐ Aucune erreur ESLint

☐ Aucun code mort

☐ Aucun console.log oublié

☐ Aucun import inutile

☐ Aucun composant inutilisé

☐ Pas de duplication de code

☐ Fonctionnalité testée

☐ Code documenté si nécessaire

☐ Respect de l'architecture du projet

---

# Philosophie

Toujours privilégier :

- la simplicité
- la qualité
- la lisibilité
- la sécurité
- les performances
- la réutilisabilité
- la maintenabilité

Chaque modification doit donner l'impression qu'elle a été réalisée par un développeur senior.