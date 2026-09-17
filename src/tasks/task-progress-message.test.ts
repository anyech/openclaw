import { describe, expect, it, vi } from "vitest";
import {
  publishTaskProgressMessage,
  type TaskProgressMessageState,
} from "./task-progress-message.js";
import type { TaskRegistryDeliveryRuntime } from "./task-registry-runtime-loaders.js";

const params = {
  channel: "discord",
  to: "channel:parent",
  threadId: "child-thread",
  accountId: "work",
  content: "Working",
  assertDirectAdapterHandoff: () => {},
};

function delivery() {
  return {
    channel: "discord",
    to: "channel:parent",
    via: "direct" as const,
    mediaUrl: null,
    result: {
      channel: "discord",
      messageId: "progress-message",
      target: { kind: "channel" as const, id: "child-thread" },
    },
  };
}

describe("task progress message delivery", () => {
  it("serializes concurrent updates onto the identified message in its actual thread", async () => {
    let release!: () => void;
    const sent = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = {
      sendMessage: vi.fn(async () => {
        await sent;
        return delivery();
      }),
      editTaskProgressMessage: vi.fn(async () => {}),
    } satisfies TaskRegistryDeliveryRuntime;
    const state: TaskProgressMessageState = {};
    const first = publishTaskProgressMessage(state, params, runtime);
    const second = publishTaskProgressMessage(state, { ...params, content: "Done" }, runtime);
    await Promise.resolve();
    expect(runtime.editTaskProgressMessage).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);
    await publishTaskProgressMessage(state, { ...params, content: "Done" }, runtime);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(runtime.editTaskProgressMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        channel: "discord",
        to: "channel:child-thread",
        accountId: "work",
        threadId: "child-thread",
        messageId: "progress-message",
        content: "Done",
      }),
    );
  });

  it.each(["ambiguous", "identityless"])("does not resend after an %s send", async (mode) => {
    const runtime = {
      sendMessage: vi.fn(async () => {
        if (mode === "ambiguous") {
          throw new Error("connection lost after dispatch");
        }
        return { ...delivery(), result: undefined };
      }),
      editTaskProgressMessage: vi.fn(async () => {}),
    } satisfies TaskRegistryDeliveryRuntime;
    const state: TaskProgressMessageState = {};
    await publishTaskProgressMessage(state, params, runtime).catch(() => {});
    await publishTaskProgressMessage(state, { ...params, content: "Done" }, runtime);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(runtime.editTaskProgressMessage).not.toHaveBeenCalled();
  });

  it("rejects origin drift and revoked authority without editing or sending a replacement", async () => {
    const runtime = {
      sendMessage: vi.fn(async () => delivery()),
      editTaskProgressMessage: vi.fn(async () => {}),
    } satisfies TaskRegistryDeliveryRuntime;
    const state: TaskProgressMessageState = {};
    await publishTaskProgressMessage(state, params, runtime);
    await expect(
      publishTaskProgressMessage(
        state,
        { ...params, accountId: "other", content: "Done" },
        runtime,
      ),
    ).rejects.toThrow("destination changed");
    await expect(
      publishTaskProgressMessage(
        state,
        {
          ...params,
          content: "Done",
          assertDirectAdapterHandoff: () => {
            throw new Error("owner revoked");
          },
        },
        runtime,
      ),
    ).rejects.toThrow("owner revoked");
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(runtime.editTaskProgressMessage).not.toHaveBeenCalled();
  });
});
