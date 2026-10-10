// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RequirementComposer } from "../../apps/web/src/components/RequirementComposer.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

async function selectReference() {
  await act(() => root.render(<RequirementComposer initialText="先  后" onSubmit={() => {}}
    fetchReferences={async () => [{ ref_id: "reference", repo_id: "main", relative_path: "src/main.ts", kind: "file" }]} />));
  const textarea = container.querySelector("textarea")!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(() => {
    setValue.call(textarea, "先 @ 后"); textarea.setSelectionRange(3, 3);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(() => vi.advanceTimersByTimeAsync(200));
  const candidate = Array.from(document.querySelectorAll(".reference-popup span")).find(node => node.textContent === "src/main.ts")!;
  await act(() => { candidate.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  return { textarea, setValue };
}

it("places the caret immediately after a selected inline reference before the next key event", async () => {
  const { textarea } = await selectReference();
  expect(textarea.value).toBe("先 @src/main.ts  后");
  expect(document.activeElement).toBe(textarea);
  expect(textarea.selectionStart).toBe("先 @src/main.ts ".length);
  expect(textarea.selectionEnd).toBe(textarea.selectionStart);
});

it("does not rewind user text or steal focus when old timer time elapses after selection", async () => {
  const { textarea, setValue } = await selectReference();
  await act(() => {
    const cursor = textarea.selectionStart;
    setValue.call(textarea, textarea.value.slice(0, cursor) + "继续优化" + textarea.value.slice(cursor));
    textarea.setSelectionRange(cursor + 4, cursor + 4);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const before = textarea.selectionStart;
  const other = document.createElement("button"); container.append(other); other.focus();
  await act(() => vi.advanceTimersByTimeAsync(20));
  expect(textarea.value).toBe("先 @src/main.ts 继续优化 后");
  expect(textarea.selectionStart).toBe(before);
  expect(document.activeElement).toBe(other);
});
