#!/usr/bin/env node
// Signs index.json so the app's catalogue signature check passes.
//
// The verified payload is the index WITHOUT `signature`, re-encoded exactly as
// Swift does (`JSONEncoder` with .sortedKeys and .withoutEscapingSlashes):
// keys sorted, no whitespace, slashes unescaped, nil optionals omitted,
// generatedAt as yyyy-MM-dd'T'HH:mm:ss'Z'.
//
// usage: node scripts/sign-index.mjs [--key <pem>] [index.json]
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const keyFlag = args.indexOf("--key");
const keyPath = keyFlag >= 0 ? args[keyFlag + 1] : process.env.SIGNING_KEY || ".signing-key.pem";
const indexArg = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--key");
const indexPath = path.resolve(indexArg || "index.json");

function loadOrCreateKey(file) {
  if (existsSync(file)) {
    const pem = readFileSync(file);
    return { privateKey: createPrivateKey(pem), publicKeyRaw: rawPublic(createPublicKey(pem)) };
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }));
  chmodSync(file, 0o600);
  return { privateKey, publicKeyRaw: rawPublic(publicKey) };
}

// Ed25519 SPKI DER always ends with the 32-byte raw key.
function rawPublic(keyObject) {
  const der = keyObject.export({ type: "spki", format: "der" });
  return Buffer.from(der.subarray(der.length - 32));
}

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
    return out;
  }
  return value;
};

const iso = (raw) => {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid generatedAt: ${raw}`);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
};

const asset = (a) => ({ path: a.path, sha256: a.sha256 });

function canonical(index, publicKey) {
  const repository = {
    id: index.repository.id,
    name: index.repository.name,
    owner: index.repository.owner,
    homepage: index.repository.homepage,
    universalLink: index.repository.universalLink,
  };
  if (publicKey) repository.publicKey = publicKey;
  const modules = index.modules.map((m) => {
    const entry = {
      id: m.id,
      familyID: m.familyID,
      name: m.name,
      version: m.version,
      language: m.language,
      contentType: m.contentType,
      contentRating: m.contentRating,
      releaseTrack: m.releaseTrack,
      status: m.status,
      manifest: asset(m.manifest),
      icon: asset(m.icon),
    };
    if (m.sortPriority !== undefined && m.sortPriority !== null) entry.sortPriority = m.sortPriority;
    return entry;
  });
  return {
    schemaVersion: index.schemaVersion,
    generatedAt: iso(index.generatedAt),
    repository,
    modules,
  };
}

const { privateKey, publicKeyRaw } = loadOrCreateKey(keyPath);
const publicKey = publicKeyRaw.toString("base64");
const index = JSON.parse(readFileSync(indexPath, "utf8"));
const payload = Buffer.from(JSON.stringify(stable(canonical(index, publicKey))), "utf8");
const signature = edSign(null, payload, privateKey).toString("base64");

index.repository.publicKey = publicKey;
index.signature = signature;
writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
console.log(`signed ${path.basename(indexPath)} (${index.modules.length} modules, payload ${payload.length}B, key ${keyPath})`);