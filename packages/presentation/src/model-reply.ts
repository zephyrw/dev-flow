/** Project the model's own final prose, without replacing it with workflow status. */
export function modelReplyText(response: unknown): string | undefined {
  if (typeof response !== "string" || !response.trim()) return undefined;
  try {
    const value = JSON.parse(response);
    const parts = [value?.summary, value?.notes]
      .filter((part): part is string => typeof part === "string" && !!part.trim());
    if (parts.length) return [...new Set(parts)].join("\n\n");
  } catch { /* Plain text and Markdown are already public model replies. */ }
  return response;
}
