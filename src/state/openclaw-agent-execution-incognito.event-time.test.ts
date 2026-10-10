import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import type { IncognitoComputeTarget } from "../config/sessions/session-incognito-compute-contract.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import { createIncognitoUsageCostAdapter } from "../infra/session-cost-usage-incognito.js";
import {
  prepareUsageCostWorker,
  runUsageCostWorker,
} from "../infra/session-cost-usage-worker-runtime.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";
import { useIncognitoNoHostSql } from "./openclaw-agent-execution-incognito.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority: IncognitoSessionAuthority = { assertCurrent() {} };
let actor: IncognitoAgentDatabaseExecution;
let otherActor: IncognitoAgentDatabaseExecution;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-event-time-") };
  actor = await captureActor("main");
  otherActor = await captureActor("other");
});
useIncognitoNoHostSql();
afterAll(async () => {
  await otherActor?.close();
  await actor?.close();
  await closeOpenClawStateDatabaseAsync();
});

async function captureActor(agentId: string) {
  const opened = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId,
    env,
    authority,
  });
  assert(opened);
  return opened;
}

function location(owner = actor) {
  return { agentId: owner.agentId, path: owner.path };
}

async function create(sessionId: string, owner = actor): Promise<IncognitoComputeTarget> {
  const sessionKey = `agent:${location(owner).agentId}:dashboard:incognito-${sessionId}`;
  const created = await owner.sessions.create(authority, {
    sessionKey,
    entry: {
      sessionId,
      createdAt: 10_000,
      updatedAt: 10_000,
      lifecycleRevision: "initial",
      incognito: true,
    },
  });
  assert(created.entry);
  return { sessionKey, sessionId, lifecycleRevision: created.entry.lifecycleRevision };
}

function append(
  target: IncognitoComputeTarget,
  content: string,
  owner = actor,
  parentId?: string | null,
) {
  return owner.sessions.transcript(authority, {
    type: "session.message.append",
    input: {
      sessionKey: target.sessionKey,
      sessionId: target.sessionId,
      fence: { expectedLifecycleRevision: target.lifecycleRevision },
      parentId,
      message: {
        role: "assistant",
        content: [{ type: "text", text: content }],
        timestamp: 10_000,
        provider: "test",
        model: "test",
        usage: { input: 7, output: 3, totalTokens: 10, cost: { total: 1 } },
      },
    },
  });
}

function marker(target: IncognitoComputeTarget, owner = actor) {
  return formatSqliteSessionFileMarker({
    agentId: location(owner).agentId,
    storePath: location(owner).path,
    sessionId: target.sessionId,
  });
}

function prepare(owner = actor) {
  return prepareUsageCostWorker({
    agentId: location(owner).agentId,
    databasePath: location(owner).path,
    storePath: location(owner).path,
    agentDir: path.dirname(location(owner).path),
    config: {},
    env,
  });
}

function usage(
  target: IncognitoComputeTarget,
  operation: Parameters<typeof runUsageCostWorker>[1],
  owner = actor,
  grant = authority,
) {
  return runUsageCostWorker(prepare(owner), operation, { actor: owner, authority: grant, target });
}

function stats(target: IncognitoComputeTarget, owner = actor) {
  return owner.sessions.withCompute(authority, target, (compute) =>
    compute.execute({
      type: "session.compute.usage.stats",
      input: { ...target, request: {} },
    }),
  );
}

describe("cross-actor compute", () => {
  it("keeps a snapshot current through unclaimed source cleanup", async () => {
    const target = await create("neutral-source-cleanup");
    await append(target, "before source cleanup");
    const snapshot = actor.sessions.captureSnapshot(target.sessionKey);
    const sourceId = "neutral-read-source";

    await actor.sessions.withCompute(authority, target, async (compute) => {
      await compute.execute({
        type: "session.compute.source.open",
        input: { ...target, sourceId },
      });
      await expect(
        compute.execute({
          type: "session.compute.source.read",
          input: { ...target, sourceId },
        }),
      ).resolves.toMatchObject({ type: "source-frame" });
    });

    expect(() => snapshot.assertCurrent()).not.toThrow();
    await append(target, "after source cleanup");
    expect(() => snapshot.assertCurrent()).toThrow(
      "Incognito session snapshot changed; prepare it again",
    );
  });

  it("does not rearm a stale snapshot after an append during source scope", async () => {
    const target = await create("append-during-source-cleanup");
    await append(target, "before retained source");
    const snapshot = actor.sessions.captureSnapshot(target.sessionKey);
    const sourceId = "retained-read-source";
    let appendCompletedBeforeCleanup = false;

    await actor.sessions.withCompute(authority, target, async (compute) => {
      await compute.execute({
        type: "session.compute.source.open",
        input: { ...target, sourceId },
      });
      await compute.execute({
        type: "session.compute.source.read",
        input: { ...target, sourceId },
      });
      const result = await append(target, "concurrent append while source retained");
      assert(result.ok);
      appendCompletedBeforeCleanup = true;
    });

    expect(appendCompletedBeforeCleanup).toBe(true);
    expect(() => snapshot.assertCurrent()).toThrow(
      "Incognito session snapshot changed; prepare it again",
    );
  });

  it("routes bounded memory event-time through owned frames and rejects foreign or cancelled reads", async ({
    signal,
  }) => {
    const target = await create("event-time-frames");
    await append(target, "bounded event-time usage");
    const sessionFile = marker(target);
    const inRange = await usage(target, {
      kind: "inventory",
      sessionFiles: [sessionFile],
      eventTimeRange: { startMs: 9_999, endMs: 10_001 },
    });
    expect(inRange).toMatchObject({
      kind: "inventory",
      files: [expect.objectContaining({ sourcePath: sessionFile })],
    });
    const outOfRange = await usage(target, {
      kind: "inventory",
      sessionFiles: [sessionFile],
      eventTimeRange: { startMs: 20_000, endMs: 20_001 },
    });
    expect(outOfRange).toMatchObject({ kind: "inventory", files: [] });

    const eventMarker = {
      agentId: actor.agentId,
      storePath: actor.path,
      sessionId: target.sessionId,
    };
    await actor.sessions.withCompute(authority, target, async (compute) => {
      const adapter = createIncognitoUsageCostAdapter(
        compute,
        target,
        { agentId: actor.agentId, storePath: actor.path },
        [{ ...target, updatedAtMs: 0 }],
      );
      await expect(
        adapter.read({
          kind: "memory-event-time",
          input: {
            marker: eventMarker,
            range: { startMs: 9_999, endMs: 10_001 },
            updatedAtMs: 0,
          },
        }),
      ).resolves.toBe(true);
      await expect(
        adapter.read({
          kind: "memory-event-time",
          input: {
            marker: eventMarker,
            range: { startMs: 20_000, endMs: 20_001 },
            updatedAtMs: 0,
          },
        }),
      ).resolves.toBe(false);
    });

    const emptyTarget = await create("event-time-empty");
    await actor.sessions.withCompute(authority, emptyTarget, async (compute) => {
      const execute = vi.spyOn(compute, "execute");
      try {
        const adapter = createIncognitoUsageCostAdapter(
          compute,
          emptyTarget,
          { agentId: actor.agentId, storePath: actor.path },
          [{ ...emptyTarget, updatedAtMs: 0 }],
        );
        await expect(
          adapter.read({
            kind: "memory-event-time",
            input: {
              marker: {
                agentId: actor.agentId,
                storePath: actor.path,
                sessionId: emptyTarget.sessionId,
              },
              range: { startMs: 9_999, endMs: 10_001 },
              updatedAtMs: 0,
            },
          }),
        ).resolves.toBe(false);
        const commands = execute.mock.calls.map(([command]) => command);
        expect(commands.map(({ type }) => type)).toEqual([
          "session.compute.usage.stats",
          "session.compute.source.open",
          "session.compute.source.read",
          "session.compute.source.read",
        ]);
        const [statsCommand, openCommand, ...readCommands] = commands;
        if (statsCommand?.type !== "session.compute.usage.stats") {
          throw new Error("Empty-target event-time preflight must read transcript stats first");
        }
        expect(statsCommand.input).toMatchObject({
          sessionKey: emptyTarget.sessionKey,
          sessionId: emptyTarget.sessionId,
          lifecycleRevision: emptyTarget.lifecycleRevision,
        });
        if (openCommand?.type !== "session.compute.source.open") {
          throw new Error(
            "Empty-target event-time preflight must open its owned transcript source",
          );
        }
        expect(openCommand.input).toMatchObject({
          sessionKey: emptyTarget.sessionKey,
          sessionId: emptyTarget.sessionId,
          lifecycleRevision: emptyTarget.lifecycleRevision,
        });
        if (!("sourceId" in openCommand.input)) {
          throw new Error("Owned transcript source.open must carry its source ID");
        }
        const sourceId = openCommand.input.sourceId;
        expect(sourceId).toEqual(expect.any(String));
        for (const command of readCommands) {
          if (command.type !== "session.compute.source.read") {
            throw new Error("Empty-target event-time preflight must read only its owned source");
          }
          expect(command.input).toMatchObject({
            sessionKey: emptyTarget.sessionKey,
            sessionId: emptyTarget.sessionId,
            lifecycleRevision: emptyTarget.lifecycleRevision,
            sourceId,
          });
        }
      } finally {
        execute.mockRestore();
      }
    });

    const before = await stats(target);
    const foreign = await create("event-time-foreign", otherActor);
    await actor.sessions.withCompute(authority, target, async (compute) => {
      const execute = vi.spyOn(compute, "execute");
      try {
        const adapter = createIncognitoUsageCostAdapter(
          compute,
          target,
          { agentId: actor.agentId, storePath: actor.path },
          [{ ...target, updatedAtMs: 10_000 }],
        );
        await expect(
          adapter.read(
            {
              kind: "memory-event-time",
              input: {
                marker: {
                  agentId: otherActor.agentId,
                  storePath: otherActor.path,
                  sessionId: foreign.sessionId,
                },
                range: { startMs: 9_999, endMs: 10_001 },
                updatedAtMs: 0,
              },
            },
            signal,
          ),
        ).rejects.toThrow("another incognito session");
        expect(execute).not.toHaveBeenCalled();
      } finally {
        execute.mockRestore();
      }
    });

    const controller = new AbortController();
    const cancellation = new Error("memory event-time read cancelled");
    controller.abort(cancellation);
    await actor.sessions.withCompute(authority, target, async (compute) => {
      const execute = vi.spyOn(compute, "execute");
      try {
        const adapter = createIncognitoUsageCostAdapter(
          compute,
          target,
          { agentId: actor.agentId, storePath: actor.path },
          [{ ...target, updatedAtMs: 0 }],
        );
        await expect(
          adapter.read(
            {
              kind: "memory-event-time",
              input: {
                marker: eventMarker,
                range: { startMs: 9_999, endMs: 10_001 },
                updatedAtMs: 0,
              },
            },
            controller.signal,
          ),
        ).rejects.toBe(cancellation);
        expect(execute).not.toHaveBeenCalled();
      } finally {
        execute.mockRestore();
      }
    });
    await expect(stats(target)).resolves.toEqual(before);
  });
});
