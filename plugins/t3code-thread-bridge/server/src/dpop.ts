import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigError } from "./config.js";

const DEFAULT_KEY_PATH = join(
  homedir(),
  ".t3",
  "userdata",
  "secrets",
  "t3code-thread-bridge-dpop-key.json",
);

interface StoredDpopKey {
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
}

export interface DpopKey {
  privateKey: KeyObject;
  publicJwk: { kty: "EC"; crv: "P-256"; x: string; y: string };
  thumbprint: string;
}

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function validatePrivateFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ConfigError(`DPoP key must be a regular file, not a link: ${path}`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new ConfigError(`DPoP key is readable by other users: ${path}. Run chmod 600 on it.`);
  }
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    stat.uid !== process.getuid()
  ) {
    throw new ConfigError(`DPoP key is not owned by the current user: ${path}`);
  }
}

function publicJwkOf(value: JsonWebKey): DpopKey["publicJwk"] {
  if (
    value.kty !== "EC" ||
    value.crv !== "P-256" ||
    typeof value.x !== "string" ||
    typeof value.y !== "string"
  ) {
    throw new ConfigError("Stored T3 Connect DPoP key is not a P-256 key.");
  }
  return { kty: "EC", crv: "P-256", x: value.x, y: value.y };
}

export function computeDpopThumbprint(jwk: DpopKey["publicJwk"]): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return createHash("sha256").update(canonical).digest("base64url");
}

export function loadOrCreateDpopKey(
  path = process.env.T3_CONNECT_DPOP_KEY_FILE ?? DEFAULT_KEY_PATH,
): DpopKey {
  let stored: StoredDpopKey;
  if (existsSync(path)) {
    validatePrivateFile(path);
    try {
      stored = JSON.parse(readFileSync(path, "utf8")) as StoredDpopKey;
    } catch (e) {
      throw new ConfigError(`Could not read the T3 Connect DPoP key (${path}): ${e}`);
    }
  } else {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    stored = {
      privateJwk: privateKey.export({ format: "jwk" }),
      publicJwk: publicKey.export({ format: "jwk" }),
    };
    try {
      writeFileSync(path, `${JSON.stringify(stored)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      chmodSync(path, 0o600);
    } catch (e) {
      // Another bridge process may have created the key between existsSync and writeFileSync.
      if (!existsSync(path)) {
        throw new ConfigError(`Could not store the T3 Connect DPoP key (${path}): ${e}`);
      }
      validatePrivateFile(path);
      stored = JSON.parse(readFileSync(path, "utf8")) as StoredDpopKey;
    }
  }
  const publicJwk = publicJwkOf(stored.publicJwk);
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: stored.privateJwk, format: "jwk" });
  } catch (e) {
    throw new ConfigError(`Stored T3 Connect DPoP private key is invalid: ${e}`);
  }
  return { privateKey, publicJwk, thumbprint: computeDpopThumbprint(publicJwk) };
}

export function createDpopProof(input: {
  method: string;
  url: string;
  key: DpopKey;
  accessToken?: string;
  nowEpochSeconds?: number;
}): string {
  const url = new URL(input.url);
  url.search = "";
  url.hash = "";
  const header = {
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: input.key.publicJwk,
  };
  const payload = {
    htm: input.method.toUpperCase(),
    htu: url.toString(),
    jti: randomUUID(),
    iat: input.nowEpochSeconds ?? Math.floor(Date.now() / 1000),
    ...(input.accessToken
      ? { ath: createHash("sha256").update(input.accessToken).digest("base64url") }
      : {}),
  };
  const protectedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signingInput = `${protectedHeader}.${encodedPayload}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: input.key.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64Url(signature)}`;
}
