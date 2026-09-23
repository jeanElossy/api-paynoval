# syntax=docker/dockerfile:1
#
# Image de production — préparée le 2026-09-23 pour OVH Public Cloud.
#
# ⚠️ UNE SEULE IMAGE, PLUSIEURS RÔLES. Le web service et ses workers dédiés
# tournent à partir de la MÊME image ; seule la commande change :
#
#   web service   : node src/server.js            (défaut)
#   consommateurs : node workers/all.js            (bus : notifications, risque, règlement, parrainage)
#
# Une image par rôle ferait diverger le code du web et celui des workers au
# premier déploiement partiel — le web en version N, les workers en N-1, avec un
# contrat d'événement qui n'est plus le même des deux côtés.
#
# Guide : docs/deployment/ovh/isolation.md (dépôt racine Projet_PayNoval).

# ---- Dépendances ------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV NODE_ENV=production

# Le lockfile seul d'abord : la couche des dépendances n'est reconstruite que
# lorsqu'il change, pas à chaque modification de code.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- Exécution --------------------------------------------------------------
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

# tini en PID 1 : sans lui, SIGTERM n'atteint pas Node de façon fiable, et les
# workers ne vont pas au bout de leur arrêt propre (acquitter le tour en cours).
# Un arrêt sec fait relivrer du travail déjà fait à chaque redéploiement.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .

# Jamais root : une faille dans une dépendance ne doit pas obtenir le conteneur.
USER node

ENTRYPOINT ["/usr/bin/tini", "--"]

# `node`, PAS `npm start` : npm ne relaie pas SIGTERM de façon fiable.
CMD ["node", "src/server.js"]
