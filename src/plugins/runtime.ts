import {
  getActiveExtensionHostRegistry,
  getActiveExtensionHostRegistryKey,
  getActiveExtensionHostRegistryVersion,
  requireActiveExtensionHostRegistry,
  setActiveExtensionHostRegistry,
  type ExtensionHostRegistry,
} from "../extension-host/active-registry.js";

export type PluginRegistry = ExtensionHostRegistry;

// Compatibility facade: legacy plugin runtime callers still import from this module,
// but the active registry now lives under the extension-host boundary.
export function setActivePluginRegistry(registry: PluginRegistry, cacheKey?: string) {
  setActiveExtensionHostRegistry(registry, cacheKey);
}

export function getActivePluginRegistry(): PluginRegistry | null {
  return getActiveExtensionHostRegistry();
}

export function requireActivePluginRegistry(): PluginRegistry {
  return requireActiveExtensionHostRegistry();
}

export function getActivePluginRegistryKey(): string | null {
  return getActiveExtensionHostRegistryKey();
}

export function getActivePluginRegistryVersion(): number {
  return getActiveExtensionHostRegistryVersion();
}
