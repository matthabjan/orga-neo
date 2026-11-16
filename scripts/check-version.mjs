// Check that package.json, src-tauri/Cargo.toml and src-tauri/tauri.conf.json
// carry the same version, and that it matches the release tag.
//
//   npm run release -- v0.2.0   check against a tag you are about to create
//   npm run release             in CI the tag comes from GITHUB_REF_NAME;
//                               locally it only checks that the three files agree

import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const found = {
  "package.json": JSON.parse(read("package.json")).version,
  "src-tauri/Cargo.toml": read("src-tauri/Cargo.toml").match(/^\[package\][^[]*?^version\s*=\s*"([^"]+)"/m)?.[1],
  "src-tauri/tauri.conf.json": JSON.parse(read("src-tauri/tauri.conf.json")).version,
};

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  for (const [file, v] of Object.entries(found)) console.error(`    ${file}: ${v ?? "(no version found)"}`);
  process.exit(1);
};

const versions = new Set(Object.values(found));
if (versions.size !== 1 || versions.has(undefined)) fail("The versions differ.");
const version = found["package.json"];

const tag = process.argv[2] ?? (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined);
if (tag) {
  if (tag !== `v${version}`) fail(`Tag ${tag} does not match version ${version} (expected tag v${version}).`);
  console.log(`✓ Tag ${tag} matches the version in all three files.`);
} else {
  console.log(`✓ All three files are at version ${version}. Tag it with: git tag -a v${version} -m "Was ist neu"`);
}
