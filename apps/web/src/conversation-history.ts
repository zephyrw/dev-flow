export interface ConversationHistoryPage {
  items?: unknown[];
  has_more?: boolean;
  next_before_seq?: number | null;
}

export interface ConversationHistorySnapshot {
  items: unknown[];
  hasMore: boolean;
  nextBeforeSeq: number | null;
}

export interface ConversationHistoryRequest {
  readonly workflowId: string;
  readonly conversationId: string;
  readonly generation: number;
  readonly requestId: number;
  readonly kind: "latest" | "older";
  readonly beforeSeq: number | null;
  readonly gapId?: number;
}

interface HistoryGap {
  id: number;
  beforeSeq: number;
  stopAt: number;
}

/** Keep raw event pages until projection, including increments with no visible text. */
export class ConversationHistoryCache {
  private workflowId = "";
  private conversationId: string | null = null;
  private generation = 0;
  private requestId = 0;
  private pending = new Map<ConversationHistoryRequest["kind"], number>();
  private items = new Map<number, unknown>();
  private initialized = false;
  private hasMore = false;
  private nextBeforeSeq: number | null = null;
  private latestBoundary = 0;
  private gaps: HistoryGap[] = [];

  /** Call as soon as the selected identity changes, before accepting any response. */
  select(workflowId: string, conversationId: string | null): void {
    if (workflowId === this.workflowId && conversationId === this.conversationId) return;
    this.workflowId = workflowId;
    this.conversationId = conversationId;
    this.generation += 1;
    this.pending.clear();
    this.items.clear();
    this.initialized = false;
    this.hasMore = false;
    this.nextBeforeSeq = null;
    this.latestBoundary = 0;
    this.gaps = [];
  }

  begin(kind: ConversationHistoryRequest["kind"]): ConversationHistoryRequest | null {
    if (!this.workflowId || !this.conversationId) return null;
    const gap = kind === "older" ? this.gaps[0] : undefined;
    if (kind === "older" && ((!gap && (!this.hasMore || this.nextBeforeSeq === null)) || this.pending.has(kind))) return null;
    const requestId = ++this.requestId;
    this.pending.set(kind, requestId);
    return {
      workflowId: this.workflowId,
      conversationId: this.conversationId,
      generation: this.generation,
      requestId,
      kind,
      beforeSeq: kind === "older" ? gap?.beforeSeq ?? this.nextBeforeSeq : null,
      ...(gap ? { gapId: gap.id } : {}),
    };
  }

  isCurrent(request: ConversationHistoryRequest): boolean {
    return request.workflowId === this.workflowId &&
      request.conversationId === this.conversationId &&
      request.generation === this.generation &&
      this.pending.get(request.kind) === request.requestId;
  }

  /** Finishing a failed request never clears previously loaded data or its cursor. */
  finish(request: ConversationHistoryRequest): boolean {
    if (!this.isCurrent(request)) return false;
    this.pending.delete(request.kind);
    return true;
  }

  applyPage(request: ConversationHistoryRequest, page: ConversationHistoryPage): ConversationHistorySnapshot | null {
    if (!this.isCurrent(request)) return null;
    const cursor = typeof page.next_before_seq === "number" && Number.isFinite(page.next_before_seq)
      ? page.next_before_seq : null;
    const hasMore = page.has_more === true && cursor !== null;
    let previousHead = this.latestBoundary;
    for (const sequence of this.items.keys()) previousHead = Math.max(previousHead, sequence);
    for (const item of page.items ?? []) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const sequence = row.sequence ?? row.event_seq;
      if (typeof sequence !== "number" || !Number.isFinite(sequence)) continue;
      if (typeof row.conversation_id === "string" && row.conversation_id !== request.conversationId) continue;
      this.items.set(sequence, item);
    }
    if (!this.initialized) {
      this.nextBeforeSeq = cursor;
      this.hasMore = hasMore;
      this.initialized = true;
    } else if (request.kind === "latest") {
      // A latest page does not necessarily overlap the previously loaded head.
      // Keep its missing interval separate from the oldest history cursor; even
      // an exhausted history can gain such a gap after reconnecting.
      if (hasMore && cursor! > previousHead) {
        this.gaps.unshift({ id: request.requestId, beforeSeq: cursor!, stopAt: previousHead });
      }
    } else if (request.gapId !== undefined) {
      const gap = this.gaps.find((item) => item.id === request.gapId);
      if (gap) {
        if (!hasMore || cursor! <= gap.stopAt) {
          this.gaps = this.gaps.filter((item) => item.id !== gap.id);
        } else if (cursor! < gap.beforeSeq) {
          gap.beforeSeq = cursor!;
        }
      }
    } else {
      this.nextBeforeSeq = cursor;
      this.hasMore = hasMore;
    }
    // The raw cursor also records progress for a page whose DTOs were all
    // filtered by the server. Do not infer adjacency from event sequence gaps.
    if (request.kind === "latest" && cursor !== null) {
      this.latestBoundary = Math.max(this.latestBoundary, cursor);
    }
    this.finish(request);
    return this.snapshot();
  }

  snapshot(): ConversationHistorySnapshot {
    return {
      items: [...this.items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item),
      hasMore: this.gaps.length > 0 || this.hasMore,
      nextBeforeSeq: this.gaps[0]?.beforeSeq ?? this.nextBeforeSeq,
    };
  }
}
