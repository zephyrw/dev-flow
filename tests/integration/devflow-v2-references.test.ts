import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createIsolatedTestEnv,
  type IsolatedTestEnv,
} from "../fixtures/isolation.js";
import { WorkspaceReferenceService } from "../../packages/workspace/src/references.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

describe("IT-REFERENCES: 工作区引用候选、逐级目录、有界预览与路径穿越防御 (LF-04~LF-06, RQ-10~RQ-12)", () => {
  let env: IsolatedTestEnv;
  let workspaceRoot: string;

  beforeEach(() => {
    env = createIsolatedTestEnv();
    workspaceRoot = join(env.root, "workspace");
    mkdirSync(workspaceRoot, { recursive: true });

    // 构建测试文件目录树
    mkdirSync(join(workspaceRoot, "src", "controllers"), { recursive: true });
    mkdirSync(join(workspaceRoot, "src", "services"), { recursive: true });
    mkdirSync(join(workspaceRoot, "docs"), { recursive: true });
    mkdirSync(join(workspaceRoot, "node_modules", "some-lib"), {
      recursive: true,
    });

    writeFileSync(
      join(workspaceRoot, "src", "controllers", "user.ts"),
      "export class UserController {}",
    );
    writeFileSync(
      join(workspaceRoot, "src", "services", "auth.ts"),
      "export class AuthService {}",
    );
    writeFileSync(
      join(workspaceRoot, "docs", "spec.md"),
      "# API 接口定义文档\n## 鉴权流程\n",
    );
    writeFileSync(
      join(workspaceRoot, "node_modules", "some-lib", "index.js"),
      "module.exports = {};",
    );
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("TC-REF-01: 工作区引用候选搜索应安全过滤忽略项 (LF-04, RQ-10)", () => {
    // 搜索全部候选
    const res = WorkspaceReferenceService.searchReferences(workspaceRoot, "");
    expect(res.items.length).toBeGreaterThan(0);

    // 确保包含业务代码
    const paths = res.items.map((r) => r.relative_path.replace(/\\/g, "/"));
    expect(paths).toContain("src/controllers/user.ts");
    expect(paths).toContain("src/services/auth.ts");
    expect(paths).toContain("docs/spec.md");

    // 确保 node_modules 目录被自动过滤忽略
    const hasNodeModules = paths.some((p) => p.includes("node_modules"));
    expect(hasNodeModules).toBe(false);

    // 关键词精准过滤
    const filtered = WorkspaceReferenceService.searchReferences(
      workspaceRoot,
      "auth",
    );
    const filteredPaths = filtered.items.map((r) =>
      r.relative_path.replace(/\\/g, "/"),
    );
    expect(filteredPaths).toContain("src/services/auth.ts");
    expect(filteredPaths).not.toContain("src/controllers/user.ts");
  });

  it("TC-REF-02: 逐级目录浏览结构区分目录与文件 (LF-05)", () => {
    // 列出根目录
    const res = WorkspaceReferenceService.listDirectory(workspaceRoot, "");
    const rootNames = res.items.map((i) => i.name);
    expect(rootNames).toContain("src");
    expect(rootNames).toContain("docs");

    const srcDir = res.items.find((i) => i.name === "src");
    expect(srcDir?.kind).toBe("directory");

    // 进入 src 目录
    const srcRes = WorkspaceReferenceService.listDirectory(
      workspaceRoot,
      "src",
    );
    const srcNames = srcRes.items.map((i) => i.name);
    expect(srcNames).toContain("controllers");
    expect(srcNames).toContain("services");
  });

  it("TC-REF-03: 有界文本预览与超出 256KiB 安全截断保护 (LF-06, RQ-11)", () => {
    // 1. 正常小文件预览
    const normalPreview = WorkspaceReferenceService.readTextPreview(
      workspaceRoot,
      "docs/spec.md",
    );
    expect(normalPreview.truncated).toBe(false);
    expect(normalPreview.text).toContain("# API 接口定义文档");

    // 2. 构造超大文本文件 (300KiB，超出 256KiB 上限)
    const largeContent = "L".repeat(300 * 1024);
    writeFileSync(join(workspaceRoot, "large.txt"), largeContent);

    const largePreview = WorkspaceReferenceService.readTextPreview(
      workspaceRoot,
      "large.txt",
    );
    expect(largePreview.truncated).toBe(true);
    expect(largePreview.text.length).toBeLessThanOrEqual(256 * 1024 + 100);
  });

  it("TC-REF-04: 路径穿越攻击防御，越出工作区根目录坚决拒绝 (RQ-10, RQ-11)", () => {
    // 尝试读取父目录文件
    const secretFile = join(env.root, "secret.txt");
    writeFileSync(secretFile, "PRIVATE_KEY_DATA");

    expect(() => {
      WorkspaceReferenceService.readTextPreview(workspaceRoot, "../secret.txt");
    }).toThrow(/越界|穿越|DENIED|INVALID/i);
  });
});
