"use strict";

/**
 * --------------------------------------------------------------------------
 * TX Core Provider HTTP Client
 * --------------------------------------------------------------------------
 * Rôle :
 * - centraliser les appels sortants vers les providers / microservices externes
 * - normaliser les erreurs
 * - injecter les headers techniques
 * --------------------------------------------------------------------------
 */

const axios = require("axios");

function cleanBaseUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

function buildInternalHeaders(req, extra = {}) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "x-request-id": req.headers["x-request-id"] || "",
    "x-internal-token":
      process.env.INTERNAL_TOKEN ||
      process.env.GATEWAY_INTERNAL_TOKEN ||
      "",
    ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
    ...extra,
  };
}

function buildProviderCallError(err, fallbackMessage = "Erreur provider") {
  const e = new Error(
    err?.response?.data?.error ||
      err?.response?.data?.message ||
      err?.message ||
      fallbackMessage
  );

  e.status = err?.response?.status || err?.status || 502;
  e.response = err?.response;
  e.providerPayload = err?.response?.data || null;
  return e;
}

async function postProvider({
  req,
  baseUrl,
  endpoint,
  payload,
  timeout = 20000,
  extraHeaders = {},
}) {
  const url = `${cleanBaseUrl(baseUrl)}${endpoint}`;

  try {
    const response = await axios.post(url, payload, {
      timeout,
      headers: buildInternalHeaders(req, extraHeaders),
    });

    return {
      status: response.status || 200,
      data: response.data || {},
    };
  } catch (err) {
    throw buildProviderCallError(err, "Erreur lors de l'appel provider");
  }
}

module.exports = {
  cleanBaseUrl,
  buildInternalHeaders,
  buildProviderCallError,
  postProvider,
};