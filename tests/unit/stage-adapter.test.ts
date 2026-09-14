import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

it("DF-STAGE-U01 rejects missing isolated preview environment", async () => {
  const previewScript = resolve("scripts/devflow/stage-preview.mjs");

  const runWithEnv = (env: Record<string, string | undefined>) => {
    return new Promise<{ code: number | null; stderr: string }>((res) => {
      const child = spawn(process.execPath, [previewScript], {
        env: { ...process.env, ...env },
      });
      let stderr = "";
      child.stderr.on("data", (b) => (stderr += b.toString()));
      child.on("close", (code) => res({ code, stderr }));
    });
  };

  const res1 = await runWithEnv({
    DEVFLOW_PORT: undefined,
    DEVFLOW_DATA_DIR: undefined,
    DEVFLOW_IDENTITY: undefined,
  });
  expect(res1.code).not.toBe(0);

  const res2 = await runWithEnv({
    DEVFLOW_PORT: undefined,
    DEVFLOW_DATA_DIR: "C:/dummy/data",
    DEVFLOW_IDENTITY: "test-id",
  });
  expect(res2.code).not.toBe(0);

  const res3 = await runWithEnv({
    DEVFLOW_PORT: "19999",
    DEVFLOW_DATA_DIR: undefined,
    DEVFLOW_IDENTITY: "test-id",
  });
  expect(res3.code).not.toBe(0);

  const res4 = await runWithEnv({
    DEVFLOW_PORT: "19999",
    DEVFLOW_DATA_DIR: "C:/dummy/data",
    DEVFLOW_IDENTITY: undefined,
  });
  expect(res4.code).not.toBe(0);
});
