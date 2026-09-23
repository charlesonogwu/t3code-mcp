import { T3Client, T3Error, makeClient, type DispatchResult, type EnvironmentInfo } from "./client.js";
import { T3ConnectClient, type RelayEnvironment } from "./cloud.js";
import type { ShellSnapshot, ThreadDetailSnapshot } from "./model.js";

export interface BridgeEnvironment {
  environmentId: string;
  label: string;
  origin: string;
  connection: "local" | "t3-connect";
  linkedAt?: string;
}

interface ClientEntry {
  environment: BridgeEnvironment;
  client: T3Client;
}

export interface BridgeEnvironmentStatus extends BridgeEnvironment {
  reachable: boolean;
  projects?: number;
  threads?: number;
  error?: string;
}

export class T3BridgeClient {
  readonly origin = "local + T3 Connect";
  private local?: T3Client;
  private localError?: string;
  private cloud?: T3ConnectClient;
  private entriesCache?: { expiresAt: number; entries: ClientEntry[]; discoveryError?: string };
  private readonly threadClients = new Map<string, T3Client>();
  private readonly projectClients = new Map<string, T3Client>();
  private readonly clientEnvironments = new WeakMap<T3Client, BridgeEnvironment>();

  constructor() {
    try {
      this.local = makeClient();
    } catch (e) {
      this.localError = e instanceof Error ? e.message : String(e);
    }
  }

  private cloudClient(): T3ConnectClient {
    return (this.cloud ??= new T3ConnectClient());
  }

  private remoteClient(environment: RelayEnvironment): T3Client {
    const cloud = this.cloudClient();
    const origin = environment.endpoint.httpBaseUrl.replace(/\/$/, "");
    return new T3Client(
      origin,
      {
        headers: (method, url) => cloud.authorizeEnvironment(environment, method, url),
        invalidate: () => cloud.invalidateEnvironment(environment.environmentId),
      },
      environment.environmentId,
      environment.label,
    );
  }

  private async clientEntries(force = false): Promise<ClientEntry[]> {
    if (!force && this.entriesCache && this.entriesCache.expiresAt > Date.now()) {
      return this.entriesCache.entries;
    }
    const entries: ClientEntry[] = [];
    let localEnvironmentId: string | undefined;
    if (this.local) {
      try {
        const descriptor = await this.local.probe();
        localEnvironmentId = descriptor.environmentId;
        entries.push({
          environment: {
            environmentId: descriptor.environmentId,
            label: descriptor.label,
            origin: this.local.origin,
            connection: "local",
          },
          client: this.local,
        });
      } catch (e) {
        this.localError = e instanceof Error ? e.message : String(e);
      }
    }
    let discoveryError: string | undefined;
    try {
      const environments = await this.cloudClient().listEnvironments();
      for (const environment of environments) {
        if (environment.environmentId === localEnvironmentId) continue;
        entries.push({
          environment: {
            environmentId: environment.environmentId,
            label: environment.label,
            origin: environment.endpoint.httpBaseUrl,
            connection: "t3-connect",
            linkedAt: environment.linkedAt,
          },
          client: this.remoteClient(environment),
        });
      }
    } catch (e) {
      discoveryError = e instanceof Error ? e.message : String(e);
    }
    if (entries.length === 0) {
      throw new T3Error(
        [this.localError, discoveryError].filter(Boolean).join(" T3 Connect: ") ||
          "No T3 Code environments are available.",
      );
    }
    for (const entry of entries) this.clientEnvironments.set(entry.client, entry.environment);
    this.entriesCache = {
      entries,
      discoveryError,
      expiresAt: Date.now() + 15_000,
    };
    return entries;
  }

  async environmentStatuses(force = false): Promise<{
    environments: BridgeEnvironmentStatus[];
    discoveryError?: string;
  }> {
    const entries = await this.clientEntries(force);
    const statuses = await Promise.all(
      entries.map(async ({ environment, client }): Promise<BridgeEnvironmentStatus> => {
        try {
          const shell = await client.shell();
          return {
            ...environment,
            reachable: true,
            projects: shell.projects.filter((project) => !project.deletedAt).length,
            threads: shell.threads.length,
          };
        } catch (e) {
          return {
            ...environment,
            reachable: false,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }),
    );
    return {
      environments: statuses,
      ...(this.entriesCache?.discoveryError
        ? { discoveryError: this.entriesCache.discoveryError }
        : {}),
    };
  }

  async probe(): Promise<EnvironmentInfo> {
    const entries = await this.clientEntries();
    const local = entries.find((entry) => entry.environment.connection === "local") ?? entries[0];
    return local.client.probe();
  }

  async shell(): Promise<ShellSnapshot> {
    const entries = await this.clientEntries();
    const results = await Promise.allSettled(
      entries.map(async (entry) => ({ entry, shell: await entry.client.shell() })),
    );
    const projects: ShellSnapshot["projects"] = [];
    const threads: ShellSnapshot["threads"] = [];
    const environmentErrors: NonNullable<ShellSnapshot["environmentErrors"]> = [];
    let snapshotSequence = 0;
    let newest = new Date(0).toISOString();
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      const fallbackEntry = entries[index];
      if (result.status === "rejected") {
        environmentErrors.push({
          environmentId: fallbackEntry.environment.environmentId,
          environmentLabel: fallbackEntry.environment.label,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
        continue;
      }
      const { entry, shell } = result.value;
      snapshotSequence = Math.max(snapshotSequence, shell.snapshotSequence);
      if (Date.parse(shell.updatedAt) > Date.parse(newest)) newest = shell.updatedAt;
      for (const project of shell.projects) {
        const enriched = {
          ...project,
          environmentId: entry.environment.environmentId,
          environmentLabel: entry.environment.label,
        };
        projects.push(enriched);
        this.projectClients.set(project.id, entry.client);
      }
      for (const thread of shell.threads) {
        const enriched = {
          ...thread,
          environmentId: entry.environment.environmentId,
          environmentLabel: entry.environment.label,
        };
        threads.push(enriched);
        this.threadClients.set(thread.id, entry.client);
      }
    }
    if (projects.length === 0 && threads.length === 0 && environmentErrors.length === entries.length) {
      throw new T3Error(
        `No T3 Code environment was reachable: ${environmentErrors
          .map((item) => `${item.environmentLabel}: ${item.error}`)
          .join("; ")}`,
      );
    }
    return {
      snapshotSequence,
      projects,
      threads,
      updatedAt: newest,
      ...(environmentErrors.length > 0 ? { environmentErrors } : {}),
    };
  }

  private async clientForThread(threadId: string): Promise<T3Client> {
    const cached = this.threadClients.get(threadId);
    if (cached) return cached;
    const shell = await this.shell();
    const thread = shell.threads.find((item) => item.id === threadId);
    if (!thread) {
      throw new T3Error(`No thread with id ${threadId} exists in any reachable T3 environment.`);
    }
    const client = this.threadClients.get(threadId);
    if (!client) throw new T3Error(`Could not resolve the environment for thread ${threadId}.`);
    return client;
  }

  private async clientForProject(projectId: string): Promise<T3Client> {
    const cached = this.projectClients.get(projectId);
    if (cached) return cached;
    const shell = await this.shell();
    const project = shell.projects.find((item) => item.id === projectId);
    if (!project) {
      throw new T3Error(`No project with id ${projectId} exists in any reachable T3 environment.`);
    }
    const client = this.projectClients.get(projectId);
    if (!client) throw new T3Error(`Could not resolve the environment for project ${projectId}.`);
    return client;
  }

  async thread(
    threadId: string,
    opts: { turnLimit?: number; beforeCursor?: string } = {},
  ): Promise<ThreadDetailSnapshot> {
    const client = await this.clientForThread(threadId);
    const snapshot = await client.thread(threadId, opts);
    const environment = this.clientEnvironments.get(client);
    return {
      ...snapshot,
      thread: {
        ...snapshot.thread,
        ...(environment?.environmentId ? { environmentId: environment.environmentId } : {}),
        ...(environment?.label ? { environmentLabel: environment.label } : {}),
      },
    };
  }

  async dispatch(command: Record<string, unknown>): Promise<DispatchResult> {
    const threadId = typeof command.threadId === "string" ? command.threadId : undefined;
    const projectId = typeof command.projectId === "string" ? command.projectId : undefined;
    const client = projectId
      ? await this.clientForProject(projectId)
      : threadId
        ? await this.clientForThread(threadId)
        : undefined;
    if (!client) throw new T3Error("Cannot route a T3 command without a threadId or projectId.");
    const result = await client.dispatch(command);
    if (threadId) this.threadClients.set(threadId, client);
    return result;
  }
}

export function makeBridgeClient(): T3BridgeClient {
  return new T3BridgeClient();
}
