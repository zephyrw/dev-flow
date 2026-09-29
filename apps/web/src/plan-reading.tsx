import React, { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]',
  )).filter((element) => element.tabIndex >= 0 &&
    !element.matches(':disabled, [hidden], [aria-hidden="true"]') &&
    element.getClientRects().length > 0);
}

export function containTab(event: KeyboardEvent, root: HTMLElement) {
  if (event.key !== "Tab") return;
  const elements = focusableElements(root);
  const first = elements[0];
  const last = elements.at(-1);
  if (!first || !last) {
    event.preventDefault();
    root.focus({ preventScroll: true });
  } else if (document.activeElement === root || !root.contains(document.activeElement) ||
    (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus({ preventScroll: true });
  }
}

interface ReadingPosition {
  scrollTop: number;
  headingId?: string;
  offset: number;
}

function capturePosition(container: HTMLElement): ReadingPosition {
  const top = container.getBoundingClientRect().top;
  const headings = Array.from(container.querySelectorAll<HTMLElement>(".document :is(h1,h2,h3,h4,h5,h6)[id]"));
  const heading = headings.filter((node) => node.getBoundingClientRect().top <= top + 1).at(-1);
  return {
    scrollTop: container.scrollTop,
    headingId: heading?.id,
    offset: heading ? top - heading.getBoundingClientRect().top : 0,
  };
}

function restorePosition(container: HTMLElement, position: ReadingPosition) {
  const heading = Array.from(container.querySelectorAll<HTMLElement>("[id]"))
    .find((node) => node.id === position.headingId);
  container.scrollTop = heading
    ? container.scrollTop + heading.getBoundingClientRect().top - container.getBoundingClientRect().top + position.offset
    : position.scrollTop;
}

/** The normal reader and portal each own an actual scrolling content element. */
export function usePlanReading(scope: string) {
  const [fullscreenScope, setFullscreenScope] = useState<string | null>(null);
  const [showToc, setShowToc] = useState(true);
  const fullscreen = fullscreenScope === scope;
  const contentRef = useRef<HTMLDivElement>(null);
  const tocRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const saved = useRef<{
    scope: string;
    content: ReadingPosition;
    showToc: boolean;
    toc: number;
    trigger: HTMLElement | null;
  } | null>(null);
  const previousFullscreen = useRef(false);

  const enter = () => {
    if (!contentRef.current) return;
    saved.current = {
      scope,
      content: capturePosition(contentRef.current),
      showToc,
      toc: tocRef.current?.scrollTop ?? 0,
      trigger: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    };
    setFullscreenScope(scope);
  };
  const exit = () => {
    const snapshot = saved.current;
    // Restore the outline before the exit layout effect reads its remounted ref.
    // A different task/revision must never receive the old reader's snapshot.
    if (snapshot?.scope === scope) setShowToc(snapshot.showToc);
    setFullscreenScope(null);
  };

  useLayoutEffect(() => {
    const snapshot = saved.current;
    if (!snapshot || snapshot.scope !== scope) {
      saved.current = null;
      setFullscreenScope(null);
    } else if (contentRef.current && (fullscreen || previousFullscreen.current)) {
      restorePosition(contentRef.current, snapshot.content);
      if (tocRef.current) tocRef.current.scrollTop = snapshot.toc;
      if (!fullscreen && snapshot.trigger?.isConnected) snapshot.trigger.focus({ preventScroll: true });
    }
    previousFullscreen.current = fullscreen;
    if (!fullscreen) return;

    const viewport = viewportRef.current;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    (viewport?.querySelector<HTMLElement>(".btn-fullscreen-toggle") ?? viewport)?.focus({ preventScroll: true });
    const hasTopDialog = () => Boolean(document.querySelector(".modal-backdrop, .diagram-lightbox-modal"));
    const onKey = (event: KeyboardEvent) => {
      if (hasTopDialog() || !viewport) return;
      if (event.key === "Escape") {
        event.preventDefault();
        exit();
      } else containTab(event, viewport);
    };
    const onFocus = (event: FocusEvent) => {
      if (!viewport || hasTopDialog() || viewport.contains(event.target as Node)) return;
      (focusableElements(viewport)[0] ?? viewport).focus({ preventScroll: true });
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
    };
  }, [scope, fullscreen]);

  return { fullscreen, enter, exit, showToc, setShowToc, contentRef, tocRef, viewportRef };
}

export function PlanTocButton({ text, onClick }: { text: string; onClick: () => void }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const hovered = useRef(false);
  const focused = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = React.useId();

  const cancelClose = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const leave = () => {
    hovered.current = false;
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (!hovered.current && !focused.current) setOpen(false);
      closeTimer.current = null;
    }, 150);
  };
  useLayoutEffect(() => () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
  }, []);

  useLayoutEffect(() => {
    if (!open || !trigger.current || !tooltip.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const box = tooltip.current.getBoundingClientRect();
    const margin = 8;
    const width = document.documentElement.clientWidth;
    const height = document.documentElement.clientHeight;
    const below = anchor.bottom + margin;
    setPosition({
      left: Math.max(margin, Math.min(anchor.left, width - box.width - margin)),
      top: Math.max(margin, Math.min(below + box.height <= height - margin
        ? below : anchor.top - box.height - margin, height - box.height - margin)),
    });
    const close = (event: Event) => {
      if (event.type === "scroll" && event.target instanceof Node && tooltip.current?.contains(event.target)) return;
      setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", escape);
    };
  }, [open, text]);

  return <>
    <button ref={trigger} type="button" className="toc-link-btn" aria-label={text}
      aria-describedby={open ? id : undefined}
      onClick={() => { setOpen(false); onClick(); }}
      onMouseEnter={() => { cancelClose(); hovered.current = true; setOpen(true); }}
      onMouseLeave={leave}
      onFocus={() => { focused.current = true; setOpen(true); }}
      onBlur={() => { focused.current = false; if (!hovered.current) setOpen(false); }}
      onKeyDown={(event) => {
        if (!open) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          return;
        }
        const box = tooltip.current;
        if (!box || box.scrollHeight <= box.clientHeight) return;
        const distance = event.key === "ArrowDown" ? 40 : event.key === "ArrowUp" ? -40
          : event.key === "PageDown" ? box.clientHeight : event.key === "PageUp" ? -box.clientHeight : 0;
        if (distance) {
          event.preventDefault();
          box.scrollTop += distance;
        }
      }}>
      <span className="toc-bullet" />
      <span className="toc-text">{text}</span>
    </button>
    {open && createPortal(<div ref={tooltip} id={id} className="toc-tooltip" role="tooltip"
      onMouseEnter={() => { cancelClose(); hovered.current = true; }}
      onMouseLeave={leave}
      style={{ left: position.left, top: position.top }}>{text}</div>, document.body)}
  </>;
}
