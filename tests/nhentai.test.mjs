import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const harness = fileURLToPath(new URL("../modules/nhentai/fixtures/self-test.mjs", import.meta.url));

test("nhentai: module fixture harness passes", () => {
  const out = execFileSync(process.execPath, [harness], { encoding: "utf8", timeout: 180000 });
  assert.ok(!/\bFAIL\b/.test(out), out);
  assert.ok(/checks passed/.test(out), out);
});
