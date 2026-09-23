# T3 Code Thread Bridge

A Codex plugin that lets an agent inspect and message T3 Code threads on the local computer and
every environment linked through T3 Connect.

## Install from this marketplace

Clone the marketplace repository, build the plugin's MCP server, then add the marketplace and
plugin to Codex:

```bash
git clone https://github.com/ThomasCrund/t3code-mcp.git
cd t3code-mcp/plugins/t3code-thread-bridge/server
npm ci
npm run build
cd ../../..
codex plugin marketplace add .
codex plugin add t3code-thread-bridge@t3code-tools
```

## Local authorization

Each computer must create its own T3 bearer token. Never copy a token from another device.

The default token location is:

```text
~/.config/t3code-thread-bridge/t3-token
```

Generate the token on that computer with:

```bash
npx t3@latest auth session issue --token-only --label t3code-thread-bridge --ttl 365d
```

Save only the returned token in the default file. On macOS/Linux, run `chmod 600` on it. On
Windows, restrict the file to the current user. `T3_TOKEN_FILE` can override the default path.

T3 Code must also be signed in with T3 Connect enabled. The bridge reuses the desktop session
through the current user's OS credential store and creates its own proof-of-possession key locally.
No credential is included in this repository or returned by a tool.

Start a new T3 Code thread after installation so Codex loads the new MCP tools and skill.

## Validation

From `plugins/t3code-thread-bridge/server`:

```bash
npm test
npm run smoke
```

The standard smoke test is read-only. It checks local and linked environment discovery, projects,
threads, and thread reads without sending messages.
