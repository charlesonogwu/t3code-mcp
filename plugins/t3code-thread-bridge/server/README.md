# t3code-mcp

MCP server for [T3 Code](https://t3.codes). It discovers the local environment plus every computer linked to the same account through T3 Connect, then lets a client inspect and safely message threads across them.

See `SPEC.md` for the design and `PLAN.md` for the phased build.

## Setup

```bash
npm ci && npm run build
```

1. Make sure T3 Code is running (desktop app or `npx t3@latest`). Enable T3 Connect to reach environments on other computers.
2. Mint a bearer token on this computer and store it at the bridge's per-user default path:

```bash
mkdir -p ~/.config/t3code-thread-bridge
npx t3@latest auth session issue --token-only --label t3code-mcp --ttl 365d
# Save the returned value in ~/.config/t3code-thread-bridge/t3-token
chmod 600 ~/.config/t3code-thread-bridge/t3-token
```

On Windows, use the equivalent `%USERPROFILE%\.config\t3code-thread-bridge\t3-token`
path and restrict its ACL to the current user. `T3_TOKEN_FILE` can override the path on any OS.

3. Sanity check against the live server (read-only):

```bash
pnpm smoke
```

## Connect from Claude Code

```bash
claude mcp add --scope user t3code -- node /Users/thomascrundwell/Documents/projects/t3code-mcp/dist/index.js
```

(The token is read from the per-user default path; alternatively set `T3_TOKEN_FILE` or
`T3_TOKEN` for the MCP server.)

## Tools

**Visibility** — `t3_status`, `list_environments`, `list_projects`, `list_threads` (filter by project / attention state), `get_thread`, `search_threads`

**Messaging & control** — `send_message`, `create_thread`, `wait_for_turn` (send-and-wait round trip), `interrupt_thread`, `stop_thread`, `archive_thread`, `unarchive_thread`, `set_thread_title`

**Hands-free interaction** — `pending_actions` (cross-thread "what needs me?" inbox), `respond_to_approval`, `respond_to_user_input`

**Voice layer** — `thread_digest` and `workspace_digest` (TTS-friendly `spoken` summaries), `wait_for_change` (long-poll until anything needs attention)

Every project and thread result identifies its owning environment. Commands that take a project or thread ID automatically route to that computer. Every thread also carries a single `attention` state: `needs-approval | needs-input | plan-ready | working | error | done | idle`.

## Remote / voice clients (HTTP mode)

For a remote voice agent (e.g. Hermes over Tailscale), run the streamable-HTTP transport with its own bearer token:

```bash
MCP_HTTP_TOKEN=<secret> node dist/index.js --http --port 3774 --host 0.0.0.0
```

Clients connect to `http://<machine>:3774/` with `Authorization: Bearer <secret>`. Binds to 127.0.0.1 unless `--host` is given; T3 Code itself stays localhost-only.

## Testing

- `pnpm smoke` — read-only pass over every query tool against the live server.
- `node scripts/smoke.mjs --mutate <projectId>` — additionally runs the full write loop (create disposable thread → agent replies → follow-up message → rename → stop → archive). Use a scratch project; "t3code-mcp scratch" (`/tmp/t3code-mcp-scratch`) exists for this.

## Notes / limitations

- Uses T3's HTTP JSON API only (`/api/orchestration/*`). Live push, git-worktree bootstrap, and turn diffs are WebSocket-RPC-only in T3, so: updates are polled, and `create_thread` runs threads directly in the project workspace (start worktree threads from the T3 UI).
- Cross-device access reuses the signed-in T3 Code desktop session plus the existing T3 Connect login. The bridge unlocks the encrypted desktop session through the current user's Linux keyring, macOS Keychain, or Windows DPAPI, and creates its own private proof-of-possession key in `~/.t3/userdata/secrets/`. Remote tokens are short-lived and are never returned by tools.
- A bridge installation can reach every online environment linked to that T3 account; the other computers only need T3 Code running with T3 Connect enabled. Install the plugin on another computer only if you also want to start cross-workspace messaging from that computer.
- Image attachments not yet supported on `send_message`.
- Revoke access anytime: `npx t3@latest auth session list` / `... revoke`.
