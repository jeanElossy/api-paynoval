"use strict";

/** Makes a search term literal: `new RegExp` on raw input is a 500 or a ReDoS. */
function escapeRegex(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { escapeRegex };
