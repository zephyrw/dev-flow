#!/usr/bin/env node
import { existsSync, copyFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const src = resolve("packages/installer/src/entry-template.mjs");
const dest = resolve("dist/packages/installer/src/entry-template.mjs");

if (!existsSync(src)) {
  console.error("Missing source entry template: " + src);
  process.exit(1);
}

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log("✓ Built entry-template.mjs to dist/packages/installer/src/entry-template.mjs");
