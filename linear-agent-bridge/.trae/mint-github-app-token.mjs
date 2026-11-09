#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const APP_NAME = process.env.TRAE_GITHUB_APP_NAME || process.env.GITHUB_APP_NAME || "revrebel-trae";
const APP_ID = process.env.TRAE_GITHUB_APP_ID || process.env.GITHUB_APP_ID || "5660644";

function resolveKeyPath(value) {
  if (!value) return path.join(os.homedir(), ".trae/credentials/github-rebel-trae.private-key.pem");
  if (value === "~" || value.startsWith("~/")) return path.join(os.homedir(), value.slice(1));
  return path.isAbsolute(value) ? value : path.join(os.homedir(), value);
}

const KEY_PATH = resolveKeyPath(process.env.TRAE_GITHUB_APP_KEY_PATH || process.env.GITHUB_APP_KEY_PATH);

function base64url(value) {
  return value.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function createJwt(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64url(Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId })));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${base64url(signer.sign(privateKey))}`;
}

async function getInstallationToken() {
  let privateKey = process.env.TRAE_GITHUB_APP_PRIVATE_KEY || process.env.GITHUB_APP_PRIVATE_KEY;
  if (!privateKey) privateKey = await fs.readFile(KEY_PATH, "utf8");
  const jwt = createJwt(APP_ID, privateKey);
  const headers = {
    Authorization: `Bearer ${jwt}`,
    Accept: "application/vnd.github+json",
    "User-Agent": APP_NAME,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const installationsResponse = await fetch("https://api.github.com/app/installations", { headers });
  if (!installationsResponse.ok) {
    throw new Error(`Failed to list installations (${installationsResponse.status})`);
  }
  const installations = await installationsResponse.json();
  if (!Array.isArray(installations) || installations.length === 0) {
    throw new Error("No installations found for GitHub App");
  }
  const installationId = process.env.TRAE_GITHUB_INSTALLATION_ID || installations[0].id;
  const tokenResponse = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    { method: "POST", headers },
  );
  if (!tokenResponse.ok) {
    throw new Error(`Failed to create installation token (${tokenResponse.status})`);
  }
  const result = await tokenResponse.json();
  if (!result.token) throw new Error("GitHub returned no installation token");
  return result.token;
}

async function readCredentialRequest() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return Object.fromEntries(
    input.split(/\r?\n/).filter(Boolean).map((line) => {
      const index = line.indexOf("=");
      return index === -1 ? [line, ""] : [line.slice(0, index), line.slice(index + 1)];
    }),
  );
}

async function main() {
  if (process.argv[2] === "credential") {
    const operation = process.argv[3];
    const request = await readCredentialRequest();
    if (operation !== "get" || (request.host && request.host !== "github.com")) return;
    const token = await getInstallationToken();
    process.stdout.write(`username=x-access-token\npassword=${token}\n\n`);
    return;
  }
  process.stdout.write(await getInstallationToken());
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
