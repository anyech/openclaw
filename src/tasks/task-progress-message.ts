import type { TaskRegistryDeliveryRuntime } from "./task-registry-runtime-loaders.js";

type ProgressSendParams = Parameters<TaskRegistryDeliveryRuntime["sendMessage"]>[0] & {
  assertDirectAdapterHandoff: () => void;
};

export type TaskProgressMessageTarget = {
  channel: string;
  to: string;
  accountId: string;
  threadId?: string | number;
  messageId: string;
};

/** Ephemeral presentation state, owned and bounded by the progress batch. */
export type TaskProgressMessageState = {
  attempted?: boolean;
  originKey?: string;
  target?: TaskProgressMessageTarget;
  content?: string;
  pending?: Promise<void>;
};

/** A failed or identityless first send must never create another progress message. */
export function publishTaskProgressMessage(
  state: TaskProgressMessageState,
  params: ProgressSendParams,
  runtime: TaskRegistryDeliveryRuntime,
): Promise<void> {
  const publish = async () => {
    params.assertDirectAdapterHandoff();
    const originKey = JSON.stringify([
      params.channel,
      params.to,
      params.accountId,
      params.threadId,
      params.agentId,
    ]);
    if (state.attempted) {
      if (state.originKey !== originKey) {
        throw new Error("Background progress destination changed");
      }
      if (!state.target || !runtime.editTaskProgressMessage || state.content === params.content) {
        return;
      }
      await runtime.editTaskProgressMessage({
        ...state.target,
        content: params.content,
        agentId: params.agentId,
        assertCurrent: params.assertDirectAdapterHandoff,
      });
      state.content = params.content;
      return;
    }
    state.attempted = true;
    state.originKey = originKey;
    const sent = await runtime.sendMessage(params);
    const result = sent.result;
    if (
      sent.dryRun ||
      (sent.deliveryStatus !== undefined && sent.deliveryStatus !== "sent") ||
      !result?.messageId ||
      !params.accountId ||
      !("channel" in result) ||
      !result.target ||
      result.outcome === "not_sent" ||
      (result.receipt && result.receipt.platformMessageIds.length !== 1)
    ) {
      return;
    }
    state.target = {
      channel: sent.channel,
      to: `${result.target.kind}:${result.target.id}`,
      accountId: params.accountId,
      threadId: result.receipt?.threadId ?? params.threadId,
      messageId: result.messageId,
    };
    state.content = params.content;
  };
  // Serialize edits even when an event arrives during the initial platform send.
  const pending = (state.pending ?? Promise.resolve()).then(publish);
  state.pending = pending.catch(() => {});
  return pending;
}
