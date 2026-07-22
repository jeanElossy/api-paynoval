# Known Issues

## Objectif

Ce document répertorie les problèmes connus, les limitations actuelles et la dette technique du projet.

Avant de proposer une modification, Claude doit consulter ce document afin d'éviter de réintroduire un problème déjà identifié.

---

# Bugs critiques

Ajouter ici les bugs qui doivent être corrigés en priorité.

Exemple :

- Notifications qui ne se rafraîchissent pas automatiquement.
- Déconnexion après expiration du token.

---

# Bugs mineurs

Ajouter ici les anomalies qui n'empêchent pas le fonctionnement du projet.

Exemple :

- Mauvais alignement sur certains écrans.
- Animation saccadée sur mobile.

---

# Limitations connues

Lister ici les limitations techniques actuelles.

Exemple :

- Fonctionnalité uniquement disponible sur Android.
- API externe limitée à un certain nombre de requêtes.

---

# Dette technique

Lister ici les améliorations importantes à prévoir.

Exemple :

- Découper Dashboard.jsx en plusieurs composants.
- Refactoriser NotificationService.
- Mutualiser les composants de formulaire.

---

# Optimisations prévues

Ajouter ici les optimisations futures.

Exemple :

- Mise en cache des requêtes.
- Lazy loading des images.
- Optimisation des performances React.

---

# Points de vigilance

Toujours vérifier :

- les performances
- la sécurité
- la compatibilité mobile
- les régressions

---

# Avant chaque modification

Toujours vérifier que la modification :

- ne réintroduit pas un bug connu
- ne crée pas de nouvelle dette technique
- respecte les standards du projet

---

# Historique

Ajouter ici les bugs importants corrigés.

Exemple :

## 2026-07-15

Correction :

Problème de rafraîchissement des notifications.

Cause :

Le contexte React n'était pas mis à jour.

Solution :

Mise en place d'une mise à jour automatique après réception d'une notification.

---

# Notes

Ce document est évolutif.

Chaque bug ou limitation importante doit être documenté afin de faciliter la maintenance du projet.