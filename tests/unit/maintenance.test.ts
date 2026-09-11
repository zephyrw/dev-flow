import { it, expect } from "vitest";
import { setup } from "../helpers.js";
import { join } from "node:path";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  createBackup,
  verifyBackup,
  restoreBackup,
  archiveLogs,
} from "../../packages/runtime/src/maintenance.js";
import { Store } from "../../packages/store/src/store.js";
it("UT-20 backup manifest detects tampering and rejects traversal", async () => {
  const s = setup();
  try {
    const target = join(s.root, "backup");
    await createBackup(s.engine, target);
    expect(verifyBackup(target).files.length).toBeGreaterThan(0);
    const path = join(target, "manifest.json"),
      manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.files.push({ path: "../outside", hash: "fake" });
    writeFileSync(path, JSON.stringify(manifest));
    expect(() => verifyBackup(target)).toThrow();
    manifest.files.pop();
    writeFileSync(path, JSON.stringify(manifest));
    writeFileSync(join(target, "devflow.sqlite"), "corrupt");
    expect(() => verifyBackup(target)).toThrow(/损坏/);
  } finally {
    s.store.close();
  }
});
it("IT-16 backup restores database and evidence at their original paths", async () => {
  const s = setup(),
    dest = join(s.root, "backup");
  s.store.put("example", "one", "system", { value: "中文状态" });
  const evidence = join(s.config.storage_root, "evidence", "original.json");
  mkdirSync(join(s.config.storage_root, "evidence"), { recursive: true });
  writeFileSync(evidence, "真实证据");
  await createBackup(s.engine, dest);
  s.store.close();
  expect(() => restoreBackup(dest, s.config.storage_root)).toThrow(/存在/);
  renameSync(s.config.storage_root, join(s.root, "old-state"));
  restoreBackup(dest, s.config.storage_root);
  const restored = new Store(join(s.config.storage_root, "devflow.sqlite"));
  try {
    expect(restored.get("example", "one")).toEqual({ value: "中文状态" });
    expect(readFileSync(evidence, "utf8")).toBe("真实证据");
  } finally {
    restored.close();
  }
});
it("UT-20 retention compresses only expired terminal logs and preserves exact bytes", () => {
  const s = setup();
  try {
    const flow = {
      id: "wf-archive",
      state: "COMMITTED",
      updated_at: new Date(0).toISOString(),
    };
    s.store.put("workflow", flow.id, "p", flow);
    const directory = join(s.config.storage_root, "containers", flow.id);
    mkdirSync(directory, { recursive: true });
    const file = join(directory, "run.jsonl"),
      raw = Buffer.from('{"中文":"过程日志"}\n');
    writeFileSync(file, raw);
    expect(archiveLogs(s.engine, 86400000)).toEqual([]);
    expect(archiveLogs(s.engine, 100 * 86400000)).toEqual([file + ".gz"]);
    expect(existsSync(file)).toBe(false);
    expect(gunzipSync(readFileSync(file + ".gz"))).toEqual(raw);
  } finally {
    s.store.close();
  }
});
