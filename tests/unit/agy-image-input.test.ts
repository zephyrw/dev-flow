import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AgyNativeCliAdapter } from "../../packages/adapters/agy/src/adapter.js";
import { clientInvocation } from "../../packages/adapters/sdk/src/invocation.js";
import type { RunContext } from "../../packages/adapters/sdk/src/interface.js";
import { AGY_IMAGE_FILE_INPUT, supportsAttachmentInput } from "../../packages/contracts/src/attachment-capabilities.js";
import type { ResolvedInputAttachment } from "../../packages/contracts/src/conversation-input.js";
import { buildComposerRuntime } from "../../apps/web/src/components/ConversationStatusBar.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agy-image-")));
  dirs.push(root);
  const path = join(root, "中文 content");
  const bytes = Buffer.from("image fixture bytes");
  writeFileSync(path, bytes);
  const file: ResolvedInputAttachment = { id: "file1", display_name: '截图 "一".png',
    absolute_path: path, mime: "image/png", read_mode: "image", size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") };
  const input: RunContext = { workflowId: "wf1", runId: "run1", epoch: 1,
    stage: "execute", purpose: "implement", workspaceRoots: { main: root },
    allowedPaths: [], prompt: "请检查图片", conversationId: "old-session",
    toolProfile: { id: "agy", revision: 1, adapterId: "agy", modelSelection: "native-config", options: {} },
    inputAttachments: [file] };
  return { root, file, input };
}

describe("AGY image file input", () => {
  it.each(["planning", "implement"] as const)("passes the file manifest and scoped roots in %s and preserves resume", (purpose) => {
    const { file, input } = fixture();
    input.purpose = purpose;
    input.inputAttachments = [file, { ...file, id: "file2", display_name: "two.jpg", mime: "image/jpeg" }];
    const inv = new AgyNativeCliAdapter().buildInvocation(input, "agy");
    const prompt = inv.args[inv.args.indexOf("-p") + 1]!;
    expect(prompt).toContain("view_file");
    const manifest = JSON.parse(prompt.split("\n").at(-1)!);
    expect(manifest).toHaveLength(2);
    expect(manifest[0]).toMatchObject({ absolute_path: file.absolute_path, sha256: file.sha256, display_name: file.display_name });
    expect(inv.args[inv.args.indexOf("--conversation") + 1]).toBe("old-session");
    expect(inv.args[inv.args.indexOf("--mode") + 1]).toBe(purpose === "planning" ? "plan" : "accept-edits");
    expect(inv.args.filter((arg) => arg === "--add-dir")).toHaveLength(2); // workspace + one attachment root
  });
  it("leaves text-only invocations unchanged", () => {
    const { input } = fixture();
    input.inputAttachments = [];
    expect(new AgyNativeCliAdapter().buildInvocation(input, "agy"))
      .toEqual(clientInvocation("agy", input, "agy"));
  });
  it.each(["missing", "changed", "unsupported"])("rejects %s input instead of silently dropping it", (failure) => {
    const { file, input } = fixture();
    if (failure === "missing") file.absolute_path += ".missing";
    if (failure === "changed") writeFileSync(file.absolute_path, "replaced");
    if (failure === "unsupported") file.mime = "image/webp";
    expect(() => new AgyNativeCliAdapter().buildInvocation(input, "agy"))
      .toThrow(failure === "unsupported" ? "PNG/JPEG" : "内容已变化");
  });
  it("normalizes JPEG MIME and preserves unrestricted capabilities of other tools", () => {
    expect(supportsAttachmentInput("image", AGY_IMAGE_FILE_INPUT, "IMAGE/JPG; x=1")).toBe(true);
    expect(supportsAttachmentInput("image", AGY_IMAGE_FILE_INPUT, "image/gif")).toBe(false);
    expect(supportsAttachmentInput("image", { text: true, image: true, binary: false }, "image/gif")).toBe(true);
  });
  it("uses the current executor for input even while the old planner is displayed", () => {
    const runtime = buildComposerRuntime({ workflow: { id: "wf1", run_id: "run1", state: "FUNCTIONAL_REVIEW" },
      runs: [{ id: "run1", profile: { adapterId: "agy" } }],
      conversation_tree: { active_root_id: "planner", nodes: [{ id: "planner", kind: "main", adapter_id: "codex" }],
        capabilities: { discovery: "scoped-record", file_input: { text: false, image: false, binary: false } } } });
    expect(runtime.fileInput).toEqual(AGY_IMAGE_FILE_INPUT);
  });
});
