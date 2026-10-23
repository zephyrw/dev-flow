import { publicDiagnostic } from "./secret-redactor.js";

/** Only call at a trusted conversation boundary, never for diagnostic/export copies. */
export function conversationActivityContent(activity: any): any {
  const projected = publicDiagnostic(activity);
  if (!activity || activity.kind !== "message") return projected;
  for (const key of ["text", "public_text"])
    if (typeof activity[key] === "string") projected[key] = activity[key];
  return projected;
}

/** Legacy provider step envelopes have a separate, explicit message boundary. */
export function conversationAgentContent(payload: any): any {
  const projected = publicDiagnostic(payload);
  const step = payload?.step_update;
  if (step?.step_type === "agent_response" && typeof step.text === "string") {
    projected.step_update = { ...projected.step_update, text: step.text };
  }
  return projected;
}

/** Public workflow events retain authored conversation text, not arbitrary tool output. */
export function publicConversationEvent(event: any): any {
  const projected = publicDiagnostic(event);
  if (!event || typeof event !== "object" || Array.isArray(event)) return projected;
  if (event.type === "ConversationActivity" || event.type === "NativeActivity") {
    projected.payload = conversationActivityContent(event.payload);
  } else if (event.type === "AgentEvent") {
    projected.payload = conversationAgentContent(event.payload);
  } else if (event.type === "UserGuidanceCompleted") {
    for (const key of ["summary", "notes"])
      if (typeof event.payload?.[key] === "string") projected.payload[key] = event.payload[key];
  }
  return projected;
}
