import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadResolvedExtensionRegistry,
  type ResolvedExtensionRegistry,
} from "../../extension-host/resolved-registry.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  normalizePluginsConfig,
  resolveEffectiveEnableState,
  resolveMemorySlotDecision,
} from "../../plugins/config-state.js";
import { isPathInsideWithRealpath } from "../../security/scan-paths.js";

const log = createSubsystemLogger("skills");

export function collectPluginSkillDirsFromRegistry(params: {
  registry: ResolvedExtensionRegistry;
  config?: OpenClawConfig;
}): string[] {
  const registry = params.registry;
  if (registry.extensions.length === 0) {
    return [];
  }
  const normalizedPlugins = normalizePluginsConfig(params.config?.plugins);
  const acpEnabled = params.config?.acp?.enabled !== false;
  const memorySlot = normalizedPlugins.slots.memory;
  let selectedMemoryPluginId: string | null = null;
  const seen = new Set<string>();
  const resolved: string[] = [];

  for (const record of registry.extensions) {
    const extension = record.extension;
    const skillPaths = extension.manifest.skills ?? [];
    if (skillPaths.length === 0) {
      continue;
    }
    const enableState = resolveEffectiveEnableState({
      id: extension.id,
      origin: extension.origin ?? "workspace",
      config: normalizedPlugins,
      rootConfig: params.config,
    });
    if (!enableState.enabled) {
      continue;
    }
    // ACP router skills should not be attached when ACP is explicitly disabled.
    if (!acpEnabled && extension.id === "acpx") {
      continue;
    }
    const memoryDecision = resolveMemorySlotDecision({
      id: extension.id,
      kind: extension.kind,
      slot: memorySlot,
      selectedId: selectedMemoryPluginId,
    });
    if (!memoryDecision.enabled) {
      continue;
    }
    if (memoryDecision.selected && extension.kind === "memory") {
      selectedMemoryPluginId = extension.id;
    }
    const rootDir = extension.rootDir ?? path.dirname(record.manifestPath);
    for (const raw of skillPaths) {
      const trimmed = raw.trim();
      if (!trimmed) {
        continue;
      }
      const candidate = path.resolve(rootDir, trimmed);
      if (!fs.existsSync(candidate)) {
        log.warn(`plugin skill path not found (${extension.id}): ${candidate}`);
        continue;
      }
      if (!isPathInsideWithRealpath(rootDir, candidate, { requireRealpath: true })) {
        log.warn(`plugin skill path escapes plugin root (${extension.id}): ${candidate}`);
        continue;
      }
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      resolved.push(candidate);
    }
  }

  return resolved;
}

export function resolvePluginSkillDirs(params: {
  workspaceDir: string | undefined;
  config?: OpenClawConfig;
}): string[] {
  const workspaceDir = (params.workspaceDir ?? "").trim();
  if (!workspaceDir) {
    return [];
  }
  const registry = loadResolvedExtensionRegistry({
    workspaceDir,
    config: params.config,
  });
  return collectPluginSkillDirsFromRegistry({
    registry,
    config: params.config,
  });
}
