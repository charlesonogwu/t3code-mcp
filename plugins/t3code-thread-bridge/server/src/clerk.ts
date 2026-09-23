import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ConfigError } from "./config.js";

const DEFAULT_TOKEN_PATH = join(homedir(), ".t3", "userdata", "clerk-tokens.json");
const CLERK_ORIGIN = "https://clerk.t3.codes";
const CLERK_QUERY =
  "_is_native=1&_electron_sdk_version=0.0.44&_clerk_js_version=6.32.1";
const TOKEN_KEY = "__clerk_client_jwt";
const CHROMIUM_OS_CRYPT_PREFIX = "v10";
const OS_CRYPT_NONCE_BYTES = 12;
const OS_CRYPT_TAG_BYTES = 16;

interface TokenStore {
  [TOKEN_KEY]?: string;
}

interface ClientResponse {
  response?: {
    sessions?: Array<{ id?: string; status?: string }>;
  };
  client?: {
    sessions?: Array<{ id?: string; status?: string }>;
  };
}

interface TemplateTokenResponse {
  jwt?: string;
}

function detail(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const body = value as Record<string, unknown>;
  const errors = Array.isArray(body.errors) ? body.errors : [];
  const first = errors[0] as Record<string, unknown> | undefined;
  const message = first?.long_message ?? first?.message ?? body.message;
  return typeof message === "string" ? `: ${message.slice(0, 300)}` : "";
}

function validateStore(path: string): void {
  if (!existsSync(path)) {
    throw new ConfigError(
      "No signed-in T3 Code desktop session was found. Open T3 Code and sign in to T3 Connect.",
    );
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ConfigError(`T3 Code session storage must be a regular file: ${path}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new ConfigError(`T3 Code session storage is not owned by the current user: ${path}`);
  }
}

function safeStoragePassword(): Buffer {
  const override = process.env.T3_CONNECT_SAFE_STORAGE_PASSWORD;
  if (override) return Buffer.from(override);
  if (process.platform === "linux") {
    try {
      return execFileSync("secret-tool", ["lookup", "application", "t3code"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      throw new ConfigError(
        "Could not unlock the signed-in T3 Code session from the Linux keyring. Keep T3 Code open and make sure the desktop keyring is unlocked.",
      );
    }
  }
  if (process.platform === "darwin") {
    for (const service of ["T3 Code Safe Storage", "t3code Safe Storage"]) {
      try {
        const password = execFileSync(
          "security",
          ["find-generic-password", "-w", "-s", service],
          {
            stdio: ["ignore", "pipe", "ignore"],
          },
        );
        return Buffer.from(password.toString("utf8").replace(/[\r\n]+$/, ""), "utf8");
      } catch {
        // Try the next Electron safe-storage service label.
      }
    }
    throw new ConfigError(
      "Could not unlock the signed-in T3 Code session from Keychain. Set T3_CONNECT_SAFE_STORAGE_PASSWORD if T3 Code uses a custom Keychain label.",
    );
  }
  throw new ConfigError(
    "Automatic T3 desktop-session access is not available on this platform. Set T3_CONNECT_SESSION_TOKEN or T3_CONNECT_SESSION_TOKEN_FILE.",
  );
}

function storageKey(password: Buffer): Buffer {
  return pbkdf2Sync(password, Buffer.from("saltysalt"), process.platform === "darwin" ? 1003 : 1, 16, "sha1");
}

function decryptChromiumValue(stored: string, key: Buffer): string {
  if (stored.startsWith("raw:")) return stored.slice(4);
  if (!stored.startsWith("enc:")) {
    throw new ConfigError("T3 Code session storage has an unsupported format.");
  }
  const value = Buffer.from(stored.slice(4), "base64");
  const prefix = value.subarray(0, 3).toString("ascii");
  if (prefix !== "v10" && prefix !== "v11") {
    throw new ConfigError("T3 Code session storage uses an unsupported encryption version.");
  }
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    return Buffer.concat([decipher.update(value.subarray(3)), decipher.final()]).toString("utf8");
  } catch {
    throw new ConfigError("Could not decrypt the signed-in T3 Code desktop session.");
  }
}

function runWindowsDpapi(operation: "Protect" | "Unprotect", value: Buffer): Buffer {
  const script =
    "Add-Type -AssemblyName System.Security;" +
    "$b=[Convert]::FromBase64String([Environment]::GetEnvironmentVariable('T3_BRIDGE_DPAPI_INPUT'));" +
    `$p=[System.Security.Cryptography.ProtectedData]::${operation}($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);` +
    "[Console]::Out.Write([Convert]::ToBase64String($p))";
  try {
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
        env: { ...process.env, T3_BRIDGE_DPAPI_INPUT: value.toString("base64") },
      },
    );
    return Buffer.from(output.trim(), "base64");
  } catch {
    throw new ConfigError(
      `Could not ${operation === "Protect" ? "encrypt" : "decrypt"} the signed-in T3 Code desktop session with DPAPI.`,
    );
  }
}

function windowsLocalStatePath(): string {
  if (process.env.T3_CHROMIUM_LOCAL_STATE) return process.env.T3_CHROMIUM_LOCAL_STATE;
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return join(appData, "t3code", "Local State");
}

function windowsOsCryptKey(): Buffer {
  const path = windowsLocalStatePath();
  validateStore(path);
  const state = JSON.parse(readFileSync(path, "utf8")) as {
    os_crypt?: { encrypted_key?: unknown };
  };
  const encoded = state.os_crypt?.encrypted_key;
  if (typeof encoded !== "string") {
    throw new ConfigError(`T3 Code Local State has no OSCrypt key: ${path}`);
  }
  const wrapped = Buffer.from(encoded, "base64");
  if (wrapped.subarray(0, 5).toString("ascii") !== "DPAPI") {
    throw new ConfigError("T3 Code Local State uses an unsupported OSCrypt key format.");
  }
  const key = runWindowsDpapi("Unprotect", wrapped.subarray(5));
  if (key.length !== 32) {
    throw new ConfigError("T3 Code Local State returned an invalid OSCrypt key.");
  }
  return key;
}

export function decryptWindowsOsCryptValue(value: Buffer, key: Buffer): string {
  if (value.subarray(0, 3).toString("ascii") !== CHROMIUM_OS_CRYPT_PREFIX) {
    throw new ConfigError("T3 Code session storage uses an unsupported OSCrypt version.");
  }
  if (value.length <= 3 + OS_CRYPT_NONCE_BYTES + OS_CRYPT_TAG_BYTES) {
    throw new ConfigError("T3 Code session storage contains an invalid OSCrypt value.");
  }
  const nonceStart = 3;
  const ciphertextStart = nonceStart + OS_CRYPT_NONCE_BYTES;
  const tagStart = value.length - OS_CRYPT_TAG_BYTES;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      value.subarray(nonceStart, ciphertextStart),
    );
    decipher.setAuthTag(value.subarray(tagStart));
    return Buffer.concat([
      decipher.update(value.subarray(ciphertextStart, tagStart)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new ConfigError("Could not decrypt the signed-in T3 Code OSCrypt session.");
  }
}

export function encryptWindowsOsCryptValue(value: string, key: Buffer): Buffer {
  if (key.length !== 32) throw new ConfigError("T3 Code OSCrypt key must be 32 bytes.");
  const nonce = randomBytes(OS_CRYPT_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([
    Buffer.from(CHROMIUM_OS_CRYPT_PREFIX),
    nonce,
    ciphertext,
    cipher.getAuthTag(),
  ]);
}

function decryptWindowsValue(stored: string): string {
  if (stored.startsWith("raw:")) return stored.slice(4);
  if (!stored.startsWith("enc:")) {
    throw new ConfigError("T3 Code session storage has an unsupported format.");
  }
  const value = Buffer.from(stored.slice(4), "base64");
  if (value.subarray(0, 3).toString("ascii") === CHROMIUM_OS_CRYPT_PREFIX) {
    return decryptWindowsOsCryptValue(value, windowsOsCryptKey());
  }
  return runWindowsDpapi("Unprotect", value).toString("utf8");
}

function encryptChromiumValue(value: string, key: Buffer): string {
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return `enc:${Buffer.concat([
    Buffer.from("v11"),
    cipher.update(Buffer.from(value, "utf8")),
    cipher.final(),
  ]).toString("base64")}`;
}

function encryptWindowsValue(value: string): string {
  return `enc:${encryptWindowsOsCryptValue(value, windowsOsCryptKey()).toString("base64")}`;
}

function tokenExpiry(token: string): number | undefined {
  const segments = token.split(".");
  if (segments.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function readExplicitSessionToken(): string | undefined {
  if (process.env.T3_CONNECT_SESSION_TOKEN?.trim()) {
    return process.env.T3_CONNECT_SESSION_TOKEN.trim();
  }
  const path = process.env.T3_CONNECT_SESSION_TOKEN_FILE;
  if (!path) return undefined;
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  ) {
    throw new ConfigError(`T3 Connect session token file must be a private regular file: ${path}`);
  }
  return readFileSync(path, "utf8").trim();
}

export class T3DesktopSession {
  private readonly storePath = process.env.T3_CLERK_TOKEN_FILE ?? DEFAULT_TOKEN_PATH;
  private clientJwt?: string;
  private storedValue?: string;
  private encryptionKey?: Buffer;
  private windowsDpapi = false;
  private relayJwt?: { token: string; expiresAt: number };

  private loadClientJwt(): string {
    if (this.clientJwt) return this.clientJwt;
    validateStore(this.storePath);
    const store = JSON.parse(readFileSync(this.storePath, "utf8")) as TokenStore;
    const stored = store[TOKEN_KEY];
    if (typeof stored !== "string") {
      throw new ConfigError("The T3 Code desktop session is signed out.");
    }
    this.storedValue = stored;
    if (process.platform === "win32") {
      this.windowsDpapi = true;
      this.clientJwt = decryptWindowsValue(stored);
    } else {
      const key = storageKey(safeStoragePassword());
      this.encryptionKey = key;
      this.clientJwt = decryptChromiumValue(stored, key);
    }
    return this.clientJwt;
  }

  private persistRotatedClientJwt(next: string): void {
    this.clientJwt = next;
    if ((!this.encryptionKey && !this.windowsDpapi) || !this.storedValue) return;
    const currentText = readFileSync(this.storePath, "utf8");
    const current = JSON.parse(currentText) as TokenStore;
    if (current[TOKEN_KEY] !== this.storedValue) return;
    const updatedValue = this.windowsDpapi
      ? encryptWindowsValue(next)
      : encryptChromiumValue(next, this.encryptionKey!);
    current[TOKEN_KEY] = updatedValue;
    const temporary = `${this.storePath}.t3code-thread-bridge-${process.pid}-${crypto.randomUUID()}`;
    try {
      writeFileSync(temporary, `${JSON.stringify(current, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.storePath);
      this.storedValue = updatedValue;
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  private async clerkRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
    const clientJwt = this.loadClientJwt();
    const response = await fetch(url, {
      ...init,
      headers: {
        ...init.headers,
        authorization: `Bearer ${clientJwt}`,
      },
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
    const rotated = response.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (rotated) this.persistRotatedClientJwt(rotated);
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
    if (!response.ok) {
      throw new ConfigError(
        `The signed-in T3 Code session could not authorize T3 Connect: HTTP ${response.status}${detail(body)}`,
      );
    }
    return body as T;
  }

  async relaySessionToken(): Promise<string> {
    const explicit = readExplicitSessionToken();
    if (explicit) return explicit;
    if (this.relayJwt && this.relayJwt.expiresAt > Date.now() + 30_000) return this.relayJwt.token;

    const query = `?${CLERK_QUERY}`;
    const client = await this.clerkRequest<ClientResponse>(`${CLERK_ORIGIN}/v1/client${query}`);
    const sessions = client.response?.sessions ?? client.client?.sessions ?? [];
    const session = sessions.find((item) => item.status === "active" && typeof item.id === "string");
    if (!session?.id) throw new ConfigError("T3 Code has no active signed-in desktop session.");
    const token = await this.clerkRequest<TemplateTokenResponse>(
      `${CLERK_ORIGIN}/v1/client/sessions/${encodeURIComponent(session.id)}/tokens/t3-relay${query}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "",
      },
    );
    if (typeof token.jwt !== "string") {
      throw new ConfigError("T3 Code returned an invalid T3 Connect session credential.");
    }
    this.relayJwt = {
      token: token.jwt,
      expiresAt: tokenExpiry(token.jwt) ?? Date.now() + 45_000,
    };
    return token.jwt;
  }
}
