import {
  lstatSync,
  realpathSync,
  existsSync,
  readFileSync,
  readdirSync,
  openSync,
  closeSync,
  fstatSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { join, resolve, relative, dirname, sep } from "node:path";
import {
  FlowError,
  RelativePath,
  requireCondition,
  type Plan,
} from "../../contracts/src/index.js";
import { hash, id } from "../../core/src/util.js";
const isBinary = (content: Buffer) =>
  content.includes(0) ||
  content.subarray(0, 8192).some((b) => b < 9 || (b > 13 && b < 32));
const protectedParts = new Set([".git", ".agents", ".codex", ".devflow"]);
export function safePath(root: string, input: string, write = false): string {
  RelativePath.parse(input);
  const parts = input.split("/");
  requireCondition(
    !parts.some(
      (s) =>
        protectedParts.has(s.toLowerCase()) ||
        s.endsWith(".") ||
        s.endsWith(" ") ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s),
    ),
    "PATH_DENIED",
    "受保护或特殊路径",
    403,
  );
  const base = realpathSync(root);
  let current = base;
  for (const part of parts) {
    current = join(current, part);
    if (existsSync(current)) {
      const stat = lstatSync(current);
      requireCondition(
        !stat.isSymbolicLink() &&
          (!write || stat.nlink <= 1 || stat.isDirectory()),
        "LINK_DENIED",
        "不能通过链接访问或写入",
        403,
      );
      const actual = realpathSync(current);
      const rel = relative(base, actual);
      requireCondition(
        rel !== "" &&
          !rel.startsWith(".." + sep) &&
          rel !== ".." &&
          !resolve(actual).toLowerCase().startsWith("\\\\"),
        "PATH_ESCAPE",
        "实际路径越界",
        403,
      );
    }
  }
  return current;
}
export class FileBroker {
  constructor(private changed: (paths: string[]) => void = () => {}) {}
  read(root: string, p: string, start = 1, limit = 300) {
    const target = safePath(root, p);
    const s = lstatSync(target);
    requireCondition(
      s.isFile() && s.size <= 4 * 1024 * 1024,
      "FILE_TOO_LARGE",
      "文件过大或类型不支持",
    );
    const bytes = readFileSync(target);
    requireCondition(
      !isBinary(bytes),
      "BINARY_FILE",
      "这是二进制文件，请读取对应源码",
    );
    const content = bytes.toString("utf8");
    return {
      path: p,
      hash: hash(content),
      content: content
        .split("\n")
        .slice(
          Math.max(0, start - 1),
          Math.max(0, start - 1) + Math.min(1000, limit),
        )
        .join("\n"),
    };
  }
  list(root: string, p?: string) {
    const target = p ? safePath(root, p) : realpathSync(root);
    return readdirSync(target, { withFileTypes: true })
      .filter(
        (e) => !protectedParts.has(e.name.toLowerCase()) && !e.isSymbolicLink(),
      )
      .slice(0, 1000)
      .map((e) => ({
        name: e.name,
        type: e.isDirectory() ? "directory" : "file",
      }));
  }
  search(root: string, query: string, max = 100) {
    requireCondition(
      query.length > 0 && query.length < 500,
      "BAD_QUERY",
      "查询长度无效",
    );
    const hits: { path: string; line: number; text: string }[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
        if (hits.length >= max) return;
        if (
          protectedParts.has(e.name.toLowerCase()) ||
          [
            "node_modules",
            "dist",
            ".cache",
            "target",
            "build",
            "bin",
            "obj",
            "coverage",
          ].includes(e.name.toLowerCase()) ||
          e.isSymbolicLink()
        )
          continue;
        const p = [dir, e.name].filter(Boolean).join("/");
        if (e.isDirectory()) walk(p);
        else {
          try {
            const t = safePath(root, p);
            if (lstatSync(t).size > 1024 * 1024) continue;
            const bytes = readFileSync(t);
            if (isBinary(bytes)) continue;
            bytes
              .toString("utf8")
              .split("\n")
              .forEach((line, i) => {
                if (line.includes(query) && hits.length < max)
                  hits.push({
                    path: p,
                    line: i + 1,
                    text: line.slice(0, 1000),
                  });
              });
          } catch {
            continue;
          }
        }
      }
    };
    walk("");
    return hits;
  }
  apply(
    root: string,
    scope: Plan["scope"],
    changes: {
      path: string;
      expected_hash: string | null;
      content: string | null;
    }[],
  ) {
    requireCondition(
      changes.length > 0 && changes.length <= 50,
      "PATCH_SIZE",
      "补丁文件数量无效",
    );
    requireCondition(
      new Set(changes.map((c) => c.path)).size === changes.length,
      "DUPLICATE_PATH",
      "重复补丁路径",
    );
    const prepared = changes.map((c) => {
      requireCondition(
        scope.allowed_paths.includes(c.path) &&
          !scope.protected_paths.some(
            (p) => c.path === p || c.path.startsWith(p + "/"),
          ),
        "SCOPE_DENIED",
        `未批准路径 ${c.path}`,
        403,
      );
      if (!scope.allow_dependency_changes)
        requireCondition(
          !/(^|\/)(package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|pom\.xml|requirements.*\.txt)$/.test(
            c.path,
          ),
          "DEPENDENCY_DENIED",
          "依赖更改未获批准",
          403,
        );
      const target = safePath(root, c.path, true);
      let actual: null | string = null;
      if (existsSync(target)) {
        const fd = openSync(target, "r");
        try {
          const s = fstatSync(fd);
          requireCondition(
            s.isFile() && s.nlink === 1,
            "LINK_DENIED",
            "不能写非普通文件",
            403,
          );
          actual = hash(readFileSync(fd));
        } finally {
          closeSync(fd);
        }
      }
      requireCondition(
        actual === c.expected_hash,
        "CONTENT_CONFLICT",
        `文件已变化 ${c.path}`,
      );
      requireCondition(
        c.content === null || Buffer.byteLength(c.content) < 4 * 1024 * 1024,
        "PATCH_SIZE",
        "单文件内容过大",
      );
      return { ...c, target };
    });
    const written: string[] = [];
    try {
      for (const c of prepared) {
        safePath(root, c.path, true);
        if (c.content === null) {
          if (existsSync(c.target)) unlinkSync(c.target);
        } else {
          mkdirSync(dirname(c.target), { recursive: true });
          const temp = c.target + "." + id("tmp");
          writeFileSync(temp, c.content, { flag: "wx", mode: 0o600 });
          renameSync(temp, c.target);
        }
        written.push(c.path);
      }
    } finally {
      if (written.length) this.changed(written);
    }
    return prepared.map((c) => ({
      path: c.path,
      hash: c.content === null ? null : hash(c.content),
    }));
  }
}
