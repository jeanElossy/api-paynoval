# Création d'un écran

## Objectif

Créer un écran complet, moderne, performant et cohérent avec le Design System du projet.

Un écran n'est pas uniquement une interface graphique.

Il représente une fonctionnalité complète de l'application.

Chaque écran doit être :

- intuitif
- réutilisable
- performant
- accessible
- responsive
- sécurisé

---

# Workflow obligatoire

Toujours respecter cet ordre.

---

## 1. Comprendre le besoin

Identifier :

- l'objectif métier
- les utilisateurs concernés
- les actions possibles
- les données affichées
- les contraintes techniques

Si une information est manquante, poser les questions nécessaires.

---

## 2. Vérifier l'existant

Analyser :

- les écrans similaires
- les composants disponibles
- les Hooks existants
- les Contexts
- les Services
- les APIs

Toujours privilégier la réutilisation.

---

## 3. Définir la structure

Identifier :

- Header
- Corps
- Footer
- Navigation
- États de chargement
- États vides
- États d'erreur
- Modales
- Dialogues

---

## 4. Définir les données

Lister :

- données affichées
- données modifiables
- appels API
- états React
- Context utilisés

---

## 5. Définir les composants

Identifier :

- composants existants
- nouveaux composants nécessaires
- composants réutilisables

Créer de nouveaux composants uniquement lorsque cela est justifié.

---

## 6. Vérifier la navigation

Toujours contrôler :

- paramètres
- retour arrière
- Deep Linking
- gestion des erreurs
- navigation protégée

---

## 7. Performance

Toujours rechercher :

- re-render inutiles
- FlatList
- mémorisation
- lazy loading
- optimisation des images
- optimisation des appels API

---

## 8. Sécurité

Toujours vérifier :

- authentification
- autorisations
- validation des données
- informations sensibles
- permissions

---

## 9. UX/UI

Toujours respecter :

- le Design System
- la palette de couleurs
- la typographie
- les espacements
- les composants communs

L'écran doit être cohérent avec le reste de l'application.

---

## 10. Responsive

Toujours vérifier :

- petits smartphones
- grands smartphones
- tablettes
- mode paysage si nécessaire

---

## 11. Accessibilité

Toujours contrôler :

- taille des zones tactiles
- contraste
- labels
- lecteurs d'écran
- navigation clavier (Web)

---

## 12. Gestion des états

Prévoir :

- Loading
- Empty State
- Error State
- Success State
- Offline State

Chaque état doit être clairement identifié.

---

## 13. Tests

Toujours prévoir :

- affichage
- navigation
- interactions
- erreurs
- cas limites

---

## 14. Documentation

Documenter :

- objectif
- navigation
- composants utilisés
- dépendances
- APIs utilisées

---

# Rapport attendu

Toujours terminer par :

## Écran créé

...

---

## Fonction

...

---

## Composants utilisés

...

---

## Nouveaux composants

...

---

## APIs utilisées

...

---

## Navigation

...

---

## Optimisations

...

---

## Sécurité

...

---

## Tests

...

---

## Recommandations

...

---

# Checklist

☐ Architecture respectée

☐ Design System respecté

☐ Responsive

☐ Accessible

☐ Performances vérifiées

☐ Navigation vérifiée

☐ Sécurité vérifiée

☐ États gérés

☐ Tests prévus

☐ Documentation créée

---

# Livrables attendus

Lorsque tu crées un nouvel écran, générer si nécessaire :

- Le fichier de l'écran (`HomeScreen.jsx`, `ProfileScreen.jsx`, etc.)
- Les composants associés
- Les Hooks personnalisés
- Les appels API
- Les styles
- Les constantes
- Les validations
- Les tests
- La documentation

Ne jamais générer uniquement le fichier principal si d'autres fichiers sont nécessaires.

---

# Philosophie

Un écran représente une expérience utilisateur complète.

Il doit être :

- clair
- rapide
- agréable
- cohérent
- évolutif
- facile à maintenir

Tu refuses de créer un écran qui ne respecte pas l'architecture, le Design System ou les standards de qualité du projet.