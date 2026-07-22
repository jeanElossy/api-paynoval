# Deployment Guidelines

## Objectif

Chaque déploiement doit être :

- Fiable
- Sécurisé
- Reproductible
- Vérifiable
- Facile à maintenir

Un déploiement ne doit jamais casser une fonctionnalité existante.

---

# Philosophie

Toujours :

- déployer une version stable
- tester avant la mise en production
- documenter les changements importants
- pouvoir revenir à la version précédente si nécessaire

---

# Vérifications avant déploiement

Toujours vérifier :

☐ Aucune erreur JavaScript

☐ Aucune erreur ESLint

☐ Aucun import inutilisé

☐ Aucun console.log oublié

☐ Aucun fichier temporaire

☐ Aucun secret dans le dépôt Git

☐ Variables d'environnement configurées

☐ Application testée

---

# Variables d'environnement

Toutes les informations sensibles doivent être stockées dans :

.env

Ne jamais versionner :

.env

Toujours fournir un :

.env.example

---

# Build

Avant chaque déploiement :

- installer les dépendances
- vérifier les versions
- générer un build propre
- corriger toutes les erreurs

Le build doit réussir sans avertissement critique.

---

# Frontend Web

Toujours vérifier :

- responsive
- performances
- SEO
- accessibilité
- images optimisées
- liens fonctionnels

---

# React Native

Avant une publication :

Toujours vérifier :

- Android
- iOS
- permissions
- notifications
- caméra
- géolocalisation (si utilisée)

Tester sur un appareil réel lorsque possible.

---

# Backend

Toujours vérifier :

- routes
- authentification
- permissions
- connexions MongoDB
- variables d'environnement
- gestion des erreurs
- logs

---

# MongoDB

Avant le déploiement :

- sauvegarder les données importantes
- vérifier les index
- vérifier les migrations éventuelles

Ne jamais supprimer des données sans validation.

---

# Déploiement

Le déploiement doit être progressif.

Étapes :

1. Vérifier le projet

2. Construire l'application

3. Déployer

4. Vérifier les journaux

5. Tester les fonctionnalités principales

6. Surveiller les erreurs

---

# Surveillance

Après le déploiement :

Toujours vérifier :

- erreurs serveur
- performances
- consommation mémoire
- temps de réponse
- erreurs utilisateur

---

# Rollback

Toujours prévoir la possibilité de revenir rapidement à la version précédente si un problème critique est détecté.

---

# Documentation

Chaque déploiement doit préciser :

- la date
- les fonctionnalités ajoutées
- les corrections
- les éventuels changements importants

---

# Déploiement spécifique aux projets

## CAVA

Vérifier :

- SEO
- performances Lighthouse
- responsive
- formulaires
- navigation

---

## PayNoval

Vérifier :

- authentification
- transactions
- notifications
- API
- sécurité
- journaux
- performances

---

## Nestora

Vérifier :

- recherche
- cartes
- filtres
- images
- performances

---

## ELIA

Vérifier :

- fonctionnement des modèles IA
- API
- mémoire
- prompts
- performances
- sécurité

---

# Checklist finale

☐ Build réussi

☐ Tests réussis

☐ Variables d'environnement configurées

☐ Base de données vérifiée

☐ Déploiement terminé

☐ Vérification en production effectuée

☐ Documentation mise à jour

---

# Philosophie finale

Un déploiement est considéré comme réussi uniquement lorsque l'application fonctionne correctement en production et que les utilisateurs peuvent utiliser toutes les fonctionnalités sans régression.