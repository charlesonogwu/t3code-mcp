# T3 Code tools marketplace

This repository distributes the current **T3 Code Thread Bridge** Codex plugin.

The plugin lets an agent on one computer inspect and message T3 Code threads on that computer and
on every online environment linked through the same T3 Connect account.

## Install

```bash
git clone https://github.com/ThomasCrund/t3code-mcp.git
cd t3code-mcp/plugins/t3code-thread-bridge/server
npm ci
npm run build
cd ../../..
codex plugin marketplace add .
codex plugin add t3code-thread-bridge@t3code-tools
```

Then create a fresh local T3 bearer token on that computer and save it at:

```text
~/.config/t3code-thread-bridge/t3-token
```

See [the plugin README](plugins/t3code-thread-bridge/README.md) for secure macOS, Windows, and Linux
configuration and read-only validation steps.

## Repository layout

- `.agents/plugins/marketplace.json` — the Codex marketplace catalog.
- `plugins/t3code-thread-bridge/` — the current cross-device plugin source, skill, tests, and MCP
  server.
- Root-level `src/`, `scripts/`, `SPEC.md`, and `PLAN.md` — the original 0.1.0 standalone,
  single-device prototype retained for history. New installations should use the plugin directory.

Credentials, OS keychain contents, `.env` files, generated proof keys, and `node_modules` are not
part of the repository.
