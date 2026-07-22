# Décisions Techniques

## Objectif

Ce document est le **journal des décisions validées** du projet. Il existe pour une seule raison : garder une trace des choix déjà tranchés, afin que Claude (ou un nouveau développeur) ne les remette pas en question sans raison.

Avant de proposer un changement qui touche un choix déjà consigné ici, Claude doit lire ce document et respecter la décision existante.

Ce fichier ne redéfinit ni la stack ni l'architecture en détail (voir `CLAUDE.md`) ni les standards de code (voir les skills du projet). Il ne contient **que** les décisions et leur justification — pas les règles générales, qui vivent ailleurs.

---

## Principe

Une décision consignée ici est une règle du projet.

Si Claude pense qu'une meilleure solution existe, il ne modifie jamais la décision de lui-même. Il doit :

1. expliquer pourquoi la nouvelle approche serait meilleure,
2. présenter avantages et inconvénients,
3. présenter l'impact sur l'existant,
4. demander une validation explicite.

Ce n'est qu'après validation que la décision est mise à jour ici (l'ancienne étant conservée dans l'historique, jamais effacée — l'historique est utile).

---

## Comment ajouter une décision

Chaque décision importante prise en cours de projet est ajoutée dans l'historique ci-dessous, au format :

```markdown
## AAAA-MM-JJ — Titre court de la décision

**Décision :** ce qui a été décidé.

**Raison :** pourquoi ce choix plutôt qu'un autre.

**Alternatives écartées :** ce qui a été envisagé et pourquoi ça n'a pas été retenu.

**Impact :** ce que cette décision implique pour la suite (ce que les futures modifications doivent respecter).
```

Le champ « Alternatives écartées » est le plus utile à long terme : il évite de reproposer une option déjà rejetée et d'en rediscuter à chaque fois.

---

## Historique des décisions

> Ajouter les nouvelles décisions en haut de cette section (la plus récente en premier).

### Exemple de format (à remplacer par les vraies décisions)

## 2026-07-15 — Navigation web via React Router

**Décision :** utiliser React Router pour la navigation du frontend web.

**Raison :** architecture jugée la plus adaptée au projet et cohérente avec la stack React + Vite.

**Alternatives écartées :** (à compléter — ex: routing maison, autre librairie, et pourquoi).

**Impact :** toutes les nouvelles pages doivent utiliser React Router ; ne pas introduire de second mécanisme de navigation sans nouvelle décision.

---

## Notes

Ce document est vivant : chaque décision structurante doit y être ajoutée au moment où elle est prise, tant qu'elle est fraîche, pour que toute l'équipe (et Claude) partage le même contexte. Une décision non écrite ici sera tôt ou tard rediscutée inutilement.
