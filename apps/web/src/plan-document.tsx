import type { ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

export interface TocItem {
  id: string;
  text: string;
  level: number;
}

export interface CompiledPlanDocument {
  content: ReactNode;
  toc: TocItem[];
}

// The structural subset needed by this local rehype plugin. Keeping it local
// avoids adding a runtime or type dependency solely to walk the existing AST.
interface MarkdownNode {
  type: string;
  tagName?: string;
  value?: string;
  position?: unknown;
  properties?: Record<string, unknown>;
  children?: MarkdownNode[];
}

export function slugifyHeading(text: string): string {
  const clean = text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "");
  return encodeURIComponent(clean) || "section";
}

export function assignUniqueHeadingId(text: string, usedIds: Set<string>): string {
  const base = slugifyHeading(text);
  let id = base;
  for (let suffix = 1; usedIds.has(id); suffix += 1) {
    id = `${base}-${suffix}`;
  }
  usedIds.add(id);
  return id;
}

function headingText(node: MarkdownNode): string {
  if (node.type === "text" || node.type === "raw") return node.value ?? "";
  if (node.tagName === "br") return " ";
  if (node.tagName === "img") return String(node.properties?.alt ?? "");
  return node.children?.map(headingText).join("") ?? "";
}

function walk(node: MarkdownNode, visit: (node: MarkdownNode) => void): void {
  visit(node);
  node.children?.forEach((child) => walk(child, visit));
}

/** Compile once so the rendered headings and outline share the same AST IDs. */
export function compilePlanDocument(
  text: string,
  components?: Components,
): CompiledPlanDocument {
  const toc: TocItem[] = [];
  function collectHeadings() {
    return (tree: MarkdownNode) => {
      const usedIds = new Set<string>();
      // Preserve IDs used by generated GFM elements, such as footnote labels.
      walk(tree, (node) => {
        const id = node.properties?.id;
        if (typeof id === "string") usedIds.add(id);
      });
      walk(tree, (node) => {
        // Generated headings (for example GFM's footnote label) have no source
        // position and must retain their own accessibility IDs and semantics.
        if (node.type !== "element" || !node.position || !/^h[1-4]$/.test(node.tagName ?? "")) return;
        const title = headingText(node).trim();
        const id = assignUniqueHeadingId(title, usedIds);
        node.properties = { ...node.properties, id };
        if (title) toc.push({ id, text: title, level: Number(node.tagName!.slice(1)) });
      });
    };
  }

  // react-markdown's default entry is synchronous and hook-free. Calling that
  // entry (rather than creating a deferred component) completes the plugin and
  // outline before returning. Custom components still render normally later.
  const content = Markdown({
    children: text,
    remarkPlugins: [remarkGfm],
    rehypePlugins: [collectHeadings],
    components,
  });
  return { content, toc };
}

export function extractToc(text: string): TocItem[] {
  return compilePlanDocument(text).toc;
}
