import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigError } from "./config.js";
import { T3DesktopSession } from "./clerk.js";
import { createDpopProof, loadOrCreateDpopKey, type DpopKey } from "./dpop.js";

const DEFAULT_RELAY_URL = "https://relay.t3.codes";
const DEFAULT_TOKEN_ENDPOINT = "https://clerk.t3.codes/oauth/token";
const DEFAULT_CLI_CLIENT_ID = "hzxSgY2cH10sDU2r";
const DEFAULT_CLOUD_TOKEN_PATH = join(
  homedir(),
  ".t3",
  "userdata",
  "secrets",
  "cloud-cli-oauth-token.bin",
);
const REFRESH_EARLY_MS = 5 * 60_000;
const AUTH_SCOPES = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
  "relay:read",
].join(" ");

export class T3ConnectError extends Error {}

export interface CloudCredential {
  accessToken: string;
  refreshToken: string;
  expiresAtEpochMs: number;
  identity?: string;
}

export interface RelayEnvironment {
  environmentId: string;
  label: string;
  endpoint: { httpBaseUrl: string; wsBaseUrl?: string; providerKind?: string };
  linkedAt: string;
}

interface RelayToken {
  accessToken: string;
  expiresAtEpochMs: number;
}

interface EnvironmentToken {
  accessToken: string;
  expiresAtEpochMs: number;
  origin: string;
}

function safeErrorDetail(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const body = value as Record<string, unknown>;
  for (const key of ["error_description", "message", "reason", "code", "error", "_tag"]) {
    if (typeof body[key] === "string") return `: ${String(body[key]).slice(0, 300)}`;
  }
  return "";
}

async function fetchJson<T>(url: string, init: RequestInit, action: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new T3ConnectError(`${action} failed: ${(e as Error).message}`);
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (!response.ok) {
    throw new T3ConnectError(`${action} failed: HTTP ${response.status}${safeErrorDetail(body)}`);
  }
  return body as T;
}

function validatePrivateFile(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ConfigError(`${label} must be a regular file, not a link: ${path}`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new ConfigError(`${label} is readable by other users: ${path}. Run chmod 600 on it.`);
  }
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    stat.uid !== process.getuid()
  ) {
    throw new ConfigError(`${label} is not owned by the current user: ${path}`);
  }
}

function decodeCredential(text: string, path: string): CloudCredential {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`Could not parse the T3 Connect login (${path}): ${e}`);
  }
  const token = value as Partial<CloudCredential>;
  if (
    !token ||
    typeof token.accessToken !== "string" ||
    typeof token.refreshToken !== "string" ||
    typeof token.expiresAtEpochMs !== "number"
  ) {
    throw new ConfigError(`T3 Connect login has an unexpected format: ${path}`);
  }
  return token as CloudCredential;
}

function readCredential(path: string): { token: CloudCredential; mtimeMs: number } {
  if (!existsSync(path)) {
    throw new ConfigError(
      "No T3 Connect login found. In T3 Code, enable T3 Connect, or run `t3 connect login`.",
    );
  }
  validatePrivateFile(path, "T3 Connect login");
  return {
    token: decodeCredential(readFileSync(path, "utf8"), path),
    mtimeMs: statSync(path).mtimeMs,
  };
}

function persistCredential(path: string, token: CloudCredential): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.t3code-thread-bridge-${process.pid}-${crypto.randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(token)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export class T3ConnectClient {
  readonly relayUrl = (process.env.T3CODE_RELAY_URL ?? DEFAULT_RELAY_URL).replace(/\/$/, "");
  private readonly tokenPath = process.env.T3_CONNECT_TOKEN_FILE ?? DEFAULT_CLOUD_TOKEN_PATH;
  private readonly key: DpopKey;
  private readonly desktopSession = new T3DesktopSession();
  private relayToken?: RelayToken;
  private relayTokenPromise?: Promise<string>;
  private readonly environmentTokens = new Map<string, EnvironmentToken>();
  private refreshPromise?: Promise<CloudCredential>;

  constructor() {
    this.key = loadOrCreateDpopKey();
  }

  private async refreshCredential(token: CloudCredential, observedMtimeMs: number) {
    const current = readCredential(this.tokenPath);
    if (
      current.mtimeMs !== observedMtimeMs &&
      current.token.expiresAtEpochMs > Date.now() + REFRESH_EARLY_MS
    ) {
      return current.token;
    }
    const endpoint = process.env.T3CODE_CLERK_TOKEN_ENDPOINT ?? DEFAULT_TOKEN_ENDPOINT;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.token.refreshToken || token.refreshToken,
      client_id: process.env.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID ?? DEFAULT_CLI_CLIENT_ID,
    });
    const response = await fetchJson<{
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    }>(
      endpoint,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      },
      "Refreshing the T3 Connect login",
    );
    if (typeof response.access_token !== "string" || typeof response.expires_in !== "number") {
      throw new T3ConnectError("Refreshing the T3 Connect login returned an invalid response.");
    }
    const refreshed: CloudCredential = {
      accessToken: response.access_token,
      refreshToken: response.refresh_token ?? current.token.refreshToken,
      expiresAtEpochMs: Date.now() + response.expires_in * 1000,
      ...(current.token.identity ? { identity: current.token.identity } : {}),
    };
    persistCredential(this.tokenPath, refreshed);
    return refreshed;
  }

  async credential(): Promise<CloudCredential> {
    const current = readCredential(this.tokenPath);
    if (current.token.expiresAtEpochMs > Date.now() + REFRESH_EARLY_MS) return current.token;
    this.refreshPromise ??= this.refreshCredential(current.token, current.mtimeMs).finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  async listEnvironments(): Promise<RelayEnvironment[]> {
    let accessToken: string;
    try {
      accessToken = (await this.credential()).accessToken;
    } catch (credentialError) {
      try {
        accessToken = await this.desktopSession.relaySessionToken();
      } catch (sessionError) {
        const credentialMessage =
          credentialError instanceof Error ? credentialError.message : String(credentialError);
        const sessionMessage = sessionError instanceof Error ? sessionError.message : String(sessionError);
        throw new T3ConnectError(
          `Could not authorize T3 Connect discovery. CLI login: ${credentialMessage} Desktop session: ${sessionMessage}`,
        );
      }
    }
    const response = await fetchJson<{ environments?: RelayEnvironment[] }>(
      `${this.relayUrl}/v1/environments`,
      { headers: { authorization: `Bearer ${accessToken}` } },
      "Listing T3 Connect environments",
    );
    if (!Array.isArray(response.environments)) {
      throw new T3ConnectError("T3 Connect returned an invalid environment list.");
    }
    return response.environments;
  }

  private async mintRelayToken(): Promise<string> {
    if (this.relayToken && this.relayToken.expiresAtEpochMs > Date.now() + 5_000) {
      return this.relayToken.accessToken;
    }
    const sessionToken = await this.desktopSession.relaySessionToken();
    const url = `${this.relayUrl}/v1/client/dpop-token`;
    const response = await fetchJson<{
      access_token: string;
      expires_in: number;
      token_type: string;
    }>(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          dpop: createDpopProof({ method: "POST", url, key: this.key }),
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token: sessionToken,
          subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
          requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
          resource: this.relayUrl,
          scope: "environment:connect",
          client_id: "t3-web",
        }),
      },
      "Authorizing with the T3 Connect relay",
    );
    if (
      typeof response.access_token !== "string" ||
      typeof response.expires_in !== "number" ||
      response.token_type !== "DPoP"
    ) {
      throw new T3ConnectError("T3 Connect relay returned an invalid access token.");
    }
    this.relayToken = {
      accessToken: response.access_token,
      expiresAtEpochMs: Date.now() + response.expires_in * 1000,
    };
    return response.access_token;
  }

  private async getRelayToken(): Promise<string> {
    if (this.relayToken && this.relayToken.expiresAtEpochMs > Date.now() + 5_000) {
      return this.relayToken.accessToken;
    }
    this.relayTokenPromise ??= this.mintRelayToken().finally(() => {
      this.relayTokenPromise = undefined;
    });
    return this.relayTokenPromise;
  }

  private async exchangeEnvironmentToken(environment: RelayEnvironment): Promise<EnvironmentToken> {
    const relayAccessToken = await this.getRelayToken();
    const connectUrl = `${this.relayUrl}/v1/environments/${encodeURIComponent(environment.environmentId)}/connect`;
    const bootstrap = await fetchJson<{
      environmentId: string;
      endpoint: RelayEnvironment["endpoint"];
      credential: string;
      expiresAt: string;
    }>(
      connectUrl,
      {
        method: "POST",
        headers: {
          authorization: `DPoP ${relayAccessToken}`,
          "content-type": "application/json",
          dpop: createDpopProof({
            method: "POST",
            url: connectUrl,
            key: this.key,
            accessToken: relayAccessToken,
          }),
        },
        body: JSON.stringify({ clientProofKeyThumbprint: this.key.thumbprint }),
      },
      `Connecting to ${environment.label}`,
    );
    if (
      bootstrap.environmentId !== environment.environmentId ||
      typeof bootstrap.credential !== "string" ||
      typeof bootstrap.endpoint?.httpBaseUrl !== "string"
    ) {
      throw new T3ConnectError(`T3 Connect returned an invalid bootstrap for ${environment.label}.`);
    }
    const origin = bootstrap.endpoint.httpBaseUrl.replace(/\/$/, "");
    const tokenUrl = `${origin}/oauth/token`;
    const response = await fetchJson<{
      access_token: string;
      expires_in: number;
      token_type: string;
    }>(
      tokenUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          dpop: createDpopProof({ method: "POST", url: tokenUrl, key: this.key }),
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token: bootstrap.credential,
          subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
          requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
          scope: AUTH_SCOPES,
          client_label: "T3 Code Thread Bridge",
          client_device_type: "bot",
          client_os: process.platform,
        }),
      },
      `Starting a secure session with ${environment.label}`,
    );
    if (
      typeof response.access_token !== "string" ||
      typeof response.expires_in !== "number" ||
      response.token_type !== "DPoP"
    ) {
      throw new T3ConnectError(`${environment.label} returned an invalid access token.`);
    }
    const result = {
      accessToken: response.access_token,
      expiresAtEpochMs: Date.now() + response.expires_in * 1000,
      origin,
    };
    this.environmentTokens.set(environment.environmentId, result);
    return result;
  }

  async authorizeEnvironment(
    environment: RelayEnvironment,
    method: string,
    url: string,
  ): Promise<Record<string, string>> {
    let token = this.environmentTokens.get(environment.environmentId);
    if (!token || token.expiresAtEpochMs <= Date.now() + 5_000) {
      token = await this.exchangeEnvironmentToken(environment);
    }
    return {
      authorization: `DPoP ${token.accessToken}`,
      dpop: createDpopProof({ method, url, key: this.key, accessToken: token.accessToken }),
    };
  }

  invalidateEnvironment(environmentId: string): void {
    this.environmentTokens.delete(environmentId);
  }
}
