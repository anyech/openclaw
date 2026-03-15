import { describe, expect, it } from "vitest";
import { buildResolvedExtensionValidationIndex } from "./resolved-extension-validation.js";

describe("buildResolvedExtensionValidationIndex", () => {
  it("collects known ids, channel ids, and schema-bearing entries from resolved extensions", () => {
    const index = buildResolvedExtensionValidationIndex({
      diagnostics: [],
      extensions: [
        {
          extension: {
            id: "helper-plugin",
            origin: "config",
            manifest: {
              id: "helper-plugin",
              configSchema: { type: "object" },
              channels: ["apn", "custom-chat"],
            },
            staticMetadata: {
              configSchema: {
                type: "object",
                properties: {
                  enabledFlag: { type: "boolean" },
                },
              },
              package: { entries: ["index.ts"] },
            },
            contributions: [],
          },
          manifestPath: "/tmp/helper/openclaw.plugin.json",
          schemaCacheKey: "helper-schema",
        },
      ],
    });

    expect(index.knownIds).toEqual(new Set(["helper-plugin"]));
    expect(index.channelIds).toEqual(new Set(["apn", "custom-chat"]));
    expect(index.lowercaseChannelIds).toEqual(new Set(["apn", "custom-chat"]));
    expect(index.entries).toEqual([
      expect.objectContaining({
        id: "helper-plugin",
        origin: "config",
        channels: ["apn", "custom-chat"],
        schemaCacheKey: "helper-schema",
      }),
    ]);
  });
});
