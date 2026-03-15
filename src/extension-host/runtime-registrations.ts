import path from "node:path";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { ChannelDock } from "../channels/dock.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { ContextEngineFactory } from "../context-engine/registry.js";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlers,
} from "../gateway/server-methods/types.js";
import type { InternalHookHandler } from "../hooks/internal-hooks.js";
import type { HookEntry } from "../hooks/types.js";
import { normalizePluginHttpPath } from "../plugins/http-path.js";
import { findOverlappingPluginHttpRoute } from "../plugins/http-route-overlap.js";
import type {
  OpenClawPluginCliRegistrar,
  OpenClawPluginCommandDefinition,
  OpenClawPluginChannelRegistration,
  OpenClawPluginHookOptions,
  OpenClawPluginHttpRouteAuth,
  OpenClawPluginHttpRouteHandler,
  OpenClawPluginHttpRouteMatch,
  OpenClawPluginHttpRouteParams,
  OpenClawPluginService,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
  PluginHookHandlerMap,
  PluginHookName,
  PluginHookRegistration,
  ProviderPlugin,
} from "../plugins/types.js";
import { isPluginHookName } from "../plugins/types.js";

export type ExtensionHostChannelRegistration = {
  pluginId: string;
  plugin: ChannelPlugin;
  dock?: ChannelDock;
  source: string;
};

export type ExtensionHostProviderRegistration = {
  pluginId: string;
  provider: ProviderPlugin;
  source: string;
};

export type ExtensionHostToolRegistration = {
  pluginId: string;
  factory: OpenClawPluginToolFactory;
  names: string[];
  optional: boolean;
  source: string;
};

export type ExtensionHostCliRegistration = {
  pluginId: string;
  register: OpenClawPluginCliRegistrar;
  commands: string[];
  source: string;
};

export type ExtensionHostServiceRegistration = {
  pluginId: string;
  service: OpenClawPluginService;
  source: string;
};

export type ExtensionHostCommandRegistration = {
  pluginId: string;
  command: OpenClawPluginCommandDefinition;
  source: string;
};

export type ExtensionHostContextEngineRegistration = {
  engineId: string;
  factory: ContextEngineFactory;
};

export type ExtensionHostLegacyHookRegistration = {
  pluginId: string;
  entry: HookEntry;
  events: string[];
  source: string;
  handler: InternalHookHandler;
};

export type ExtensionHostHttpRouteRegistration = {
  pluginId?: string;
  path: string;
  handler: OpenClawPluginHttpRouteHandler;
  auth: OpenClawPluginHttpRouteAuth;
  match: OpenClawPluginHttpRouteMatch;
  source?: string;
};

function normalizeNameList(names: string[]): string[] {
  return Array.from(new Set(names.map((name) => name.trim()).filter(Boolean)));
}

export function resolveExtensionToolRegistration(params: {
  ownerPluginId: string;
  ownerSource: string;
  tool: AnyAgentTool | OpenClawPluginToolFactory;
  opts?: { name?: string; names?: string[]; optional?: boolean };
}): {
  names: string[];
  entry: ExtensionHostToolRegistration;
} {
  const names = [...(params.opts?.names ?? []), ...(params.opts?.name ? [params.opts.name] : [])];
  if (typeof params.tool !== "function") {
    names.push(params.tool.name);
  }
  const normalizedNames = normalizeNameList(names);
  const factory: OpenClawPluginToolFactory =
    typeof params.tool === "function"
      ? params.tool
      : (_ctx: OpenClawPluginToolContext) => params.tool;

  return {
    names: normalizedNames,
    entry: {
      pluginId: params.ownerPluginId,
      factory,
      names: normalizedNames,
      optional: params.opts?.optional === true,
      source: params.ownerSource,
    },
  };
}

export function resolveExtensionCliRegistration(params: {
  ownerPluginId: string;
  ownerSource: string;
  registrar: OpenClawPluginCliRegistrar;
  opts?: { commands?: string[] };
}): {
  commands: string[];
  entry: ExtensionHostCliRegistration;
} {
  const commands = normalizeNameList(params.opts?.commands ?? []);
  return {
    commands,
    entry: {
      pluginId: params.ownerPluginId,
      register: params.registrar,
      commands,
      source: params.ownerSource,
    },
  };
}

export function resolveExtensionServiceRegistration(params: {
  ownerPluginId: string;
  ownerSource: string;
  service: OpenClawPluginService;
}):
  | {
      ok: true;
      serviceId: string;
      entry: ExtensionHostServiceRegistration;
    }
  | {
      ok: false;
      message: string;
    } {
  const serviceId = params.service.id.trim();
  if (!serviceId) {
    return { ok: false, message: "service registration missing id" };
  }
  return {
    ok: true,
    serviceId,
    entry: {
      pluginId: params.ownerPluginId,
      service: {
        ...params.service,
        id: serviceId,
      },
      source: params.ownerSource,
    },
  };
}

export function resolveExtensionCommandRegistration(params: {
  ownerPluginId: string;
  ownerSource: string;
  command: OpenClawPluginCommandDefinition;
}):
  | {
      ok: true;
      commandName: string;
      entry: ExtensionHostCommandRegistration;
    }
  | {
      ok: false;
      message: string;
    } {
  const commandName = params.command.name.trim();
  if (!commandName) {
    return { ok: false, message: "command registration missing name" };
  }
  return {
    ok: true,
    commandName,
    entry: {
      pluginId: params.ownerPluginId,
      command: {
        ...params.command,
        name: commandName,
      },
      source: params.ownerSource,
    },
  };
}

export function resolveExtensionContextEngineRegistration(params: {
  engineId: string;
  factory: ContextEngineFactory;
}):
  | {
      ok: true;
      entry: ExtensionHostContextEngineRegistration;
    }
  | {
      ok: false;
      message: string;
    } {
  const engineId = params.engineId.trim();
  if (!engineId) {
    return { ok: false, message: "context engine registration missing id" };
  }
  return {
    ok: true,
    entry: {
      engineId,
      factory: params.factory,
    },
  };
}

export function resolveExtensionLegacyHookRegistration(params: {
  ownerPluginId: string;
  ownerSource: string;
  events: string | string[];
  handler: InternalHookHandler;
  opts?: OpenClawPluginHookOptions;
}):
  | {
      ok: true;
      hookName: string;
      events: string[];
      entry: ExtensionHostLegacyHookRegistration;
    }
  | {
      ok: false;
      message: string;
    } {
  const eventList = Array.isArray(params.events) ? params.events : [params.events];
  const normalizedEvents = normalizeNameList(eventList);
  const entry = params.opts?.entry ?? null;
  const hookName = entry?.hook.name ?? params.opts?.name?.trim();
  if (!hookName) {
    return { ok: false, message: "hook registration missing name" };
  }

  const description = entry?.hook.description ?? params.opts?.description ?? "";
  const hookEntry: HookEntry = entry
    ? {
        ...entry,
        hook: {
          ...entry.hook,
          name: hookName,
          description,
          source: "openclaw-plugin",
          pluginId: params.ownerPluginId,
        },
        metadata: {
          ...entry.metadata,
          events: normalizedEvents,
        },
      }
    : {
        hook: {
          name: hookName,
          description,
          source: "openclaw-plugin",
          pluginId: params.ownerPluginId,
          filePath: params.ownerSource,
          baseDir: path.dirname(params.ownerSource),
          handlerPath: params.ownerSource,
        },
        frontmatter: {},
        metadata: { events: normalizedEvents },
        invocation: { enabled: true },
      };

  return {
    ok: true,
    hookName,
    events: normalizedEvents,
    entry: {
      pluginId: params.ownerPluginId,
      entry: hookEntry,
      events: normalizedEvents,
      source: params.ownerSource,
      handler: params.handler,
    },
  };
}

export function resolveExtensionTypedHookRegistration<K extends PluginHookName>(params: {
  ownerPluginId: string;
  ownerSource: string;
  hookName: unknown;
  handler: PluginHookHandlerMap[K];
  priority?: number;
}):
  | {
      ok: true;
      hookName: K;
      entry: PluginHookRegistration<K>;
    }
  | {
      ok: false;
      message: string;
    } {
  if (!isPluginHookName(params.hookName)) {
    return {
      ok: false,
      message: `unknown typed hook "${String(params.hookName)}" ignored`,
    };
  }
  return {
    ok: true,
    hookName: params.hookName as K,
    entry: {
      pluginId: params.ownerPluginId,
      hookName: params.hookName as K,
      handler: params.handler,
      priority: params.priority,
      source: params.ownerSource,
    },
  };
}

export function resolveExtensionGatewayMethodRegistration(params: {
  existing: GatewayRequestHandlers;
  coreGatewayMethods: ReadonlySet<string>;
  method: string;
  handler: GatewayRequestHandler;
}):
  | {
      ok: true;
      method: string;
      handler: GatewayRequestHandler;
    }
  | {
      ok: false;
      message: string;
    } {
  const method = params.method.trim();
  if (!method) {
    return { ok: false, message: "gateway method registration missing name" };
  }
  if (params.coreGatewayMethods.has(method) || params.existing[method]) {
    return {
      ok: false,
      message: `gateway method already registered: ${method}`,
    };
  }
  return {
    ok: true,
    method,
    handler: params.handler,
  };
}

function normalizeChannelRegistration(
  registration: OpenClawPluginChannelRegistration | ChannelPlugin,
): { plugin: ChannelPlugin; dock?: ChannelDock } {
  return typeof (registration as OpenClawPluginChannelRegistration).plugin === "object"
    ? (registration as OpenClawPluginChannelRegistration)
    : { plugin: registration as ChannelPlugin };
}

export function resolveExtensionChannelRegistration(params: {
  existing: ExtensionHostChannelRegistration[];
  ownerPluginId: string;
  ownerSource: string;
  registration: OpenClawPluginChannelRegistration | ChannelPlugin;
}):
  | {
      ok: true;
      channelId: string;
      entry: ExtensionHostChannelRegistration;
    }
  | {
      ok: false;
      message: string;
    } {
  const normalized = normalizeChannelRegistration(params.registration);
  const plugin = normalized.plugin;
  const channelId =
    typeof plugin?.id === "string" ? plugin.id.trim() : String(plugin?.id ?? "").trim();
  if (!channelId) {
    return { ok: false, message: "channel registration missing id" };
  }
  const existing = params.existing.find((entry) => entry.plugin.id === channelId);
  if (existing) {
    return {
      ok: false,
      message: `channel already registered: ${channelId} (${existing.pluginId})`,
    };
  }
  return {
    ok: true,
    channelId,
    entry: {
      pluginId: params.ownerPluginId,
      plugin,
      dock: normalized.dock,
      source: params.ownerSource,
    },
  };
}

export function resolveExtensionProviderRegistration(params: {
  existing: ExtensionHostProviderRegistration[];
  ownerPluginId: string;
  ownerSource: string;
  provider: ProviderPlugin;
}):
  | {
      ok: true;
      providerId: string;
      entry: ExtensionHostProviderRegistration;
    }
  | {
      ok: false;
      message: string;
    } {
  const providerId = params.provider.id;
  const existing = params.existing.find((entry) => entry.provider.id === providerId);
  if (existing) {
    return {
      ok: false,
      message: `provider already registered: ${providerId} (${existing.pluginId})`,
    };
  }
  return {
    ok: true,
    providerId,
    entry: {
      pluginId: params.ownerPluginId,
      provider: params.provider,
      source: params.ownerSource,
    },
  };
}

function describeHttpRouteOwner(entry: ExtensionHostHttpRouteRegistration): string {
  const plugin = entry.pluginId?.trim() || "unknown-plugin";
  const source = entry.source?.trim() || "unknown-source";
  return `${plugin} (${source})`;
}

export function resolveExtensionHttpRouteRegistration(params: {
  existing: ExtensionHostHttpRouteRegistration[];
  ownerPluginId: string;
  ownerSource: string;
  route: OpenClawPluginHttpRouteParams;
}):
  | {
      ok: true;
      action: "append" | "replace";
      entry: ExtensionHostHttpRouteRegistration;
      existingIndex?: number;
    }
  | {
      ok: false;
      message: string;
    } {
  const normalizedPath = normalizePluginHttpPath(params.route.path);
  if (!normalizedPath) {
    return { ok: false, message: "http route registration missing path" };
  }
  if (params.route.auth !== "gateway" && params.route.auth !== "plugin") {
    return {
      ok: false,
      message: `http route registration missing or invalid auth: ${normalizedPath}`,
    };
  }

  const match = params.route.match ?? "exact";
  const overlappingRoute = findOverlappingPluginHttpRoute(params.existing, {
    path: normalizedPath,
    match,
  });
  if (overlappingRoute && overlappingRoute.auth !== params.route.auth) {
    return {
      ok: false,
      message:
        `http route overlap rejected: ${normalizedPath} (${match}, ${params.route.auth}) ` +
        `overlaps ${overlappingRoute.path} (${overlappingRoute.match}, ${overlappingRoute.auth}) ` +
        `owned by ${describeHttpRouteOwner(overlappingRoute)}`,
    };
  }

  const existingIndex = params.existing.findIndex(
    (entry) => entry.path === normalizedPath && entry.match === match,
  );
  const nextEntry: ExtensionHostHttpRouteRegistration = {
    pluginId: params.ownerPluginId,
    path: normalizedPath,
    handler: params.route.handler,
    auth: params.route.auth,
    match,
    source: params.ownerSource,
  };

  if (existingIndex >= 0) {
    const existing = params.existing[existingIndex];
    if (!existing) {
      return {
        ok: false,
        message: `http route registration missing existing route: ${normalizedPath}`,
      };
    }
    if (!params.route.replaceExisting) {
      return {
        ok: false,
        message: `http route already registered: ${normalizedPath} (${match}) by ${describeHttpRouteOwner(existing)}`,
      };
    }
    if (existing.pluginId && existing.pluginId !== params.ownerPluginId) {
      return {
        ok: false,
        message: `http route replacement rejected: ${normalizedPath} (${match}) owned by ${describeHttpRouteOwner(existing)}`,
      };
    }
    return {
      ok: true,
      action: "replace",
      existingIndex,
      entry: nextEntry,
    };
  }

  return {
    ok: true,
    action: "append",
    entry: nextEntry,
  };
}
