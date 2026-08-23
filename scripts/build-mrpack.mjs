#!/usr/bin/env node
// Builds a single edition's .mrpack from config.json by resolving every
// mod/resourcepack against the Modrinth API. No jars are downloaded here —
// mrpack files only need URLs + hashes, and Modrinth's version endpoint
// already returns both, which keeps this job fast and cheap to run.

import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import yaml from "js-yaml";

const MODRINTH_API = "https://api.modrinth.com/v2";
const USER_AGENT = "shine-alternative-modpack-ci/1.0 (github actions build script)";

const edition = process.argv[2];
if (!edition) {
  console.error("Usage: node build-mrpack.mjs <edition>");
  process.exit(1);
}

// EXCLUDE_MODS: comma-separated Modrinth ids/slugs, set via workflow_dispatch
// input for one-off custom builds without touching config.json.
const excluded = new Set(
  (process.env.EXCLUDE_MODS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

const config = yaml.load(await fs.readFile("config.yaml", "utf-8"));
const editionDef = config.editions[edition];
if (!editionDef) {
  console.error(`Unknown edition "${edition}". Known: ${Object.keys(config.editions).join(", ")}`);
  process.exit(1);
}

async function mrFetch(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

// Resolves one Modrinth project id to a concrete file entry for this edition's
// game version + loader. Resource packs use loader "minecraft" on Modrinth.
async function resolveItem(id, kind) {
  const loaderParam = kind === "resourcepack" ? "minecraft" : editionDef.loader;
  const versionsUrl =
    `${MODRINTH_API}/project/${id}/version` +
    `?loaders=${encodeURIComponent(JSON.stringify([loaderParam]))}` +
    `&game_versions=${encodeURIComponent(JSON.stringify([editionDef.minecraftVersion]))}`;

  const versions = await mrFetch(versionsUrl);
  if (!versions.length) {
    throw new Error(
      `No ${loaderParam} build of "${id}" for ${editionDef.minecraftVersion}. ` +
      `Either drop it from this edition in config.json or fix the version pin.`
    );
  }

  const latest = versions[0]; // Modrinth returns newest-first
  const file = latest.files.find((f) => f.primary) || latest.files[0];

  const project = await mrFetch(`${MODRINTH_API}/project/${id}`);

  const dir = kind === "resourcepack" ? "resourcepacks" : "mods";
  return {
    path: `${dir}/${file.filename}`,
    hashes: { sha1: file.hashes.sha1, sha512: file.hashes.sha512 },
    downloads: [file.url],
    fileSize: file.size,
    env: {
      client: project.client_side, // "required" | "optional" | "unsupported"
      server: project.server_side,
    },
  };
}

async function fetchFabricLoaderVersion(mcVersion) {
  const rows = await mrFetch(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`);
  const stable = rows.find((r) => r.loader.stable) || rows[0];
  return stable.loader.version;
}

const wanted = (list, kind) =>
  list.filter((m) => m.editions.includes(edition) && !excluded.has(m.id)).map((m) => ({ ...m, kind }));

const items = [...wanted(config.mods, "mod"), ...wanted(config.resourcepacks, "resourcepack")];

console.log(`Building "${editionDef.name}" — ${items.length} items for ${editionDef.minecraftVersion} (${editionDef.loader})`);
if (excluded.size) console.log(`Excluded this run: ${[...excluded].join(", ")}`);

const files = [];
const skipped = [];
for (const item of items) {
  try {
    files.push(await resolveItem(item.id, item.kind));
    console.log(`  ok    ${item.id}`);
  } catch (err) {
    // Don't let one missing port fail the whole edition — report and continue.
    skipped.push({ id: item.id, reason: err.message });
    console.log(`  skip  ${item.id} — ${err.message}`);
  }
}

const loaderKey = { fabric: "fabric-loader", quilt: "quilt-loader", forge: "forge", neoforge: "neoforge" }[editionDef.loader];
const loaderVersion = editionDef.loader === "fabric" ? await fetchFabricLoaderVersion(editionDef.minecraftVersion) : "unpinned";

const manifest = {
  formatVersion: 1,
  game: "minecraft",
  versionId: `${edition}-${new Date().toISOString().slice(0, 10)}`,
  name: editionDef.name,
  summary: editionDef.summary,
  files,
  dependencies: {
    minecraft: editionDef.minecraftVersion,
    [loaderKey]: loaderVersion,
  },
};

const buildDir = path.join("build", edition);
await fs.mkdir(buildDir, { recursive: true });
await fs.writeFile(path.join(buildDir, "modrinth.index.json"), JSON.stringify(manifest, null, 2));

// Static overrides (configs, options.txt, etc.) live in /overrides at repo root
// and get copied in as-is — same convention the Modrinth App uses.
try {
  await fs.cp("overrides", path.join(buildDir, "overrides"), { recursive: true });
} catch {
  await fs.mkdir(path.join(buildDir, "overrides"), { recursive: true });
}

const mrpackName = `${edition}.mrpack`;
execSync(`zip -r -X "../${mrpackName}" modrinth.index.json overrides`, { cwd: buildDir, stdio: "inherit" });

if (skipped.length) {
  await fs.writeFile(path.join(buildDir, "skipped.json"), JSON.stringify(skipped, null, 2));
  console.log(`\n${skipped.length} item(s) skipped — see build/${edition}/skipped.json`);
}

console.log(`\nWrote build/${mrpackName} (${files.length} files packed)`);
