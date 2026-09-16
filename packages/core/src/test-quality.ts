import { existsSync, readFileSync } from "node:fs";
import { FlowError } from "../../contracts/src/index.js";
import { safePath } from "../../workspace/src/files.js";

/** Reject the concrete placeholder pattern; this is a minimum check, not a
 * substitute for reviewing whether assertions prove the requested behavior. */
export function assertMeaningfulTestFiles(root: string, paths: string[]) {
  for (const path of paths) {
    if (!/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(path)) continue;
    const file = safePath(root, path);
    if (!existsSync(file)) continue;
    const source = readFileSync(file, "utf8");
    const assertions = [...source.matchAll(/\bexpect\s*\(/g)];
    const constant = [
      ...source.matchAll(
        /\bexpect\s*\(\s*(true|false|null|\d+)\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(\s*\1\s*\)/g,
      ),
    ];
    if (assertions.length && assertions.length === constant.length)
      throw new FlowError(
        "TEST_PLACEHOLDER",
        `测试文件 ${path} 只有恒真断言。请在原用例中执行真实操作并验证业务结果，再提交实现或运行检查。`,
        422,
      );
  }
}
