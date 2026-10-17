import fs from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolvePersistentApplyInference, verifySetupInference } from "./setup-inference-turn.js";

afterEach(() => cliBackendsTesting.resetDepsForTest());
const runtime: RuntimeEnv = {
  log() {},
  error() {},
  exit() {
    throw new Error("unexpected exit");
  },
};

it("reprobes the same configured fallback for an opaque owner at persistent apply", async () => {
  await withOpenClawTestState({ label: "opaque-configured-fallback" }, async (state) => {
    const callsPath = state.path("cli-calls.jsonl");
    const script = await state.writeText(
      "fixture-cli.mjs",
      `import { appendFileSync } from "node:fs";
appendFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)) + "\\n");
process.stdout.write("OK\\n");
`,
    );
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        {
          id: "fixture-cli",
          pluginId: "fixture",
          nativeToolMode: "none",
          sideQuestionToolMode: "disabled",
          config: {
            command: process.execPath,
            args: [script, callsPath],
            modelArg: "--model",
            output: "text",
            input: "arg",
            sessionMode: "none",
            systemPromptWhen: "never",
          },
        },
      ],
    });
    const fallbackModelRef = "fixture-cli/second";
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      agents: {
        entries: {
          ops: {
            model: { primary: "fixture-primary/first", fallbacks: [fallbackModelRef] },
          },
        },
      },
    };
    await state.writeConfig(config);
    const readSnapshot = () =>
      readConfigFileSnapshot({ observe: false, pluginValidation: "core-only" });
    const result = await verifySetupInference({
      agentId: "ops",
      fallbackModelRef,
      bindSession: true,
      runtime,
      deps: { readConfigFileSnapshot: readSnapshot },
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.binding.auth).toMatchObject({
      proofKind: "runtime-owner",
      runtimeOwnerKind: "cli-runtime",
      runtimeOwnerId: "fixture-cli",
    });
    expect(result.binding.execution.fallbackModelRef).toBe(fallbackModelRef);
    const readCalls = async (): Promise<unknown[]> =>
      (await fs.readFile(callsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    expect(await readCalls()).toEqual([expect.arrayContaining(["--model", "second"])]);
    await expect(
      resolvePersistentApplyInference({
        binding: result.binding,
        runtime,
        deps: { readConfigFileSnapshot: readSnapshot },
      }),
    ).resolves.toBe(result.binding.execution);
    expect(await readCalls()).toEqual([
      expect.arrayContaining(["--model", "second"]),
      expect.arrayContaining(["--model", "second"]),
    ]);
  });
});
