import { discoverOrigin, loadToken, ConfigError } from "./config.js";
import type { ShellSnapshot, ThreadDetailSnapshot } from "./model.js";

export class T3Error extends Error {}

export interface EnvironmentInfo {
  environmentId: string;
  label: string;
  serverVersion: string;
  platform?: Record<string, unknown>;
}

export interface DispatchResult {
  sequence: number;
}

export interface RequestAuthorizer {
  headers(method: string, url: string): Promise<Record<string, string>>;
  invalidate?(): void;
}

function bearerAuthorizer(token: string): RequestAuthorizer {
  return {
    async headers() {
      return { authorization: `Bearer ${token}` };
    },
  };
}

export class T3Client {
  constructor(
    readonly origin: string,
    private readonly authorizer: RequestAuthorizer,
    readonly environmentId?: string,
    readonly environmentLabel?: string,
  ) {}

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.origin}${path}`;
    const method = init?.method ?? "GET";
    const attempt = async (): Promise<Response> => {
      try {
        return await fetch(url, {
          ...init,
          headers: {
            ...(await this.authorizer.headers(method, url)),
            ...(init?.body ? { "content-type": "application/json" } : {}),
            ...init?.headers,
          },
          signal: init?.signal ?? AbortSignal.timeout(30_000),
        });
      } catch (e) {
        throw new T3Error(
          `Could not reach ${this.environmentLabel ?? "the T3 Code server"} at ${this.origin} ` +
            `(${(e as Error).message}). Is that T3 Code environment online?`,
        );
      }
    };
    let res = await attempt();
    if ((res.status === 401 || res.status === 403) && this.authorizer.invalidate) {
      await res.body?.cancel().catch(() => undefined);
      this.authorizer.invalidate();
      res = await attempt();
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => undefined);
      throw new T3Error(
        `${this.environmentLabel ?? "T3 Code"} rejected the bridge session (${res.status}). ` +
          `For the local environment, refresh T3_TOKEN. For T3 Connect, sign in again.`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new T3Error(`T3 API ${path} failed: HTTP ${res.status} ${body.slice(0, 500)}`);
    }
    return (await res.json()) as T;
  }

  /** Unauthenticated liveness + identity probe. */
  async probe(): Promise<EnvironmentInfo> {
    let res: Response;
    try {
      res = await fetch(`${this.origin}/.well-known/t3/environment`, {
        signal: AbortSignal.timeout(3_000),
      });
    } catch (e) {
      throw new T3Error(
        `T3 Code server at ${this.origin} is not responding (${(e as Error).message}). ` +
          `Start the desktop app or \`npx t3@latest\`.`,
      );
    }
    if (!res.ok) throw new T3Error(`T3 probe failed: HTTP ${res.status}`);
    return (await res.json()) as EnvironmentInfo;
  }

  shell(): Promise<ShellSnapshot> {
    return this.req<ShellSnapshot>("/api/orchestration/shell");
  }

  thread(
    threadId: string,
    opts: { turnLimit?: number; beforeCursor?: string } = {},
  ): Promise<ThreadDetailSnapshot> {
    const params = new URLSearchParams();
    if (opts.turnLimit !== undefined) params.set("turnLimit", String(opts.turnLimit));
    if (opts.beforeCursor) params.set("beforeCursor", opts.beforeCursor);
    const qs = params.size ? `?${params}` : "";
    return this.req<ThreadDetailSnapshot>(
      `/api/orchestration/threads/${encodeURIComponent(threadId)}${qs}`,
    );
  }

  dispatch(command: Record<string, unknown>): Promise<DispatchResult> {
    return this.req<DispatchResult>("/api/orchestration/dispatch", {
      method: "POST",
      body: JSON.stringify(command),
    });
  }
}

/** Build a client from env/discovery. Throws ConfigError/T3Error with actionable messages. */
export function makeClient(): T3Client {
  return new T3Client(discoverOrigin(), bearerAuthorizer(loadToken()));
}

export { ConfigError };
