export type CatchupEvent = {
  workflow_id?: string;
  event_seq: number;
};

export type CatchupPage = {
  events?: CatchupEvent[];
  next_before?: number | null;
};

export type CatchupCursor = {
  watermark: number;
  targetUpper?: number;
  startWatermark?: number;
  before?: number;
};

export const CATCHUP_PAGE_LIMIT = 20;
export const CATCHUP_EVENT_LIMIT = 4000;
export const CATCHUP_PAGE_SIZE = 200;

export function applyCatchupPage(
  cursor: CatchupCursor,
  page: CatchupPage,
  workflow: string,
): { cursor: CatchupCursor; deliver: CatchupEvent[]; more: boolean } {
  const events = uniqueSorted(pageEvents(page, workflow));
  if (cursor.targetUpper == null) {
    return startCatchupRound(cursor, events, page);
  }
  return continueCatchupRound(cursor, events, page);
}

export async function catchupRound(options: {
  cursor: CatchupCursor;
  workflow: string;
  read: (path: string) => Promise<CatchupPage>;
  receive: (events: CatchupEvent[]) => void;
  isStopped: () => boolean;
  pageLimit?: number;
  eventLimit?: number;
}): Promise<CatchupCursor> {
  let cursor = options.cursor;
  let pages = 0;
  let delivered = 0;
  const pageLimit = options.pageLimit ?? CATCHUP_PAGE_LIMIT;
  const eventLimit = options.eventLimit ?? CATCHUP_EVENT_LIMIT;
  while (
    !options.isStopped() &&
    pages < pageLimit &&
    delivered < eventLimit
  ) {
    let page: CatchupPage;
    try {
      page = await options.read(historyPath(options.workflow, cursor.before));
    } catch {
      return cursor;
    }
    if (options.isStopped()) return cursor;
    const next = applyCatchupPage(cursor, page, options.workflow);
    cursor = next.cursor;
    pages += 1;
    if (next.deliver.length) {
      options.receive(next.deliver);
      delivered += next.deliver.length;
    }
    if (!next.more) break;
  }
  return cursor;
}

function startCatchupRound(
  cursor: CatchupCursor,
  events: CatchupEvent[],
  page: CatchupPage,
): { cursor: CatchupCursor; deliver: CatchupEvent[]; more: boolean } {
  if (!events.length) {
    return { cursor, deliver: [], more: false };
  }
  const targetUpper = events[events.length - 1]!.event_seq;
  const startWatermark = cursor.watermark;
  if (targetUpper <= startWatermark) {
    return { cursor, deliver: [], more: false };
  }
  return continueCatchupRound(
    {
      watermark: cursor.watermark,
      targetUpper,
      startWatermark,
    },
    events,
    page,
  );
}

function continueCatchupRound(
  cursor: CatchupCursor,
  events: CatchupEvent[],
  page: CatchupPage,
): { cursor: CatchupCursor; deliver: CatchupEvent[]; more: boolean } {
  const startWatermark = cursor.startWatermark ?? cursor.watermark;
  const targetUpper = cursor.targetUpper!;
  const deliver = events.filter(
    (event) =>
      event.event_seq > startWatermark && event.event_seq <= targetUpper,
  );
  const minSeq = events[0]?.event_seq;
  const stalled =
    cursor.before != null && minSeq != null && minSeq >= cursor.before;
  const reachedStart = minSeq != null && minSeq <= startWatermark + 1;
  const historyEnd =
    events.length === 0 || page.next_before == null || stalled;
  if (reachedStart || historyEnd) {
    return {
      cursor: { watermark: targetUpper },
      deliver,
      more: false,
    };
  }
  return {
    cursor: {
      watermark: cursor.watermark,
      targetUpper,
      startWatermark,
      before: minSeq,
    },
    deliver,
    more: true,
  };
}

function historyPath(workflow: string, before?: number) {
  const base = `/workflows/${workflow}/history?limit=${CATCHUP_PAGE_SIZE}`;
  return before ? `${base}&before=${before}` : base;
}

function pageEvents(page: CatchupPage, workflow: string): CatchupEvent[] {
  if (!Array.isArray(page.events)) return [];
  return page.events.filter((event) => event.workflow_id === workflow);
}

function uniqueSorted(events: CatchupEvent[]) {
  return [
    ...new Map(events.map((event) => [event.event_seq, event])).values(),
  ].sort((left, right) => left.event_seq - right.event_seq);
}
