// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanTocButton, usePlanReading } from "../../apps/web/src/plan-reading.js";
import { PlanReviewDialog } from "../../apps/web/src/components/PlanReviewDialog.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Reader({ scope }: { scope: string }) {
  const reading = usePlanReading(scope);
  const [question, setQuestion] = useState(false);
  const body = <>
    <button data-testid="toggle-toc" aria-expanded={reading.showToc}
      onClick={() => reading.setShowToc((visible) => !visible)}>Toggle outline</button>
    {reading.showToc && <div ref={reading.tocRef} data-testid="toc">outline</div>}
    <div ref={reading.contentRef} data-testid="content">long document</div>
  </>;
  return <>
    <button data-testid="enter" onClick={reading.enter}>Enter</button>
    {!reading.fullscreen && body}
    {reading.fullscreen && createPortal(
      <div ref={reading.viewportRef} role="dialog" aria-label="reader" tabIndex={-1}>
        <button data-testid="exit" className="btn-fullscreen-toggle" onClick={reading.exit}>Exit</button>
        <button data-testid="question" onClick={() => setQuestion(true)}>Question</button>
        {body}
      </div>, document.body,
    )}
    {question && <PlanReviewDialog target={{
      workflow_id: "wf", expected_version: 1, plan_revision: 1, plan_hash: "hash", mode: "question",
    }} onClose={() => setQuestion(false)} onRejected={() => setQuestion(false)} />}
  </>;
}

describe("plan reader state and focus (E4/E5 regression components)", () => {
  let container: HTMLDivElement;
  let root: Root;
  const element = (selector: string) => document.querySelector<HTMLElement>(selector)!;
  const click = (selector: string) => act(() => {
    element(selector).focus();
    element(selector).click();
  });
  const escape = () => act(() => {
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.style.overflow = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("restores the actual normal content and outline positions and trigger after portal remount", () => {
    document.body.style.overflow = "auto";
    act(() => root.render(<Reader scope="wf:1:hash:plan" />));
    element('[data-testid="content"]').scrollTop = 480;
    element('[data-testid="toc"]').scrollTop = 160;
    const trigger = element('[data-testid="enter"]');
    click('[data-testid="enter"]');
    expect(element('[data-testid="content"]').scrollTop).toBe(480);
    expect(element('[data-testid="toc"]').scrollTop).toBe(160);
    expect(document.body.style.overflow).toBe("hidden");
    element('[data-testid="content"]').scrollTop = 900;
    element('[data-testid="toc"]').scrollTop = 300;
    escape();
    expect(document.querySelector('[aria-label="reader"]')).toBeNull();
    expect(element('[data-testid="content"]').scrollTop).toBe(480);
    expect(element('[data-testid="toc"]').scrollTop).toBe(160);
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).toBe("auto");
  });

  it("closes only the nested question dialog and returns focus inside the fullscreen reader", async () => {
    act(() => root.render(<Reader scope="wf:1:hash:plan" />));
    click('[data-testid="enter"]');
    await act(async () => { element('[data-testid="question"]').focus(); element('[data-testid="question"]').click(); });
    expect(document.activeElement?.id).toBe("plan-review-text");
    act(() => element('[data-testid="enter"]').focus());
    expect(element(".plan-review-dialog").contains(document.activeElement)).toBe(true);
    escape();
    expect(document.querySelector(".plan-review-dialog")).toBeNull();
    expect(document.querySelector('[aria-label="reader"]')).not.toBeNull();
    expect(document.activeElement).toBe(element('[data-testid="question"]'));
    escape();
    expect(document.querySelector('[aria-label="reader"]')).toBeNull();
  });

  it.each([
    { initiallyExpanded: true, exitWith: "button" },
    { initiallyExpanded: true, exitWith: "Escape" },
    { initiallyExpanded: false, exitWith: "button" },
    { initiallyExpanded: false, exitWith: "Escape" },
  ])("restores outline expanded=$initiallyExpanded after toggling in fullscreen and exiting with $exitWith", ({ initiallyExpanded, exitWith }) => {
    act(() => root.render(<Reader scope="wf:1:hash:plan" />));
    if (!initiallyExpanded) click('[data-testid="toggle-toc"]');
    else element('[data-testid="toc"]').scrollTop = 160;
    element('[data-testid="content"]').scrollTop = 480;
    const trigger = element('[data-testid="enter"]');
    click('[data-testid="enter"]');
    click('[data-testid="toggle-toc"]');
    expect(element('[data-testid="toggle-toc"]').getAttribute("aria-expanded")).toBe(String(!initiallyExpanded));
    element('[data-testid="content"]').scrollTop = 900;
    if (!initiallyExpanded) element('[data-testid="toc"]').scrollTop = 300;

    if (exitWith === "button") click('[data-testid="exit"]');
    else escape();

    expect(document.querySelector('[aria-label="reader"]')).toBeNull();
    expect(element('[data-testid="toggle-toc"]').getAttribute("aria-expanded")).toBe(String(initiallyExpanded));
    if (initiallyExpanded) expect(element('[data-testid="toc"]').scrollTop).toBe(160);
    else expect(document.querySelector('[data-testid="toc"]')).toBeNull();
    expect(element('[data-testid="content"]').scrollTop).toBe(480);
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).toBe("");
  });

  it("discards fullscreen state on scope change and releases body scroll on unmount", () => {
    act(() => root.render(<Reader scope="wf:1:hash:plan" />));
    element('[data-testid="content"]').scrollTop = 480;
    click('[data-testid="enter"]');
    click('[data-testid="toggle-toc"]');
    act(() => root.render(<Reader scope="other:2:hash2:plan" />));
    expect(document.querySelector('[aria-label="reader"]')).toBeNull();
    expect(element('[data-testid="content"]').scrollTop).toBe(0);
    // Switching scope discards the old expanded snapshot instead of restoring it.
    expect(document.querySelector('[data-testid="toc"]')).toBeNull();
    expect(document.body.style.overflow).toBe("");
    // A later entry owns a new snapshot, including the current collapsed preference.
    click('[data-testid="enter"]');
    click('[data-testid="toggle-toc"]');
    escape();
    expect(document.querySelector('[data-testid="toc"]')).toBeNull();
    click('[data-testid="enter"]');
    act(() => root.render(null));
    expect(document.body.style.overflow).toBe("");
  });

  it("keeps the full outline accessible and clickable without a hover or focus tooltip", () => {
    const title = "Long heading ".repeat(40);
    const onClick = vi.fn();
    act(() => root.render(<div style={{ overflow: "hidden" }}><PlanTocButton text={title} onClick={onClick} /></div>));
    act(() => element(".toc-link-btn").dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    act(() => element(".toc-link-btn").focus());
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(element(".toc-link-btn").getAttribute("aria-label")).toBe(title);
    expect(element(".toc-link-btn").hasAttribute("title")).toBe(false);
    expect(element(".toc-link-btn").hasAttribute("aria-describedby")).toBe(false);
    click(".toc-link-btn");
    expect(onClick).toHaveBeenCalledOnce();
  });
});
