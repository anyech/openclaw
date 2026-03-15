import { describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { ContextEngineFactory } from "../context-engine/registry.js";
import type { InternalHookHandler } from "../hooks/internal-hooks.js";
import type { HookEntry } from "../hooks/types.js";
import type {
  OpenClawPluginCliContext,
  OpenClawPluginCommandDefinition,
  OpenClawPluginHookOptions,
  OpenClawPluginService,
  PluginHookRegistration,
  ProviderPlugin,
} from "../plugins/types.js";
import {
  resolveExtensionChannelRegistration,
  resolveExtensionCliRegistration,
  resolveExtensionCommandRegistration,
  resolveExtensionContextEngineRegistration,
  resolveExtensionGatewayMethodRegistration,
  resolveExtensionLegacyHookRegistration,
  resolveExtensionHttpRouteRegistration,
  resolveExtensionProviderRegistration,
  resolveExtensionServiceRegistration,
  resolveExtensionToolRegistration,
  resolveExtensionTypedHookRegistration,
  type ExtensionHostChannelRegistration,
  type ExtensionHostHttpRouteRegistration,
  type ExtensionHostProviderRegistration,
} from "./runtime-registrations.js";

function createChannelPlugin(id: string): ChannelPlugin {
  return {
    id,
    meta: {
      id,
      label: id,
      selectionLabel: id,
      docsPath: `/channels/${id}`,
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => ({}),
    },
  };
}

function createProviderPlugin(id: string): ProviderPlugin {
  return {
    id,
    label: id,
    auth: [],
  };
}

function createService(id: string): OpenClawPluginService {
  return {
    id,
    start: vi.fn(),
  };
}

function createCommand(name: string): OpenClawPluginCommandDefinition {
  return {
    name,
    description: "demo command",
    handler: vi.fn(),
  };
}

function createLegacyHookEntry(name: string): HookEntry {
  return {
    hook: {
      name,
      description: "hook description",
      source: "openclaw-plugin",
      pluginId: "demo-plugin",
      filePath: "/demo/plugin.ts",
      baseDir: "/demo",
      handlerPath: "/demo/plugin.ts",
    },
    frontmatter: {},
    metadata: { events: ["message:received"] },
    invocation: { enabled: true },
  };
}

describe("runtime registration helpers", () => {
  it("normalizes tool registration metadata", () => {
    const tool = { name: "demo-tool" } as AnyAgentTool;
    const result = resolveExtensionToolRegistration({
      ownerPluginId: "tool-plugin",
      ownerSource: "tool-source",
      tool,
      opts: {
        names: [" demo-tool ", "alias"],
        optional: true,
      },
    });

    expect(result).toMatchObject({
      names: ["demo-tool", "alias"],
      entry: {
        pluginId: "tool-plugin",
        names: ["demo-tool", "alias"],
        optional: true,
        source: "tool-source",
      },
    });
    expect(result.entry.factory({} as never)).toBe(tool);
  });

  it("normalizes cli registration metadata", () => {
    const registrar = (_ctx: OpenClawPluginCliContext) => {};
    const result = resolveExtensionCliRegistration({
      ownerPluginId: "cli-plugin",
      ownerSource: "cli-source",
      registrar,
      opts: { commands: [" foo ", "bar", "foo"] },
    });

    expect(result).toEqual({
      commands: ["foo", "bar"],
      entry: {
        pluginId: "cli-plugin",
        register: registrar,
        commands: ["foo", "bar"],
        source: "cli-source",
      },
    });
  });

  it("normalizes service registrations", () => {
    const result = resolveExtensionServiceRegistration({
      ownerPluginId: "service-plugin",
      ownerSource: "service-source",
      service: createService(" demo-service "),
    });

    expect(result).toMatchObject({
      ok: true,
      serviceId: "demo-service",
      entry: {
        pluginId: "service-plugin",
        source: "service-source",
        service: { id: "demo-service" },
      },
    });
  });

  it("rejects service registrations without ids", () => {
    const result = resolveExtensionServiceRegistration({
      ownerPluginId: "service-plugin",
      ownerSource: "service-source",
      service: createService(" "),
    });

    expect(result).toEqual({
      ok: false,
      message: "service registration missing id",
    });
  });

  it("normalizes command registrations", () => {
    const result = resolveExtensionCommandRegistration({
      ownerPluginId: "command-plugin",
      ownerSource: "command-source",
      command: createCommand(" demo "),
    });

    expect(result).toMatchObject({
      ok: true,
      commandName: "demo",
      entry: {
        pluginId: "command-plugin",
        source: "command-source",
        command: { name: "demo" },
      },
    });
  });

  it("rejects command registrations without names", () => {
    const result = resolveExtensionCommandRegistration({
      ownerPluginId: "command-plugin",
      ownerSource: "command-source",
      command: createCommand(" "),
    });

    expect(result).toEqual({
      ok: false,
      message: "command registration missing name",
    });
  });

  it("normalizes context-engine registrations", () => {
    const factory = vi.fn() as unknown as ContextEngineFactory;
    const result = resolveExtensionContextEngineRegistration({
      engineId: " demo-engine ",
      factory,
    });

    expect(result).toEqual({
      ok: true,
      entry: {
        engineId: "demo-engine",
        factory,
      },
    });
  });

  it("rejects context-engine registrations without ids", () => {
    const result = resolveExtensionContextEngineRegistration({
      engineId: " ",
      factory: vi.fn() as unknown as ContextEngineFactory,
    });

    expect(result).toEqual({
      ok: false,
      message: "context engine registration missing id",
    });
  });

  it("normalizes legacy hook registrations", () => {
    const handler = vi.fn() as unknown as InternalHookHandler;
    const result = resolveExtensionLegacyHookRegistration({
      ownerPluginId: "hook-plugin",
      ownerSource: "/plugins/hook.ts",
      events: [" message:received ", "message:received", "message:sent"],
      handler,
      opts: {
        name: "demo-hook",
        description: "hook description",
      } satisfies OpenClawPluginHookOptions,
    });

    expect(result).toMatchObject({
      ok: true,
      hookName: "demo-hook",
      events: ["message:received", "message:sent"],
      entry: {
        pluginId: "hook-plugin",
        source: "/plugins/hook.ts",
      },
    });
  });

  it("preserves explicit legacy hook entries while normalizing events", () => {
    const result = resolveExtensionLegacyHookRegistration({
      ownerPluginId: "hook-plugin",
      ownerSource: "/plugins/hook.ts",
      events: " message:received ",
      handler: vi.fn() as unknown as InternalHookHandler,
      opts: {
        entry: createLegacyHookEntry("demo-hook"),
      },
    });

    expect(result).toMatchObject({
      ok: true,
      hookName: "demo-hook",
      events: ["message:received"],
    });
    if (result.ok) {
      expect(result.entry.entry.hook.pluginId).toBe("hook-plugin");
      expect(result.entry.entry.metadata?.events).toEqual(["message:received"]);
    }
  });

  it("rejects legacy hook registrations without names", () => {
    const result = resolveExtensionLegacyHookRegistration({
      ownerPluginId: "hook-plugin",
      ownerSource: "/plugins/hook.ts",
      events: "message:received",
      handler: vi.fn() as unknown as InternalHookHandler,
      opts: {},
    });

    expect(result).toEqual({
      ok: false,
      message: "hook registration missing name",
    });
  });

  it("normalizes typed hook registrations", () => {
    const handler = vi.fn() as PluginHookRegistration<"before_prompt_build">["handler"];
    const result = resolveExtensionTypedHookRegistration({
      ownerPluginId: "typed-hook-plugin",
      ownerSource: "/plugins/typed-hook.ts",
      hookName: "before_prompt_build",
      handler,
      priority: 10,
    });

    expect(result).toEqual({
      ok: true,
      hookName: "before_prompt_build",
      entry: {
        pluginId: "typed-hook-plugin",
        hookName: "before_prompt_build",
        handler,
        priority: 10,
        source: "/plugins/typed-hook.ts",
      },
    });
  });

  it("rejects unknown typed hook registrations", () => {
    const result = resolveExtensionTypedHookRegistration({
      ownerPluginId: "typed-hook-plugin",
      ownerSource: "/plugins/typed-hook.ts",
      hookName: "totally_unknown_hook_name",
      handler: vi.fn() as never,
      priority: 10,
    });

    expect(result).toEqual({
      ok: false,
      message: 'unknown typed hook "totally_unknown_hook_name" ignored',
    });
  });

  it("normalizes and accepts a unique channel registration", () => {
    const result = resolveExtensionChannelRegistration({
      existing: [],
      ownerPluginId: "demo-plugin",
      ownerSource: "demo-source",
      registration: createChannelPlugin("demo-channel"),
    });

    expect(result).toMatchObject({
      ok: true,
      channelId: "demo-channel",
      entry: {
        pluginId: "demo-plugin",
        source: "demo-source",
      },
    });
  });

  it("rejects duplicate channel registrations", () => {
    const existing: ExtensionHostChannelRegistration[] = [
      {
        pluginId: "demo-a",
        plugin: createChannelPlugin("demo-channel"),
        source: "demo-a-source",
      },
    ];

    const result = resolveExtensionChannelRegistration({
      existing,
      ownerPluginId: "demo-b",
      ownerSource: "demo-b-source",
      registration: createChannelPlugin("demo-channel"),
    });

    expect(result).toEqual({
      ok: false,
      message: "channel already registered: demo-channel (demo-a)",
    });
  });

  it("accepts a unique provider registration", () => {
    const result = resolveExtensionProviderRegistration({
      existing: [],
      ownerPluginId: "provider-plugin",
      ownerSource: "provider-source",
      provider: createProviderPlugin("demo-provider"),
    });

    expect(result).toMatchObject({
      ok: true,
      providerId: "demo-provider",
      entry: {
        pluginId: "provider-plugin",
        source: "provider-source",
      },
    });
  });

  it("rejects duplicate provider registrations", () => {
    const existing: ExtensionHostProviderRegistration[] = [
      {
        pluginId: "provider-a",
        provider: createProviderPlugin("demo-provider"),
        source: "provider-a-source",
      },
    ];

    const result = resolveExtensionProviderRegistration({
      existing,
      ownerPluginId: "provider-b",
      ownerSource: "provider-b-source",
      provider: createProviderPlugin("demo-provider"),
    });

    expect(result).toEqual({
      ok: false,
      message: "provider already registered: demo-provider (provider-a)",
    });
  });

  it("accepts a unique http route registration", () => {
    const result = resolveExtensionHttpRouteRegistration({
      existing: [],
      ownerPluginId: "route-plugin",
      ownerSource: "route-source",
      route: {
        path: "/demo",
        auth: "plugin",
        handler: vi.fn(),
      },
    });

    expect(result).toMatchObject({
      ok: true,
      action: "append",
      entry: {
        pluginId: "route-plugin",
        path: "/demo",
        auth: "plugin",
        match: "exact",
        source: "route-source",
      },
    });
  });

  it("rejects conflicting http routes owned by another plugin", () => {
    const existing: ExtensionHostHttpRouteRegistration[] = [
      {
        pluginId: "route-a",
        path: "/demo",
        auth: "plugin",
        match: "exact",
        handler: vi.fn(),
        source: "route-a-source",
      },
    ];

    const result = resolveExtensionHttpRouteRegistration({
      existing,
      ownerPluginId: "route-b",
      ownerSource: "route-b-source",
      route: {
        path: "/demo",
        auth: "plugin",
        handler: vi.fn(),
      },
    });

    expect(result).toEqual({
      ok: false,
      message: "http route already registered: /demo (exact) by route-a (route-a-source)",
    });
  });

  it("supports same-owner http route replacement", () => {
    const existing: ExtensionHostHttpRouteRegistration[] = [
      {
        pluginId: "route-plugin",
        path: "/demo",
        auth: "plugin",
        match: "exact",
        handler: vi.fn(),
        source: "route-source",
      },
    ];

    const result = resolveExtensionHttpRouteRegistration({
      existing,
      ownerPluginId: "route-plugin",
      ownerSource: "route-source",
      route: {
        path: "/demo",
        auth: "plugin",
        replaceExisting: true,
        handler: vi.fn(),
      },
    });

    expect(result).toMatchObject({
      ok: true,
      action: "replace",
      existingIndex: 0,
      entry: {
        pluginId: "route-plugin",
        path: "/demo",
      },
    });
  });

  it("accepts a unique gateway method registration", () => {
    const handler = vi.fn();
    const result = resolveExtensionGatewayMethodRegistration({
      existing: {},
      coreGatewayMethods: new Set(["core.method"]),
      method: "plugin.method",
      handler,
    });

    expect(result).toEqual({
      ok: true,
      method: "plugin.method",
      handler,
    });
  });

  it("rejects duplicate gateway method registrations", () => {
    const result = resolveExtensionGatewayMethodRegistration({
      existing: {
        "plugin.method": vi.fn(),
      },
      coreGatewayMethods: new Set(["core.method"]),
      method: "plugin.method",
      handler: vi.fn(),
    });

    expect(result).toEqual({
      ok: false,
      message: "gateway method already registered: plugin.method",
    });
  });
});
