import { describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import {
  createEmptyExtensionHostRegistry,
  getActiveExtensionHostRegistry,
  getActiveExtensionHostRegistryKey,
  getActiveExtensionHostRegistryVersion,
  requireActiveExtensionHostRegistry,
  setActiveExtensionHostRegistry,
} from "./active-registry.js";

describe("extension host active registry", () => {
  it("initializes with an empty registry", () => {
    const emptyRegistry = createEmptyExtensionHostRegistry();
    setActiveExtensionHostRegistry(emptyRegistry, "empty");
    const registry = requireActiveExtensionHostRegistry();
    expect(registry).toBeDefined();
    expect(registry).toBe(emptyRegistry);
    expect(registry.channels).toEqual([]);
    expect(registry.plugins).toEqual([]);
  });

  it("tracks registry replacement and cache keys", () => {
    const baseVersion = getActiveExtensionHostRegistryVersion();
    const registry = createEmptyPluginRegistry();
    registry.plugins.push({
      id: "host-test",
      name: "host-test",
      source: "test",
      origin: "workspace",
      enabled: true,
      status: "loaded",
      toolNames: [],
      hookNames: [],
      channelIds: [],
      providerIds: [],
      gatewayMethods: [],
      cliCommands: [],
      services: [],
      commands: [],
      httpRoutes: 0,
      hookCount: 0,
      configSchema: false,
    });

    setActiveExtensionHostRegistry(registry, "host-registry");

    expect(getActiveExtensionHostRegistry()).toBe(registry);
    expect(getActiveExtensionHostRegistryKey()).toBe("host-registry");
    expect(getActiveExtensionHostRegistryVersion()).toBe(baseVersion + 1);
  });

  it("can create a fresh empty registry", () => {
    const registry = createEmptyExtensionHostRegistry();
    expect(registry).not.toBe(getActiveExtensionHostRegistry());
    expect(registry).toEqual(createEmptyPluginRegistry());
  });
});
