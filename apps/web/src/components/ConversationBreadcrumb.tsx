import React from "react";
import type { ConversationBreadcrumbItem } from "../use-conversation-view.js";
import "../conversation-view.css";

export function ConversationBreadcrumb({
  items,
  onSelect,
}: {
  items: ConversationBreadcrumbItem[];
  onSelect: (conversationId: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <nav className="conversation-breadcrumb" aria-label="会话路径">
      <ol className="conversation-breadcrumb-list">
        {items.map((item, index) => (
          <li key={item.id} className="conversation-breadcrumb-item">
            {index > 0 && (
              <span className="conversation-breadcrumb-sep" aria-hidden="true">
                /
              </span>
            )}
            {item.current ? (
              <span
                className="conversation-breadcrumb-current"
                aria-current="page"
                title={item.title}
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {item.title}
              </span>
            ) : (
              <button
                type="button"
                className="conversation-breadcrumb-link"
                title={item.title}
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                onClick={() => onSelect(item.id)}
              >
                {item.title}
              </button>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
