import type { PluginCandidate } from "../plugins/discovery.js";
import {
  loadPackageManifest,
  type PackageManifest,
  type PluginManifest,
} from "../plugins/manifest.js";
import { resolveLegacyExtensionDescriptor, type ResolvedExtension } from "./schema.js";

export type ResolvedExtensionRecord = {
  extension: ResolvedExtension;
  manifestPath: string;
  schemaCacheKey?: string;
};

export function buildResolvedExtensionRecord(params: {
  manifest: PluginManifest;
  candidate: PluginCandidate;
  manifestPath: string;
  schemaCacheKey?: string;
  configSchema?: Record<string, unknown>;
}): ResolvedExtensionRecord {
  const packageDir = params.candidate.packageDir ?? params.candidate.rootDir;
  const packageManifest =
    params.candidate.packageManifest ||
    params.candidate.packageName ||
    params.candidate.packageVersion
      ? ({
          openclaw: params.candidate.packageManifest,
          name: params.candidate.packageName,
          version: params.candidate.packageVersion,
          description: params.candidate.packageDescription,
        } as PackageManifest)
      : (loadPackageManifest(packageDir, params.candidate.origin !== "bundled") ?? undefined);

  const extension = resolveLegacyExtensionDescriptor({
    manifest: {
      ...params.manifest,
      configSchema: params.configSchema ?? params.manifest.configSchema,
    },
    packageManifest,
    origin: params.candidate.origin,
    rootDir: params.candidate.rootDir,
    source: params.candidate.source,
    workspaceDir: params.candidate.workspaceDir,
  });

  return {
    extension,
    manifestPath: params.manifestPath,
    schemaCacheKey: params.schemaCacheKey,
  };
}
