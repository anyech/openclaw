import {
  DEFAULT_PLUGIN_ENTRY_CANDIDATES,
  getPackageManifestMetadata,
  resolvePackageExtensionEntries,
  type OpenClawPackageManifest,
  type PackageExtensionResolution,
  type PackageManifest,
  type PluginManifest,
} from "../plugins/manifest.js";
import type { PluginConfigUiHint, PluginKind, PluginOrigin } from "../plugins/types.js";

export type { OpenClawPackageManifest, PackageExtensionResolution, PackageManifest };

export const DEFAULT_EXTENSION_ENTRY_CANDIDATES = DEFAULT_PLUGIN_ENTRY_CANDIDATES;

export type ContributionPolicy = {
  promptMutation?: "none" | "append-only" | "replace-allowed";
  routeEffect?: "observe-only" | "augment" | "veto" | "resolve";
  executionMode?: "sync-hot-path" | "sequential" | "parallel";
};

export type ResolvedContributionKind =
  | "adapter.runtime"
  | "capability.context-engine"
  | "capability.memory"
  | "capability.provider-integration"
  | "surface.channel-catalog"
  | "surface.config"
  | "surface.install";

export type ResolvedContribution = {
  id: string;
  kind: ResolvedContributionKind;
  source: "manifest" | "package";
  policy?: ContributionPolicy;
  metadata?: Record<string, unknown>;
};

export type ResolvedExtensionPackageMetadata = {
  entries: string[];
  manifest?: OpenClawPackageManifest;
};

export type ResolvedExtensionStaticMetadata = {
  configSchema: Record<string, unknown>;
  configUiHints?: Record<string, PluginConfigUiHint>;
  package: ResolvedExtensionPackageMetadata;
};

export type ResolvedExtension = {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  kind?: PluginKind;
  origin?: PluginOrigin;
  rootDir?: string;
  source?: string;
  workspaceDir?: string;
  manifest: PluginManifest;
  staticMetadata: ResolvedExtensionStaticMetadata;
  contributions: ResolvedContribution[];
};

export function getExtensionPackageMetadata(
  manifest: PackageManifest | undefined,
): OpenClawPackageManifest | undefined {
  return getPackageManifestMetadata(manifest);
}

export function resolveExtensionEntryCandidates(
  manifest: PackageManifest | undefined,
): PackageExtensionResolution {
  return resolvePackageExtensionEntries(manifest);
}

function normalizeResolvedEntries(
  packageManifest: PackageManifest | undefined,
): ResolvedExtensionPackageMetadata {
  const manifest = getExtensionPackageMetadata(packageManifest);
  const entries = resolveExtensionEntryCandidates(packageManifest);
  return {
    entries:
      entries.status === "ok" ? entries.entries : Array.from(DEFAULT_EXTENSION_ENTRY_CANDIDATES),
    manifest,
  };
}

export function resolveLegacyExtensionDescriptor(params: {
  manifest: PluginManifest;
  packageManifest?: PackageManifest;
  origin?: PluginOrigin;
  rootDir?: string;
  source?: string;
  workspaceDir?: string;
}): ResolvedExtension {
  const packageMetadata = normalizeResolvedEntries(params.packageManifest);
  const contributions: ResolvedContribution[] = [
    {
      id: `${params.manifest.id}/config`,
      kind: "surface.config",
      source: "manifest",
    },
  ];

  for (const channelId of params.manifest.channels ?? []) {
    contributions.push({
      id: `${params.manifest.id}/channel/${channelId}`,
      kind: "adapter.runtime",
      source: "manifest",
      metadata: { channelId },
    });
  }

  for (const providerId of params.manifest.providers ?? []) {
    contributions.push({
      id: `${params.manifest.id}/provider/${providerId}`,
      kind: "capability.provider-integration",
      source: "manifest",
      metadata: { providerId },
    });
  }

  if (params.manifest.kind === "memory") {
    contributions.push({
      id: `${params.manifest.id}/memory`,
      kind: "capability.memory",
      source: "manifest",
    });
  }

  if (params.manifest.kind === "context-engine") {
    contributions.push({
      id: `${params.manifest.id}/context-engine`,
      kind: "capability.context-engine",
      source: "manifest",
    });
  }

  if (packageMetadata.manifest?.channel) {
    contributions.push({
      id: `${params.manifest.id}/channel-catalog`,
      kind: "surface.channel-catalog",
      source: "package",
      metadata: {
        channelId: packageMetadata.manifest.channel.id,
      },
    });
  }

  if (packageMetadata.manifest?.install) {
    contributions.push({
      id: `${params.manifest.id}/install`,
      kind: "surface.install",
      source: "package",
      metadata: {
        defaultChoice: packageMetadata.manifest.install.defaultChoice,
        npmSpec: packageMetadata.manifest.install.npmSpec,
      },
    });
  }

  return {
    id: params.manifest.id,
    name: params.manifest.name,
    description: params.manifest.description,
    version: params.manifest.version,
    kind: params.manifest.kind,
    origin: params.origin,
    rootDir: params.rootDir,
    source: params.source,
    workspaceDir: params.workspaceDir,
    manifest: params.manifest,
    staticMetadata: {
      configSchema: params.manifest.configSchema,
      configUiHints: params.manifest.uiHints,
      package: packageMetadata,
    },
    contributions,
  };
}
