import { toolSummary } from "./tool-summary.js";

/** Compatibility for the old human-readable CLI stream. Only allowlisted tool lifecycle lines. */
export class ReviewActivityStream {
  private buffer = "";
  private index = 0;
  private pending = new Map<string, string[]>();
  push(text: string) {
    this.buffer += text;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    if (this.buffer.length > 1024 * 1024) this.buffer = "";
    const events: any[] = [];
    for (const line of lines) {
      const match = line
        .trim()
        .match(
          /^mcp:\s*devflow_review\/(devflow_review_(?:context|read_file|search|evidence|hash_document))\s+(started|\(completed\)|\(failed\))$/,
        );
      if (!match) continue;
      const name = match[1]!,
        started = match[2] === "started";
      const queue = this.pending.get(name) ?? [];
      const id = started
        ? `review-${++this.index}`
        : (queue.shift() ?? `review-${++this.index}`);
      if (started) queue.push(id);
      this.pending.set(name, queue);
      events.push({
        id,
        kind: "tool",
        title: toolSummary(name, {}).title ?? "审查工具",
        text: "",
        status: started ? "active" : match[2] === "(failed)" ? "error" : "done",
      });
    }
    return events;
  }
}
