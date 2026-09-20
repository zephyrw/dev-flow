import { useEffect, useRef } from "react";
import { catchupRound, type CatchupCursor } from "./event-catchup.js";

/** Compatibility with an older controller whose WebSocket cannot publish observer-process events. */
export function useEventCatchup(
  workflow: string,
  enabled: boolean,
  read: (path: string) => Promise<any>,
  receive: (events: any[]) => void,
) {
  const callbacks = useRef({ read, receive });
  callbacks.current = { read, receive };
  useEffect(() => {
    if (!workflow || !enabled) return;
    let stopped = false;
    let busy = false;
    let cursor: CatchupCursor = { watermark: 0 };
    const poll = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        cursor = await catchupRound({
          cursor,
          workflow,
          read: (path) => callbacks.current.read(path),
          receive: (events) => {
            if (!stopped && events.length) callbacks.current.receive(events);
          },
          isStopped: () => stopped,
        });
      } finally {
        busy = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [workflow, enabled]);
}
