import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  resolveChannelPreviewStreamMode,
  resolveChannelStreamingPreviewToolProgress,
} from "../channels/streaming.js";
import { resolveMergedAccountConfig } from "../config/channel-account-config.js";
import { resolveChannelConfigRecord } from "../config/channel-configured-shared.js";
import { resolveControlUiSessionUrl } from "../config/control-ui-link-base.js";
import { resolveMessageActionOutcome } from "../infra/outbound/message-action-contracts.js";
import { runMessageAction } from "../infra/outbound/message-action-runner.js";
import { getRuntimeConfig } from "../infra/outbound/message.config.runtime.js";
import type { TaskProgressMessageTarget } from "./task-progress-message.js";

// Runtime delivery seam for task terminal/state-change notifications.
export { sendMessage } from "../infra/outbound/message.js";

export function isTaskProgressEnabled(
  channel: string | undefined,
  accountId: string | undefined,
): boolean {
  if (!channel || !accountId) {
    return false;
  }
  const channelConfig = resolveChannelConfigRecord(getRuntimeConfig(), channel) ?? undefined;
  const accountRecords = asOptionalRecord(channelConfig?.accounts);
  const accounts = accountRecords
    ? Object.fromEntries(
        Object.entries(accountRecords).map(([id, value]) => [id, asOptionalRecord(value) ?? {}]),
      )
    : undefined;
  const entry = resolveMergedAccountConfig({
    channelConfig,
    accounts,
    accountId,
    channelId: channel,
  });
  const streaming = { streaming: entry.streaming };
  const mode = resolveChannelPreviewStreamMode(streaming, "off");
  return mode === "progress" && resolveChannelStreamingPreviewToolProgress(streaming, true, mode);
}

export async function editTaskProgressMessage(
  params: TaskProgressMessageTarget & {
    content: string;
    agentId?: string;
    assertCurrent: () => void;
  },
): Promise<void> {
  params.assertCurrent();
  const result = await runMessageAction({
    cfg: getRuntimeConfig(),
    action: "edit",
    params: {
      channel: params.channel,
      target: params.to,
      accountId: params.accountId,
      threadId: params.threadId,
      messageId: params.messageId,
      message: params.content,
    },
    agentId: params.agentId,
    gatewayOwnedDelivery: true,
    suppressTranscriptMirror: true,
    assertDirectAdapterHandoff: params.assertCurrent,
  });
  const outcome = resolveMessageActionOutcome(result);
  if (!outcome.ok) {
    throw new Error(outcome.error);
  }
}

export function resolveTaskControlUiSessionUrl(params: {
  sessionKey: string;
  fallbackAgentId?: string;
}): string | undefined {
  return resolveControlUiSessionUrl(getRuntimeConfig(), { ...params, exactKey: true });
}
