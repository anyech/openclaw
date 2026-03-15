import type { OpenClawConfig } from "../config/config.js";
import {
  loadPluginManifestRegistry,
  type PluginManifestRegistry,
} from "../plugins/manifest-registry.js";
import type { PluginDiagnostic } from "../plugins/types.js";
import type { ResolvedExtension } from "./schema.js";

export type ResolvedExtensionRegistryEntry = {
  extension: ResolvedExtension;
  manifestPath: string;
  schemaCacheKey?: string;
};

export type ResolvedExtensionRegistry = {
  extensions: ResolvedExtensionRegistryEntry[];
  diagnostics: PluginDiagnostic[];
};

export function resolvedExtensionRegistryFromPluginManifestRegistry(
  registry: PluginManifestRegistry,
): ResolvedExtensionRegistry {
  return {
    diagnostics: registry.diagnostics,
    extensions: registry.plugins.map((plugin) => ({
      extension:
        plugin.resolvedExtension ??
        ({
          id: plugin.id,
          name: plugin.name,
          description: plugin.description,
          version: plugin.version,
          kind: plugin.kind,
          origin: plugin.origin,
          rootDir: plugin.rootDir,
          source: plugin.source,
          workspaceDir: plugin.workspaceDir,
          manifest: {
            id: plugin.id,
            name: plugin.name,
            description: plugin.description,
            version: plugin.version,
            kind: plugin.kind,
            channels: plugin.channels,
            providers: plugin.providers,
            skills: plugin.skills,
            configSchema: plugin.configSchema ?? {},
            uiHints: plugin.configUiHints,
          },
          staticMetadata: {
            configSchema: plugin.configSchema ?? {},
            configUiHints: plugin.configUiHints,
            package: { entries: [] },
          },
          contributions: [],
        } satisfies ResolvedExtension),
      manifestPath: plugin.manifestPath,
      schemaCacheKey: plugin.schemaCacheKey,
    })),
  };
}

export function loadResolvedExtensionRegistry(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  cache?: boolean;
  env?: NodeJS.ProcessEnv;
}): ResolvedExtensionRegistry {
  return resolvedExtensionRegistryFromPluginManifestRegistry(loadPluginManifestRegistry(params));
}
