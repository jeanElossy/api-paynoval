"use strict";

const { AsyncLocalStorage } = require("async_hooks");

/** Carries the request id across `await`, without threading it through calls. */
const storage = new AsyncLocalStorage();

function requestContextMiddleware(req, _res, next) {
  storage.run({ requestId: req.id || null }, next);
}

const currentRequestId = () => storage.getStore()?.requestId || null;

module.exports = { currentRequestId, requestContextMiddleware };
