import { createEmptyPluginRegistry, type PluginRegistry } from "../plugins/registry.js";

const EXTENSION_HOST_REGISTRY_STATE = Symbol.for("openclaw.extensionHostRegistryState");

export type ExtensionHostRegistry = PluginRegistry;

type ExtensionHostRegistryState = {
  registry: ExtensionHostRegistry | null;
  key: string | null;
  version: number;
};

const state: ExtensionHostRegistryState = (() => {
  const globalState = globalThis as typeof globalThis & {
    [EXTENSION_HOST_REGISTRY_STATE]?: ExtensionHostRegistryState;
  };
  if (!globalState[EXTENSION_HOST_REGISTRY_STATE]) {
    globalState[EXTENSION_HOST_REGISTRY_STATE] = {
      registry: createEmptyExtensionHostRegistry(),
      key: null,
      version: 0,
    };
  }
  return globalState[EXTENSION_HOST_REGISTRY_STATE];
})();

export function createEmptyExtensionHostRegistry(): ExtensionHostRegistry {
  return createEmptyPluginRegistry();
}

export function setActiveExtensionHostRegistry(
  registry: ExtensionHostRegistry,
  cacheKey?: string,
): void {
  state.registry = registry;
  state.key = cacheKey ?? null;
  state.version += 1;
}

export function getActiveExtensionHostRegistry(): ExtensionHostRegistry | null {
  return state.registry;
}

export function requireActiveExtensionHostRegistry(): ExtensionHostRegistry {
  if (!state.registry) {
    state.registry = createEmptyExtensionHostRegistry();
    state.version += 1;
  }
  return state.registry;
}

export function getActiveExtensionHostRegistryKey(): string | null {
  return state.key;
}

export function getActiveExtensionHostRegistryVersion(): number {
  return state.version;
}
