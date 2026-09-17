import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  publishTaskProgressMessage,
  type TaskProgressMessageState,
} from "./task-progress-message.js";
import type { TaskRegistryDeliveryRuntime } from "./task-registry-runtime-loaders.js";

const { telegramPlugin } = await loadBundledPluginFacade<{ telegramPlugin: ChannelPlugin }>({
  pluginId: "telegram",
  artifactBasename: "channel-plugin-api.js",
});
const { msteamsPlugin } = await loadBundledPluginFacade<{ msteamsPlugin: ChannelPlugin }>({
  pluginId: "msteams",
  artifactBasename: "channel-plugin-api.js",
});

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
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "telegram", source: "test", plugin: telegramPlugin },
        { pluginId: "msteams", source: "test", plugin: msteamsPlugin },
        {
          pluginId: "discord",
          source: "test",
          plugin: createChannelTestPluginBase({ id: "discord", label: "Discord" }),
        },
      ]),
    );
  });
  afterEach(() => setActivePluginRegistry(createTestRegistry()));

  it("preserves Teams conversation receipt syntax without a projection hook", async () => {
    const conversationId = "19:actual-conversation@thread.tacv2";
    const runtime = {
      sendMessage: vi.fn(async () => ({
        ...delivery(),
        channel: "msteams",
        result: {
          channel: "msteams",
          messageId: "progress-message",
          target: { kind: "conversation" as const, id: conversationId },
        },
      })),
      editTaskProgressMessage: vi.fn(async (target) => {
        expect(msteamsPlugin.messaging?.normalizeTarget?.(target.to)).toBe(
          `conversation:${conversationId}`,
        );
      }),
    } satisfies TaskRegistryDeliveryRuntime;
    const state: TaskProgressMessageState = {};
    const teamsParams = { ...params, channel: "msteams" };
    await publishTaskProgressMessage(state, teamsParams, runtime);
    await publishTaskProgressMessage(state, { ...teamsParams, content: "Done" }, runtime);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(runtime.editTaskProgressMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        channel: "msteams",
        to: `conversation:${conversationId}`,
        accountId: "work",
        threadId: "child-thread",
        messageId: "progress-message",
      }),
    );
  });

  it.each([true, false])(
    "honors plugin-owned room projection (target available: %s)",
    async (routable) => {
      const resolveDeliveryTarget = vi.fn(() => ({
        ...(routable ? { to: "room:actual-room" } : {}),
        threadId: "actual-thread",
      }));
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "room-chat",
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({ id: "room-chat", label: "Room chat" }),
              messaging: { resolveDeliveryTarget },
            },
          },
        ]),
      );
      const runtime = {
        sendMessage: vi.fn(async () => ({
          ...delivery(),
          channel: "room-chat",
          result: {
            channel: "room-chat",
            messageId: "progress-message",
            target: { kind: "room" as const, id: "actual-room" },
          },
        })),
        editTaskProgressMessage: vi.fn(async () => {}),
      } satisfies TaskRegistryDeliveryRuntime;
      const state: TaskProgressMessageState = {};
      const roomParams = { ...params, channel: "room-chat" };
      await publishTaskProgressMessage(state, roomParams, runtime);
      await publishTaskProgressMessage(state, { ...roomParams, content: "Done" }, runtime);
      expect(resolveDeliveryTarget).toHaveBeenCalledExactlyOnceWith({
        conversationId: "actual-room",
      });
      if (routable) {
        expect(runtime.editTaskProgressMessage).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            to: "room:actual-room",
            threadId: "actual-thread",
            accountId: "work",
          }),
        );
      } else {
        expect(runtime.editTaskProgressMessage).not.toHaveBeenCalled();
      }
      expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["123456789", "-100987654321"])(
    "round-trips Telegram receipt chat %s through its channel target contract",
    async (chatId) => {
      const telegramParams = {
        ...params,
        channel: "telegram",
        to: "@original_alias",
        threadId: "42",
      };
      const runtime = {
        sendMessage: vi.fn(async () => ({
          ...delivery(),
          channel: "telegram",
          result: {
            channel: "telegram",
            messageId: "progress-message",
            target: { kind: "chat" as const, id: chatId },
            receipt: {
              platformMessageIds: ["progress-message"],
              parts: [],
              threadId: "77",
              sentAt: 1,
            },
          },
        })),
        editTaskProgressMessage: vi.fn(async (target) => {
          target.assertCurrent();
          expect(telegramPlugin.messaging?.normalizeTarget?.(target.to)).toBe(`telegram:${chatId}`);
        }),
      } satisfies TaskRegistryDeliveryRuntime;
      const state: TaskProgressMessageState = {};
      await publishTaskProgressMessage(state, telegramParams, runtime);
      await publishTaskProgressMessage(state, { ...telegramParams, content: "Done" }, runtime);
      expect(runtime.editTaskProgressMessage).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          channel: "telegram",
          to: chatId,
          accountId: "work",
          threadId: "77",
          messageId: "progress-message",
          content: "Done",
        }),
      );
      await expect(
        publishTaskProgressMessage(
          state,
          {
            ...telegramParams,
            content: "Revoked",
            assertDirectAdapterHandoff: () => {
              throw new Error("owner revoked");
            },
          },
          runtime,
        ),
      ).rejects.toThrow("owner revoked");
      expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
      expect(runtime.editTaskProgressMessage).toHaveBeenCalledTimes(1);
    },
  );

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
