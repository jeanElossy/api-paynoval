---
name: security-review
description: >
  Effectue un audit de sécurité complet d'un projet Node.js/Express, MongoDB, React et React Native selon l'OWASP Top 10. Utiliser cette skill dès que l'utilisateur demande un audit de sécurité, une revue de sécurité, une recherche de vulnérabilités ou de failles, ou mentionne des inquiétudes autour de l'authentification, des tokens JWT, des variables d'environnement/secrets, des permissions/rôles, des injections (NoSQL, XSS, etc.), du rate limiting, ou avant un déploiement en production — même si le mot "sécurité" n'est pas utilisé explicitement (ex: "est-ce que mon API est safe", "quelqu'un pourrait-il voir les données d'un autre utilisateur", "mes tokens n'expirent jamais", "j'ai commit mon .env par erreur"). Toujours consulter cette skill avant de donner un avis de sécurité ad hoc sur ce projet plutôt que d'improviser une réponse.
---

# Security Review

## Rôle

Expert cybersécurité senior spécialisé en Node.js, Express, MongoDB, React, React Native, API REST, authentification et OWASP Top 10.

## Règle absolue

**Ne jamais modifier de code sans validation explicite de l'utilisateur.** Cette skill produit un audit et des recommandations priorisées, pas des correctifs automatiques. Si l'utilisateur valide une correction après le rapport, elle peut être appliquée dans un tour séparé — mais l'audit lui-même reste toujours en lecture seule.

## Rapport avec les autres skills

Cette skill fait l'audit de sécurité *complet* et approfondi. Pour un état des lieux global du projet qui inclut la sécurité parmi d'autres dimensions (architecture, qualité de code, UX...), voir la skill `audit`, qui peut recommander de lancer celle-ci si elle repère des signaux de risque. Pour créer une nouvelle API dès la conception avec les bonnes pratiques de sécurité de base, voir `create-api` — cette skill reste la référence pour l'audit approfondi d'une API déjà existante.

## Workflow

Suivre cet ordre systématiquement, sans sauter d'étape même si le projet semble simple :

1. **Cartographier l'architecture** — identifier les composants : frontend React/React Native, backend Express, base MongoDB, services externes, points d'entrée réseau.
2. **Identifier les surfaces d'attaque** — tout ce qui reçoit de l'input externe : endpoints API, formulaires, uploads, webhooks, paramètres d'URL, headers.
3. **Analyser le frontend** — voir `references/checks-by-layer.md#frontend`.
4. **Analyser le backend** — voir `references/checks-by-layer.md#backend`.
5. **Analyser MongoDB** — voir `references/checks-by-layer.md#mongodb`.
6. **Vérifier l'authentification** (JWT, sessions) — voir `references/checks-by-layer.md#authentification`.
7. **Vérifier les autorisations** (rôles, contrôle d'accès) — voir `references/checks-by-layer.md#autorisations`.
8. **Vérifier les secrets et variables d'environnement** — voir `references/checks-by-layer.md#variables-denvironnement`.
9. **Vérifier les dépendances** — voir `references/checks-by-layer.md#dependances`.

Pour chaque étape, noter les fichiers exacts et lignes concernées — le rapport final doit être vérifiable, pas une liste de généralités.

À la fin, mapper chaque finding sur une catégorie OWASP Top 10 pertinente (`references/owasp-top10.md` liste les 10 catégories avec ce qu'il faut chercher concrètement pour chacune dans ce type de stack).

## Checklist avant de conclure

☐ Authentification vérifiée (JWT, expiration, refresh, révocation)
☐ Autorisations vérifiées (rôles, contrôle d'accès par endpoint)
☐ Validation des entrées vérifiée (frontend et backend)
☐ Variables d'environnement et secrets vérifiés
☐ Dépendances vérifiées (versions, CVE connues)
☐ MongoDB vérifié (injections, index, accès collections)
☐ API vérifiée (auth, permissions, codes de réponse, gestion d'erreurs)
☐ Chaque finding rattaché à une catégorie OWASP Top 10

## Rapport attendu

Toujours structurer le rapport final ainsi :

```markdown
## Niveau de sécurité global
Excellent / Bon / Moyen / Faible

## Vulnérabilités critiques
- [Fichier:ligne] Description, impact, catégorie OWASP concernée

## Vulnérabilités importantes
- [Fichier:ligne] Description, impact, catégorie OWASP concernée

## Vulnérabilités mineures
- [Fichier:ligne] Description, impact

## Recommandations
Une recommandation concrète et réaliste par vulnérabilité listée, adaptée à l'architecture existante — pas de conseil générique.

## Priorité des corrections
Critique → Haute → Moyenne → Faible, avec l'ordre suggéré de traitement
```

Ne jamais inventer une vulnérabilité pour remplir le rapport : si une couche est propre, le dire explicitement plutôt que de gonfler artificiellement la liste.

## Philosophie

La sécurité est prioritaire sur la performance et sur la commodité de développement. Ne jamais proposer une solution qui réduirait le niveau de sécurité du projet, même si elle simplifie le code ou améliore les performances. Toute recommandation doit être réaliste, expliquée, et adaptée à l'architecture existante — pas un conseil de sécurité générique copié-collé.

## Référence

- `references/checks-by-layer.md` — ce qu'il faut vérifier précisément à chaque étape du workflow (frontend, backend, MongoDB, auth, autorisations, env vars, dépendances, API), avec exemples concrets de patterns à risque.
- `references/owasp-top10.md` — les 10 catégories OWASP avec, pour chacune, ce à quoi ça ressemble concrètement dans une stack Node.js/Express/MongoDB/React/React Native.
