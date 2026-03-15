import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXTENSION_ENTRY_CANDIDATES,
  getExtensionPackageMetadata,
  resolveExtensionEntryCandidates,
  resolveLegacyExtensionDescriptor,
} from "./schema.js";

describe("extension host schema helpers", () => {
  it("normalizes package metadata through the host boundary", () => {
    const metadata = getExtensionPackageMetadata({
      openclaw: {
        channel: {
          id: "telegram",
          label: "Telegram",
        },
        install: {
          npmSpec: "@openclaw/telegram",
          defaultChoice: "npm",
        },
      },
    });

    expect(metadata).toEqual({
      channel: {
        id: "telegram",
        label: "Telegram",
      },
      install: {
        npmSpec: "@openclaw/telegram",
        defaultChoice: "npm",
      },
    });
  });

  it("preserves current extension entry resolution semantics", () => {
    expect(resolveExtensionEntryCandidates(undefined)).toEqual({
      status: "missing",
      entries: [],
    });
    expect(DEFAULT_EXTENSION_ENTRY_CANDIDATES).toContain("index.ts");
    expect(
      resolveExtensionEntryCandidates({
        openclaw: {
          extensions: ["./dist/index.js"],
        },
      }),
    ).toEqual({
      status: "ok",
      entries: ["./dist/index.js"],
    });
  });

  it("builds a normalized legacy extension descriptor", () => {
    const resolved = resolveLegacyExtensionDescriptor({
      manifest: {
        id: "telegram",
        name: "Telegram",
        configSchema: { type: "object" },
        channels: ["telegram"],
        providers: ["telegram-provider"],
      },
      packageManifest: {
        openclaw: {
          channel: {
            id: "telegram",
            label: "Telegram",
          },
          install: {
            npmSpec: "@openclaw/telegram",
            defaultChoice: "npm",
          },
        },
      },
      origin: "bundled",
      rootDir: "/tmp/telegram",
      source: "/tmp/telegram/index.ts",
    });

    expect(resolved.id).toBe("telegram");
    expect(resolved.staticMetadata.package.entries).toEqual([
      "index.ts",
      "index.js",
      "index.mjs",
      "index.cjs",
    ]);
    expect(resolved.contributions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "telegram/config",
          kind: "surface.config",
        }),
        expect.objectContaining({
          id: "telegram/channel/telegram",
          kind: "adapter.runtime",
        }),
        expect.objectContaining({
          id: "telegram/provider/telegram-provider",
          kind: "capability.provider-integration",
        }),
        expect.objectContaining({
          id: "telegram/channel-catalog",
          kind: "surface.channel-catalog",
        }),
        expect.objectContaining({
          id: "telegram/install",
          kind: "surface.install",
        }),
      ]),
    );
  });
});
