"use strict";
const { readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { execFileSync } = require("node:child_process");
let count = 0;
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      [
        "node_modules",
        ".git",
        "data",
        "credentials",
        "fabric-samples",
        "test-results",
      ].includes(entry.name)
    )
      continue;
    const file = join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (file.endsWith(".js")) {
      execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
      count++;
    } else if (file.endsWith(".json")) {
      JSON.parse(readFileSync(file, "utf8"));
      count++;
    } else if (file.endsWith(".sh")) {
      execFileSync("bash", ["-n", file]);
      count++;
    }
  }
}
walk(".");
console.log(`Syntax and JSON checks passed for ${count} files.`);
