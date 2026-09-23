import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadToken, ConfigError } from "../dist/config.js";
import { resolveDeliveryMode } from "../dist/tools/phase1.js";

test("messages queue after the active turn by default", () => {
  assert.equal(resolveDeliveryMode(), "after-current");
  assert.equal(resolveDeliveryMode("immediate"), "immediate");
});

test("token file privacy is enforced where POSIX modes are available", () => {
  const directory = mkdtempSync(join(tmpdir(), "t3-bridge-test-"));
  const tokenFile = join(directory, "token");
  const oldToken = process.env.T3_TOKEN;
  const oldTokenFile = process.env.T3_TOKEN_FILE;
  try {
    delete process.env.T3_TOKEN;
    process.env.T3_TOKEN_FILE = tokenFile;
    writeFileSync(tokenFile, "secret-token\n", { mode: 0o644 });
    if (process.platform === "win32") {
      assert.equal(loadToken(), "secret-token");
    } else {
      assert.throws(() => loadToken(), ConfigError);
      chmodSync(tokenFile, 0o600);
    }
    assert.equal(loadToken(), "secret-token");
  } finally {
    if (oldToken === undefined) delete process.env.T3_TOKEN;
    else process.env.T3_TOKEN = oldToken;
    if (oldTokenFile === undefined) delete process.env.T3_TOKEN_FILE;
    else process.env.T3_TOKEN_FILE = oldTokenFile;
    rmSync(directory, { recursive: true, force: true });
  }
});
