import {
  ATTACHMENT_HANDOFF_NOTICE,
  DEFAULT_ATTACHMENT_PROMPT,
  type ConversationFile,
  type ConversationInputMode,
  type ToolProfile,
} from "../../contracts/src/index.js";
import {
  resolveConversationInputAttachments,
  type ConversationInputResolveResult,
  type FileInputCapability,
} from "../../runtime/src/conversation-inputs.js";

export interface ConversationInputMaterials {
  text: string;
  notice: string;
  deliver_to_main_model: boolean;
  resolved: ConversationInputResolveResult;
}

export function deliveredConversationText(
  text: string,
  attachmentCount: number,
): string {
  if (text.trim()) return text;
  return attachmentCount > 0 ? DEFAULT_ATTACHMENT_PROMPT : text;
}

export function attachmentsGoToMainModel(
  mode: ConversationInputMode,
): boolean {
  return mode !== "aside";
}

export function emptyConversationInputResolve(): ConversationInputResolveResult {
  return {
    ok: true,
    attachments: [],
    extraReadRoots: [],
    delivery: {
      stage: "prepared",
      delivered: false,
      observed: false,
    },
  };
}

export function prepareConversationInputMaterials(params: {
  text: string;
  mode: ConversationInputMode;
  files: ConversationFile[];
  storageRoot: string;
  workflowId: string;
  profile: ToolProfile;
  fileInput: FileInputCapability;
}): ConversationInputMaterials {
  const resolved =
    params.files.length === 0
      ? emptyConversationInputResolve()
      : resolveConversationInputAttachments({
          files: params.files,
          storageRoot: params.storageRoot,
          workflowId: params.workflowId,
          profile: params.profile,
          fileInput: params.fileInput,
        });
  return {
    text: deliveredConversationText(params.text, params.files.length),
    notice: ATTACHMENT_HANDOFF_NOTICE,
    deliver_to_main_model: attachmentsGoToMainModel(params.mode),
    resolved,
  };
}
