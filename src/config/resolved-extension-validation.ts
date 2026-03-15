import type { ResolvedExtensionRegistry } from "../extension-host/resolved-registry.js";

export type ResolvedExtensionValidationEntry = {
  id: string;
  origin: "workspace" | "bundled" | "global" | "config";
  kind?: string;
  channels: string[];
  configSchema?: Record<string, unknown>;
  manifestPath: string;
  schemaCacheKey?: string;
};

export type ResolvedExtensionValidationIndex = {
  knownIds: Set<string>;
  channelIds: Set<string>;
  lowercaseChannelIds: Set<string>;
  entries: ResolvedExtensionValidationEntry[];
};

export function buildResolvedExtensionValidationIndex(
  registry: ResolvedExtensionRegistry,
): ResolvedExtensionValidationIndex {
  const knownIds = new Set<string>();
  const channelIds = new Set<string>();
  const lowercaseChannelIds = new Set<string>();
  const entries: ResolvedExtensionValidationEntry[] = registry.extensions.map((record) => {
    const extension = record.extension;
    const channels = [...(extension.manifest.channels ?? [])];
    knownIds.add(extension.id);
    for (const channelId of channels) {
      channelIds.add(channelId);
      const trimmed = channelId.trim();
      if (trimmed) {
        lowercaseChannelIds.add(trimmed.toLowerCase());
      }
    }
    return {
      id: extension.id,
      origin: extension.origin ?? "workspace",
      kind: extension.kind,
      channels,
      configSchema: extension.staticMetadata.configSchema,
      manifestPath: record.manifestPath,
      schemaCacheKey: record.schemaCacheKey,
    };
  });

  return {
    knownIds,
    channelIds,
    lowercaseChannelIds,
    entries,
  };
}
