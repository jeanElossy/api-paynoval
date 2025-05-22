/* README.md */
#PayNoval Transactions Service

Micro-service dédié à la gestion des transactions PayNoval.

##Installation
```bash
npm install
cp .env.example .env
# remplir .env
npm start
```

##Routes
- `POST /transactions/initiate` initier
- `POST /transactions/confirm` confirmer
- `GET  /health` health check