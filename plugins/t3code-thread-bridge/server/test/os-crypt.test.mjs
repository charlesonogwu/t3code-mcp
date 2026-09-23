import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  decryptWindowsOsCryptValue,
  encryptWindowsOsCryptValue,
} from "../dist/clerk.js";

test("Windows Chromium OSCrypt values round-trip with AES-256-GCM", () => {
  const key = randomBytes(32);
  const encrypted = encryptWindowsOsCryptValue("session-token", key);
  assert.equal(encrypted.subarray(0, 3).toString("ascii"), "v10");
  assert.equal(decryptWindowsOsCryptValue(encrypted, key), "session-token");
});

test("Windows Chromium OSCrypt rejects unsupported versions", () => {
  assert.throws(
    () => decryptWindowsOsCryptValue(Buffer.from("v11-invalid"), randomBytes(32)),
    /unsupported OSCrypt version/,
  );
});
