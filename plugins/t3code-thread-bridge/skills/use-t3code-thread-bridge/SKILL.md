---
name: use-t3code-thread-bridge
description: Inspect and communicate with T3 Code threads across the local computer and every environment linked through T3 Connect. Use when the user asks to list, search, inspect, monitor, or message another T3 Code conversation or workspace.
---

# T3 Code Thread Bridge

Use the `t3code-thread-bridge` MCP tools to work with T3 Code conversations on this device or any computer linked through T3 Connect.

## Safe workflow

1. Call `t3_status` when connection health is unknown or a bridge tool fails. Use `list_environments` when the target computer matters.
2. Use `list_projects`, `list_threads`, or `search_threads` to locate the target. Results include the owning environment.
3. Resolve natural target phrases yourself. Prefer an exact workspace/project match, then an exact thread-title match, then a unique case-insensitive or word match. Remember an unambiguous target during the current conversation. If more than one plausible target remains, ask one short clarifying question instead of guessing.
4. Confirm the target from its environment, title, project, and thread ID before any write.
5. Use `get_thread` to inspect the selected conversation.
6. Call `send_message` only when the user explicitly asks to send a message.
7. Leave `deliveryMode` unset so the message queues after the current turn. Use `immediate` only when the user explicitly asks to steer an active turn.
8. If `send_message` returns `verified: false`, inspect the thread before retrying so the message is not duplicated.

The bridge automatically routes a thread or project ID to the environment that owns it. Do not ask the user to install a second bridge service on every linked computer; each computer only needs T3 Code with T3 Connect enabled and must be online when contacted.

Cross-device authorization reuses the current user's signed-in T3 Code desktop session and OS keychain. Never ask the user to paste account tokens into chat, and never expose credentials returned by the bridge.

Do not approve requests, answer agent questions, stop turns, archive threads, rename threads, or create threads unless the user explicitly requests that action.
