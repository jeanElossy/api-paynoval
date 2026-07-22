# Architecture du projet

## Objectif

Ce document décrit l'organisation générale du projet.

Claude doit toujours respecter cette architecture avant de créer ou modifier du code.

---

# Structure générale

Le projet est organisé par responsabilités.

Chaque dossier possède une fonction précise.

Exemple :

src/

assets/

components/

pages/

layouts/

hooks/

context/

services/

utils/

constants/

styles/

---

# Organisation

## assets

Contient :

- images
- icônes
- logos
- illustrations
- vidéos
- polices

---

## components

Contient uniquement des composants réutilisables.

Exemples :

Button

Card

Modal

Navbar

Footer

Input

---

## pages

Contient les pages principales du projet.

Une page correspond généralement à une route.

---

## layouts

Contient les mises en page communes.

Exemples :

MainLayout

DashboardLayout

AdminLayout

---

## hooks

Contient les Hooks personnalisés.

Exemples :

useAuth

useApi

useNotification

---

## context

Contient les Context API.

Ne jamais y placer de logique métier complexe.

---

## services

Contient :

- appels API
- logique métier réutilisable
- services externes

---

## utils

Fonctions utilitaires.

Aucune dépendance au framework.

---

## constants

Valeurs constantes.

Exemples :

routes

colors

config

roles

permissions

---

## styles

Styles globaux.

Les styles spécifiques restent proches des composants.

---

# Flux de données

Frontend

↓

Services

↓

API

↓

Backend

↓

MongoDB

---

# Règles

Toujours respecter cette organisation.

Ne jamais déplacer plusieurs dossiers sans validation.

Créer un nouveau dossier uniquement lorsqu'il apporte une vraie valeur.

---

# Architecture Backend

Le backend suit l'organisation suivante :

routes/

controllers/

services/

models/

middlewares/

utils/

config/

---

# Principe

Chaque fichier doit avoir une seule responsabilité.

Une fonctionnalité complexe doit être découpée en plusieurs modules.

---

# Objectif

Maintenir une architecture claire, évolutive et facile à comprendre pour tous les développeurs.