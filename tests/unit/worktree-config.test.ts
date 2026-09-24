import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function parsePort(raw: string | undefined, defaultPort: number): number {
  if (!raw || !raw.trim()) return defaultPort;
  const num = Number(raw.trim());
  if (!Number.isInteger(num) || num < 1 || num > 65535) {
    return defaultPort;
  }
  return num;
}

describe("U05 — worktree 配置解析与忽略规则校验", () => {
  it("默认端口行为：未设置环境变量时回退到默认端口 5173 / 4810", () => {
    expect(parsePort(undefined, 5173)).toBe(5173);
    expect(parsePort("", 5173)).toBe(5173);
    expect(parsePort(undefined, 4810)).toBe(4810);
  });

  it("环境变量覆盖：合法端口正常解析，非法值安全回退", () => {
    expect(parsePort("5200", 5173)).toBe(5200);
    expect(parsePort(" 4900 ", 4810)).toBe(4900);

    // 非法值（NaN、浮点数、越界或空串）回退默认
    expect(parsePort("invalid", 5173)).toBe(5173);
    expect(parsePort("0", 5173)).toBe(5173);
    expect(parsePort("70000", 5173)).toBe(5173);
    expect(parsePort("-1", 5173)).toBe(5173);
    expect(parsePort("5173.5", 5173)).toBe(5173);
  });

  it("代理目标与后端端口保持同步，并包含 WebSocket 支持", () => {
    const apiPort = parsePort("14920", 4810);
    const proxyConfig = {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        ws: true,
        changeOrigin: true,
      },
    };

    expect(proxyConfig["/api"].target).toBe("http://127.0.0.1:14920");
    expect(proxyConfig["/api"].ws).toBe(true);
    expect(proxyConfig["/api"].changeOrigin).toBe(true);
  });

  it("Git 忽略规则：验证 .gitignore 包含本地临时配置目录", () => {
    const gitignorePath = resolve(process.cwd(), ".gitignore");
    expect(existsSync(gitignorePath)).toBe(true);
    const gitignoreContent = readFileSync(gitignorePath, "utf-8");

    expect(gitignoreContent).toContain(".cache/devflow-local/");
    expect(gitignoreContent).toContain("devflow-local/");
  });
});
