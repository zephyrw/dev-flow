import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  mkdirSync,
  cpSync,
} from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { backup } from "node:sqlite";
import type { Engine } from "../../core/src/engine.js";
import { atomicWrite, hash, now } from "../../core/src/util.js";
import { requireCondition, RelativePath } from "../../contracts/src/index.js";
function inside(root: string, path: string) {
  const base = resolve(root),
    target = resolve(root, path),
    rel = relative(base, target);
  requireCondition(
    rel !== "" && !rel.startsWith("..") && !isAbsolute(rel),
    "PATH_ESCAPE",
    "备份路径越界",
  );
  for (let cursor = base; cursor !== target; ) {
    const next = relative(cursor, target).split(/[\\/]/)[0]!;
    cursor = join(cursor, next);
    if (existsSync(cursor))
      requireCondition(
        !lstatSync(cursor).isSymbolicLink(),
        "LINK_DENIED",
        "不处理备份中的链接",
      );
  }
  return target;
}
function files(root: string, directory = ""): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(
    (entry) => {
      const name = [directory, entry.name].filter(Boolean).join("/");
      const path = inside(root, name);
      if (entry.isDirectory()) return files(root, name);
      requireCondition(entry.isFile(), "FILE_TYPE", "备份只接受普通文件");
      return [name];
    },
  );
}
export async function createBackup(engine: Engine, target: string) {
  const dest = resolve(target);
  requireCondition(!existsSync(dest), "EXISTS", "备份目录必须不存在");
  mkdirSync(dest, { recursive: true });
  await backup(engine.store.db, join(dest, "devflow.sqlite"));
  for (const name of ["documents", "evidence", "reviews", "containers"]) {
    const source = join(engine.config.storage_root, name);
    if (existsSync(source)) {
      files(source);
      cpSync(source, join(dest, name), { recursive: true });
    }
  }
  const entries = files(dest).map((path) => ({
    path,
    hash: hash(readFileSync(inside(dest, path))),
  }));
  atomicWrite(
    join(dest, "manifest.json"),
    JSON.stringify(
      {
        schema_version: 1,
        source_root: resolve(engine.config.storage_root),
        created_at: now(),
        files: entries,
      },
      null,
      2,
    ),
  );
  return { directory: dest, files: entries.length };
}
export function verifyBackup(target: string) {
  const root = resolve(target),
    manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  requireCondition(
    manifest.schema_version === 1 &&
      Array.isArray(manifest.files) &&
      manifest.files.length > 0,
    "BACKUP_INVALID",
    "备份清单无效",
  );
  const seen = new Set();
  for (const file of manifest.files) {
    RelativePath.parse(file.path);
    requireCondition(!seen.has(file.path), "BACKUP_INVALID", "重复文件");
    seen.add(file.path);
    requireCondition(
      hash(readFileSync(inside(root, file.path))) === file.hash,
      "BACKUP_CORRUPT",
      `备份文件已损坏：${file.path}`,
    );
  }
  requireCondition(
    seen.has("devflow.sqlite"),
    "BACKUP_INVALID",
    "备份缺少数据库",
  );
  return manifest;
}
export function restoreBackup(source: string, target: string) {
  const manifest = verifyBackup(source),
    dest = resolve(target);
  requireCondition(
    dest === resolve(manifest.source_root),
    "RESTORE_LOCATION",
    "为了保持证据绝对路径，恢复必须使用原存储目录",
  );
  requireCondition(
    !existsSync(dest),
    "EXISTS",
    "恢复目录必须不存在；请先停止服务并移走原存储目录",
  );
  mkdirSync(dest, { recursive: true });
  for (const file of manifest.files) {
    const output = inside(dest, file.path);
    mkdirSync(resolve(output, ".."), { recursive: true });
    atomicWrite(output, readFileSync(inside(source, file.path)));
  }
  return { directory: dest, files: manifest.files.length };
}
/** Compress old raw model streams only. Evidence, approvals and commit records stay intact. */
export function archiveLogs(engine: Engine, clock = Date.now()) {
  const archived = [];
  for (const flow of engine.list()) {
    if (!["COMMITTED", "STOPPED", "BLOCKED"].includes(flow.state)) continue;
    const days =
      flow.state === "COMMITTED"
        ? engine.config.retention.logs_days
        : engine.config.retention.failed_logs_days;
    if (clock - Date.parse(flow.updated_at) < days * 86400000) continue;
    const root = join(engine.config.storage_root, "containers", flow.id);
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root).filter((n) => n.endsWith(".jsonl"))) {
      const path = inside(root, name);
      const raw = readFileSync(path),
        compressed = gzipSync(raw);
      requireCondition(
        hash(gunzipSync(compressed)) === hash(raw),
        "ARCHIVE_CORRUPT",
        "压缩内容校验失败",
      );
      atomicWrite(path + ".gz", compressed);
      engine.store.put("log_archive", flow.id + "-" + name, flow.id, {
        path: path + ".gz",
        raw_hash: hash(raw),
        compressed_hash: hash(compressed),
        created_at: now(),
      });
      unlinkSync(path);
      archived.push(path + ".gz");
    }
  }
  return archived;
}
