"use strict";

/**
 * A search box must not reach `new RegExp` raw: `(` answers a 500 and a crafted
 * pattern can hold the event loop of the service that moves the money.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { escapeRegex } = require("../src/utils/escapeRegex");

test("a search term is taken literally", () => {
  assert.doesNotThrow(() => new RegExp(escapeRegex("(unclosed")));
  assert.ok(new RegExp(escapeRegex("a.b")).test("a.b"));
  assert.equal(new RegExp(escapeRegex("a.b")).test("axb"), false);
  assert.equal(escapeRegex(null), "");
});

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(full);
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

test("no controller builds a RegExp from the raw query", () => {
  const root = path.join(__dirname, "..", "src", "controllers");
  const offenders = jsFiles(root).filter((file) =>
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .some((line) => !/^\s*(\/\/|\*)/.test(line) && /new RegExp\(\s*String\((req\.query\.)?q\)/.test(line))
  );
  assert.deepEqual(offenders, []);
});
