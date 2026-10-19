import React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Older requests sometimes contain a single plain-text paragraph. Keep every
 * word, adding only paragraph boundaries at Chinese sentence punctuation. */
export function readableInteractionText(text: string) {
  if (text.length < 180 || /[\n`]/.test(text) || /[*#\[\]<>]/.test(text)) return text;
  return text.replace(/([。！？；])(?=\S)/gu, "$1\n\n");
}

export function UserInteractionMessage({ text }: { text: string }) {
  return <div className="user-interaction-markdown">
    <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
      img: () => null,
      a: ({ href, children }) => href && /^https?:\/\//i.test(href)
        ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
    }}>{readableInteractionText(text)}</Markdown>
  </div>;
}
