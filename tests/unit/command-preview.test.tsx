// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPreview } from "../../apps/web/src/command-preview.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("command working directory (REV-05 / U5)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let resize: (() => void) | undefined;
  let width = 100;

  beforeEach(() => {
    width = 100;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(100);
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resize = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows a short command's directory without creating an expand button", () => {
    act(() => root.render(<CommandPreview command="pwd" cwd="C:/repo" />));
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("工作目录：C:/repo");
  });

  it("keeps one directory visible while expanding, collapsing, and resizing", () => {
    width = 50;
    act(() => root.render(<CommandPreview command="git status --short" cwd="C:/repo" />));
    const toggle = () => act(() => container.querySelector<HTMLButtonElement>("button")!.click());
    toggle();
    expect(container.querySelector("pre")?.textContent).toBe("git status --short");
    expect(container.querySelectorAll(".notice-subtle")).toHaveLength(1);
    toggle();
    expect(container.querySelector("pre")).toBeNull();
    expect(container.textContent).toContain("工作目录：C:/repo");
    toggle();
    act(() => { width = 200; resize?.(); });
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("工作目录：C:/repo");
    expect(container.querySelectorAll(".notice-subtle")).toHaveLength(1);
  });
});
