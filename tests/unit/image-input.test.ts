import { it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localImageProblem, imagePathsInArguments } from "../../packages/runtime/src/image-input.js";
import { classifyFailure } from "../../packages/runtime/src/errors.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
it("returns damaged image paths to the model and accepts correctly extracted screenshot data without modifying files", () => {
  const root = mkdtempSync(join(tmpdir(), "image-input-")), file = join(root, "截图.png");
  try {
    const raw = JSON.stringify({ image: png });
    const bad = Buffer.from(raw, "base64");
    writeFileSync(file, bad);
    expect(localImageProblem(file)).toBe(`本地的 ${file} 图片损坏，请检查保存格式。`);
    expect(readFileSync(file)).toEqual(bad);
    writeFileSync(file, Buffer.from(JSON.parse(raw).image, "base64"));
    expect(localImageProblem(file)).toBeUndefined();
    writeFileSync(file, Buffer.from(png, "base64").subarray(0, 40));
    expect(localImageProblem(file)).toContain("图片损坏");
    expect(localImageProblem(join(root, "missing.png"))).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("discovers image inputs by path without choosing or parsing model tools and shell commands", () => {
  expect(imagePathsInArguments({ arbitrary_tool_args: { files: ["C:/work/a.png", "C:/work/b.jpg"] },
    command: "node -e write('C:/work/other.png')" })).toEqual(["C:/work/a.png", "C:/work/b.jpg"]);
});
it("classifies invalid model requests precisely without calling every HTTP 400 image corruption", () => {
  expect(classifyFailure("INVALID_ARGUMENT (code 400): Request contains an invalid argument.").code).toBe("MODEL_REQUEST_INVALID");
  expect(classifyFailure("业务接口 HTTP 400").code).toBe("EXECUTION_FAILED");
});
