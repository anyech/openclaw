import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
// Tests typing mode persistence across session updates and reply turns.
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeAgentRunHumanWait } from "../../agents/agent-run-approval-wait.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { seedSubagentRunForReadTest } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { createTypingCallbacks } from "../../channels/typing.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { createTestReplyOperation } from "./reply-run-registry.test-helpers.js";
import { testing } from "./reply-run-registry.test-support.js";
import { bindReplyOperationTyping } from "./reply-run-typing.js";
import { bindReplyTypingChannelCallbacks } from "./reply-typing-channel-bindings.js";
import {
  createTypingAudienceOwnership,
  typingAudienceOwnerCountForTests,
} from "./typing-audience-lifecycle.js";
import { createReplyBackgroundWorkObserver } from "./typing-background-work.runtime.js";
import { createTypingSignaler } from "./typing-mode.js";
import { createTypingController } from "./typing.js";

describe("typing persistence bug fix", () => {
  let onReplyStartSpy: Mock;
  let onCleanupSpy: Mock;
  let controller: ReturnType<typeof createTypingController>;

  beforeEach(() => {
    vi.useFakeTimers();
    onReplyStartSpy = vi.fn();
    onCleanupSpy = vi.fn();

    controller = createTypingController({
      onReplyStart: onReplyStartSpy,
      onCleanup: onCleanupSpy,
      typingIntervalSeconds: 6,
      log: vi.fn(),
    });
  });

  afterEach(() => {
    testing.resetReplyRunRegistry();
    vi.useRealTimers();
  });

  it("keeps typing alive while keepalive ticks continue during long runs", async () => {
    const longRunCleanupSpy = vi.fn();
    const longRunController = createTypingController({
      onReplyStart: onReplyStartSpy,
      onCleanup: longRunCleanupSpy,
      typingIntervalSeconds: 6,
      log: vi.fn(),
    });

    await longRunController.startTypingLoop();
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(6000);
    expect(onReplyStartSpy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(115_000);
    expect(longRunCleanupSpy).not.toHaveBeenCalled();
    expect(onReplyStartSpy).toHaveBeenCalledTimes(21);

    longRunController.cleanup();
    expect(longRunCleanupSpy).toHaveBeenCalledTimes(1);
  });

  it("pauses parent human waits, keeps other live owners visible, and resumes on execution", async () => {
    let workState: "active" | "waiting" | "none" = "none";
    let publishWork: ((state: typeof workState) => void) | undefined;
    const runId = "parent-wait-run";
    const sessionKey = "agent:main:discord:channel:parent-wait";
    const starts = vi.fn();
    const pause = vi.fn();
    const ownerController = createTypingController({
      onReplyStart: starts,
      typingIntervalSeconds: 1,
      backgroundWorkObserverFactory: ({ onChange }) => {
        publishWork = onChange;
        return { currentState: () => workState, dispose: vi.fn() };
      },
      parentWaitObserverFactory: (identity) => observeAgentRunHumanWait(identity),
    });
    ownerController.setBackgroundWorkPause?.(pause, "discord/account/parent-wait");
    ownerController.bindRunIdentity?.(runId, sessionKey, "session-id");
    await ownerController.startTypingLoop();
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }

    const lifecycle = (phase: string) =>
      emitAgentEvent({
        runId,
        sessionKey,
        sessionId: "session-id",
        stream: "lifecycle",
        data: { phase, approvalId: "approval-1" },
      });
    lifecycle("waiting-approval");
    const duringWait = starts.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(starts).toHaveBeenCalledTimes(duringWait);
    expect(pause).toHaveBeenCalledTimes(1);

    lifecycle("approval-resolved");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(starts).toHaveBeenCalledTimes(duringWait);

    workState = "active";
    publishWork?.(workState);
    const withOtherWork = starts.mock.calls.length;
    expect(withOtherWork).toBeGreaterThan(duringWait);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(starts.mock.calls.length).toBeGreaterThan(withOtherWork);

    workState = "none";
    publishWork?.(workState);
    const afterWorkEnded = starts.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(starts).toHaveBeenCalledTimes(afterWorkEnded);

    const signaler = createTypingSignaler({
      typing: ownerController,
      mode: "instant",
      isHeartbeat: false,
    });
    await signaler.signalExecutionActivity?.();
    const afterResume = starts.mock.calls.length;
    expect(afterResume).toBeGreaterThan(afterWorkEnded);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(starts.mock.calls.length).toBeGreaterThan(afterResume);

    ownerController.cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps typing callbacks paused after a seeded unknown approval wait until its run executes", async () => {
    const runId = "seeded-unknown-typing-run";
    const sessionKey = "agent:main:discord:channel:seeded-unknown-typing";
    const sessionId = "seeded-unknown-typing-session";
    registerAgentRunContext(runId, { sessionKey, sessionId });
    const event = (state: "waiting" | "unknown" | "running") =>
      emitAgentEvent({
        runId,
        sessionKey,
        sessionId,
        stream: "execution",
        data: {
          state,
          sourceId: "ask_user",
          executionId: "seeded-approval-question",
          ...(state === "waiting" ? { wait: { kind: "approval" } } : {}),
        },
      });
    event("waiting");
    const starts = vi.fn();
    const pause = vi.fn();
    const owner = createTypingController({
      onReplyStart: starts,
      typingIntervalSeconds: 1,
      parentWaitObserverFactory: (identity) => observeAgentRunHumanWait(identity),
    });
    owner.setBackgroundWorkPause?.(pause, "discord/account/seeded-unknown-typing");
    owner.bindRunIdentity?.(runId, sessionKey, sessionId);
    try {
      await owner.startTypingLoop();
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
      expect(pause).toHaveBeenCalledTimes(1);
      const startsWhileSeededWait = starts.mock.calls.length;

      event("unknown");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(starts).toHaveBeenCalledTimes(startsWhileSeededWait);
      expect(pause).toHaveBeenCalledTimes(1);

      event("running");
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
      expect(starts.mock.calls.length).toBeGreaterThan(startsWhileSeededWait);
    } finally {
      owner.cleanup();
      clearAgentRunContext(runId);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps Discord typing paused until all concurrent same-source human waits resume", async () => {
    const runId = "concurrent-parent-wait-run";
    const sessionKey = "agent:main:discord:channel:concurrent-parent-wait";
    const sessionId = "concurrent-parent-wait-session";
    const starts = vi.fn();
    const pause = vi.fn();
    const ownerController = createTypingController({
      onReplyStart: starts,
      typingIntervalSeconds: 1,
      parentWaitObserverFactory: (identity) => observeAgentRunHumanWait(identity),
    });
    ownerController.setBackgroundWorkPause?.(pause, "discord/account/concurrent-parent-wait");
    ownerController.bindRunIdentity?.(runId, sessionKey, sessionId);
    await ownerController.startTypingLoop();
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }

    const execution = (state: "waiting" | "running", executionId: string) =>
      emitAgentEvent({
        runId,
        sessionKey,
        sessionId,
        stream: "execution",
        data: {
          state,
          sourceId: "ask_user",
          executionId,
          ...(state === "waiting" ? { wait: { kind: "user_input" } } : {}),
        },
      });
    execution("waiting", "question-1");
    execution("waiting", "question-2");
    const pausedStarts = starts.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(starts).toHaveBeenCalledTimes(pausedStarts);

    execution("running", "question-1");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(starts).toHaveBeenCalledTimes(pausedStarts);

    execution("running", "question-2");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(starts.mock.calls.length).toBeGreaterThan(pausedStarts);
    ownerController.cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reconciles callback-driven selected-owner release and empties the audience map", () => {
    expect(typingAudienceOwnerCountForTests()).toBe(0);
    const key = "discord/account/reentrant";
    const oldChanges: boolean[] = [];
    const old = createTypingAudienceOwnership({
      audienceKey: key,
      onOwnershipChange: (owns) => oldChanges.push(owns),
    });
    old?.setActive(true);
    expect(old?.isOwner()).toBe(true);

    const newer = createTypingAudienceOwnership({
      audienceKey: key,
      onOwnershipChange: (owns) => {
        if (owns) {
          newer?.release();
        }
      },
    });
    newer?.setActive(true);

    expect(newer?.isOwner()).toBe(false);
    expect(old?.isOwner()).toBe(true);
    expect(oldChanges).toEqual([true, false, true]);
    expect(typingAudienceOwnerCountForTests()).toBe(1);

    old?.release();
    expect(typingAudienceOwnerCountForTests()).toBe(0);
    const fresh = createTypingAudienceOwnership({ audienceKey: key, onOwnershipChange: vi.fn() });
    fresh?.setActive(true);
    expect(fresh?.isOwner()).toBe(true);
    fresh?.release();
    expect(typingAudienceOwnerCountForTests()).toBe(0);
  });

  it("transfers one Discord audience cadence to a newer turn and restores older live work", async () => {
    let oldState: "active" | "waiting" | "none" = "none";
    let publishOld: ((state: typeof oldState) => void) | undefined;
    const oldStart = vi.fn();
    const newStart = vi.fn();
    const oldCleanup = vi.fn();
    const newCleanup = vi.fn();
    const audience = JSON.stringify(["discord", "account-a", "channel-a"]);
    const old = createTypingController({
      onReplyStart: oldStart,
      onCleanup: oldCleanup,
      typingIntervalSeconds: 1,
      backgroundWorkObserverFactory: ({ onChange }) => {
        publishOld = onChange;
        return { currentState: () => oldState, dispose: vi.fn() };
      },
    });
    old.setBackgroundWorkPause?.(vi.fn(), audience);
    old.bindRunIdentity?.("old-run", "agent:main:discord:channel:typing");
    await old.startTypingLoop();
    await Promise.resolve();
    await Promise.resolve();
    oldState = "active";
    publishOld?.(oldState);
    old.markRunComplete();
    old.markDispatchIdle();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(oldStart.mock.calls.length).toBeGreaterThan(1);

    const newTurn = createTypingController({
      onReplyStart: newStart,
      onCleanup: newCleanup,
      typingIntervalSeconds: 1,
      backgroundWorkObserverFactory: () => ({ currentState: () => "none", dispose: vi.fn() }),
    });
    newTurn.setBackgroundWorkPause?.(vi.fn(), audience);
    newTurn.bindRunIdentity?.("new-run", "agent:main:discord:channel:typing");
    await newTurn.startTypingLoop();
    await Promise.resolve();
    await Promise.resolve();
    expect(newStart).toHaveBeenCalled();

    const oldAtHandoff = oldStart.mock.calls.length;
    const newAtHandoff = newStart.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(oldStart).toHaveBeenCalledTimes(oldAtHandoff);
    expect(newStart.mock.calls.length).toBeGreaterThan(newAtHandoff);

    newTurn.markRunComplete();
    newTurn.markDispatchIdle();
    await Promise.resolve();
    await Promise.resolve();
    expect(newCleanup).toHaveBeenCalledTimes(1);
    const restoredOldCount = oldStart.mock.calls.length;
    const finishedNewCount = newStart.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(oldStart.mock.calls.length).toBeGreaterThan(restoredOldCount);
    expect(newStart).toHaveBeenCalledTimes(finishedNewCount);

    oldState = "none";
    publishOld?.(oldState);
    expect(oldCleanup).toHaveBeenCalledTimes(1);
    const terminalOldCount = oldStart.mock.calls.length;
    publishOld?.("active");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(oldStart).toHaveBeenCalledTimes(terminalOldCount);
    expect(vi.getTimerCount()).toBe(0);
    old.cleanup();
    newTurn.cleanup();
  });

  it("retires the core owner at transport breaker trip and ignores a late success", async () => {
    const disposed = vi.fn();
    const startError = vi.fn();
    const failingCallbacks = createTypingCallbacks({
      start: vi.fn().mockRejectedValue(new Error("typing endpoint unavailable")),
      onStartError: startError,
      keepaliveIntervalMs: 0,
      maxDurationMs: 0,
      maxConsecutiveFailures: 2,
      backgroundWorkKeepalive: true,
    });
    const failedCleanup = vi.fn();
    const failedOwner = createTypingController({
      onReplyStart: () => failingCallbacks.onReplyStart(),
      onCleanup: () => {
        failingCallbacks.onCleanup?.();
        failedCleanup();
      },
      typingIntervalSeconds: 1,
      backgroundWorkObserverFactory: ({ onChange }) => {
        onChange("active");
        return { currentState: () => "active", dispose: disposed };
      },
      parentWaitObserverFactory: (identity) => observeAgentRunHumanWait(identity),
    });
    const failingAudience = {
      ...failingCallbacks,
      backgroundWorkAudienceKey: "discord/account/transport-failure",
    };
    bindReplyTypingChannelCallbacks(failedOwner, failingAudience);
    failedOwner.bindRunIdentity?.("transport-failure-run", "agent:main:discord:channel:typing");
    await failedOwner.startTypingLoop();
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
    failedOwner.markRunComplete();
    failedOwner.markDispatchIdle();
    await Promise.resolve();
    await Promise.resolve();
    expect(failedCleanup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
    expect(startError).toHaveBeenCalledTimes(2);
    expect(failedCleanup).toHaveBeenCalledTimes(1);
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(failedOwner.shouldRetainChannelCallbacks?.()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    const pendingStart = createDeferred();
    const lateCallbacks = createTypingCallbacks({
      start: () => pendingStart.promise,
      onStartError: vi.fn(),
      keepaliveIntervalMs: 0,
      maxDurationMs: 0,
      backgroundWorkKeepalive: true,
    });
    const lateDispose = vi.fn();
    const lateStarts = vi.fn();
    const lateOwner = createTypingController({
      onReplyStart: async () => {
        lateStarts();
        await lateCallbacks.onReplyStart();
      },
      onCleanup: () => lateCallbacks.onCleanup?.(),
      typingIntervalSeconds: 1,
      backgroundWorkObserverFactory: () => ({ currentState: () => "active", dispose: lateDispose }),
      parentWaitObserverFactory: (identity) => observeAgentRunHumanWait(identity),
    });
    bindReplyTypingChannelCallbacks(lateOwner, {
      ...lateCallbacks,
      backgroundWorkAudienceKey: "discord/account/late-success",
    });
    lateOwner.bindRunIdentity?.("late-success-run", "agent:main:discord:channel:typing");
    await lateOwner.startTypingLoop();
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
    expect(lateStarts).toHaveBeenCalledTimes(1);
    lateOwner.cleanup();
    pendingStart.resolve();
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
    const settledStarts = lateStarts.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(lateStarts).toHaveBeenCalledTimes(settledStarts);
    expect(lateDispose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps no-key and private audiences from reviving a waiting public owner", async () => {
    let publicState: "active" | "waiting" | "none" = "none";
    let publishPublic: ((state: typeof publicState) => void) | undefined;
    const publicStart = vi.fn();
    const privateStart = vi.fn();
    const publicOwner = createTypingController({
      onReplyStart: publicStart,
      typingIntervalSeconds: 1,
      backgroundWorkObserverFactory: ({ onChange }) => {
        publishPublic = onChange;
        return { currentState: () => publicState, dispose: vi.fn() };
      },
    });
    publicOwner.setBackgroundWorkPause?.(vi.fn(), "discord/account/public-channel");
    publicOwner.bindRunIdentity?.("public-old-run", "agent:main:discord:channel:typing");
    await publicOwner.startTypingLoop();
    await Promise.resolve();
    await Promise.resolve();
    publicState = "active";
    publishPublic?.(publicState);
    publicOwner.markRunComplete();
    publicOwner.markDispatchIdle();
    const afterActive = publicStart.mock.calls.length;

    publicState = "waiting";
    publishPublic?.(publicState);
    const waitingCount = publicStart.mock.calls.length;
    const privateOwner = createTypingController({
      onReplyStart: privateStart,
      typingIntervalSeconds: 1,
      backgroundWorkObserverFactory: () => ({ currentState: () => "none", dispose: vi.fn() }),
    });
    privateOwner.setBackgroundWorkPause?.(vi.fn(), "discord/account/private-channel");
    privateOwner.bindRunIdentity?.("private-run", "agent:main:discord:channel:private");
    await privateOwner.startTypingLoop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(publicStart).toHaveBeenCalledTimes(waitingCount);
    expect(privateStart.mock.calls.length).toBeGreaterThan(1);

    const neverOwner = createTypingController({
      onReplyStart: vi.fn(),
      typingIntervalSeconds: 1,
    });
    neverOwner.setBackgroundWorkPause?.(vi.fn(), "discord/account/public-channel");
    neverOwner.bindRunIdentity?.("never-run", "agent:main:discord:channel:typing");
    neverOwner.cleanup();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(publicStart).toHaveBeenCalledTimes(waitingCount);

    publicState = "none";
    publishPublic?.(publicState);
    expect(publicOwner.shouldRetainChannelCallbacks?.()).toBe(false);
    privateOwner.cleanup();
    publicOwner.cleanup();
    expect(vi.getTimerCount()).toBe(0);
    expect(publicStart.mock.calls.length).toBeGreaterThanOrEqual(afterActive);
  });

  it("keeps one request owner alive for real work, pauses on waits, and seals late generations", async () => {
    let state: "active" | "waiting" | "none" = "none";
    let publish: ((next: typeof state) => void) | undefined;
    let disposed = false;
    const pause = vi.fn();
    const cleanup = vi.fn();
    const owner = createTypingController({
      onReplyStart: onReplyStartSpy,
      onCleanup: cleanup,
      typingIntervalSeconds: 6,
      backgroundWorkObserverFactory: ({ onChange }) => {
        publish = onChange;
        onChange(state);
        return {
          currentState: () => state,
          dispose: () => {
            disposed = true;
          },
        };
      },
      log: vi.fn(),
    });
    owner.setBackgroundWorkPause?.(pause);
    owner.bindRunIdentity?.("request-generation-1", "agent:main:discord:channel:typing");
    await owner.startTypingLoop();
    await Promise.resolve();
    await Promise.resolve();

    state = "active";
    publish?.(state);
    owner.markRunComplete();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(cleanup).not.toHaveBeenCalled();
    expect(onReplyStartSpy.mock.calls.length).toBeGreaterThan(2);
    owner.markDispatchIdle();
    await vi.advanceTimersByTimeAsync(132_000);
    expect(onReplyStartSpy.mock.calls.length).toBeGreaterThan(20);
    expect(cleanup).not.toHaveBeenCalled();
    expect(owner.shouldRetainChannelCallbacks?.()).toBe(true);

    state = "waiting";
    publish?.(state);
    const pausedCallCount = onReplyStartSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(onReplyStartSpy).toHaveBeenCalledTimes(pausedCallCount);
    expect(pause).toHaveBeenCalledTimes(1);

    state = "active";
    publish?.(state);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(onReplyStartSpy.mock.calls.length).toBeGreaterThan(pausedCallCount);

    state = "none";
    publish?.(state);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(disposed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    const closedCallCount = onReplyStartSpy.mock.calls.length;
    publish?.("active");
    owner.bindRunIdentity?.("request-generation-2", "agent:main:discord:channel:typing");
    await vi.advanceTimersByTimeAsync(12_000);
    expect(onReplyStartSpy).toHaveBeenCalledTimes(closedCallCount);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails closed when an observer rejects and ignores late owner callbacks", async () => {
    let publish: ((state: "active" | "waiting" | "none") => void) | undefined;
    const failedCleanup = vi.fn();
    const failedOwner = createTypingController({
      onReplyStart: onReplyStartSpy,
      onCleanup: failedCleanup,
      typingIntervalSeconds: 6,
      backgroundWorkObserverFactory: ({ onChange }) => {
        publish = onChange;
        throw new Error("owner unavailable");
      },
      log: vi.fn(),
    });
    failedOwner.setBackgroundWorkPause?.(vi.fn());
    failedOwner.bindRunIdentity?.("failed-run", "agent:main:discord:channel:typing");
    await failedOwner.startTypingLoop();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(failedCleanup).not.toHaveBeenCalled();
    failedOwner.markRunComplete();
    failedOwner.markDispatchIdle();
    const startsAfterFailure = onReplyStartSpy.mock.calls.length;
    publish?.("active");
    await vi.advanceTimersByTimeAsync(12_000);

    expect(failedCleanup).toHaveBeenCalledTimes(1);
    expect(onReplyStartSpy).toHaveBeenCalledTimes(startsAfterFailure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-arms one idle grace after live work ends without dispatcher idle", async () => {
    let state: "active" | "none" = "none";
    let publish: ((next: typeof state) => void) | undefined;
    const cleanup = vi.fn();
    const owner = createTypingController({
      onReplyStart: onReplyStartSpy,
      onCleanup: cleanup,
      typingIntervalSeconds: 6,
      backgroundWorkObserverFactory: ({ onChange }) => {
        publish = onChange;
        return { currentState: () => state, dispose: vi.fn() };
      },
      log: vi.fn(),
    });
    owner.setBackgroundWorkPause?.(vi.fn());
    owner.bindRunIdentity?.("terminal-run", "agent:main:discord:channel:typing");
    await owner.startTypingLoop();
    await Promise.resolve();
    await Promise.resolve();

    state = "active";
    publish?.(state);
    owner.markRunComplete();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(cleanup).not.toHaveBeenCalled();

    state = "none";
    publish?.(state);
    const startsAtTerminal = onReplyStartSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(9_999);
    expect(cleanup).not.toHaveBeenCalled();
    expect(onReplyStartSpy).toHaveBeenCalledTimes(startsAtTerminal);
    await vi.advanceTimersByTimeAsync(1);

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not attach a background owner without an adapter pause capability", async () => {
    const backgroundWorkObserverFactory = vi.fn(() => ({
      currentState: () => "active" as const,
      dispose: vi.fn(),
    }));
    const owner = createTypingController({
      onReplyStart: onReplyStartSpy,
      onCleanup: onCleanupSpy,
      typingIntervalSeconds: 6,
      backgroundWorkObserverFactory,
    });
    owner.bindRunIdentity?.("private-run", "agent:main:subagent:private");
    await owner.startTypingLoop();
    owner.markRunComplete();
    owner.markDispatchIdle();

    expect(backgroundWorkObserverFactory).not.toHaveBeenCalled();
    expect(onCleanupSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["completed", "failed", "aborted", "superseded"] as const)(
    "hands actual reply-operation clear to the controller only for %s",
    async (outcome) => {
      let state: "active" | "none" = "active";
      let publish: ((next: typeof state) => void) | undefined;
      const dispose = vi.fn();
      const cleanup = vi.fn();
      const owner = createTypingController({
        onReplyStart: onReplyStartSpy,
        onCleanup: cleanup,
        backgroundWorkObserverFactory: ({ onChange }) => {
          publish = onChange;
          return { currentState: () => state, dispose };
        },
      });
      owner.setBackgroundWorkPause?.(vi.fn());
      owner.bindRunIdentity?.("clear-owner", "agent:main:discord:channel:typing");
      await owner.startTypingLoop();
      await Promise.resolve();
      await Promise.resolve();
      const operation = createTestReplyOperation();
      operation.setPhase("running");
      bindReplyOperationTyping(operation, owner);
      if (outcome === "failed") {
        operation.fail("run_failed");
      } else if (outcome === "aborted") {
        operation.abortByUser();
      } else if (outcome === "superseded") {
        operation.supersede();
      }
      operation.complete();
      if (outcome === "completed") {
        expect(cleanup).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(132_000);
        expect(onReplyStartSpy.mock.calls.length).toBeGreaterThan(20);
        state = "none";
        publish?.(state);
      }
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(1);
      const starts = onReplyStartSpy.mock.calls.length;
      publish?.("active");
      await vi.advanceTimersByTimeAsync(12_000);
      expect(onReplyStartSpy).toHaveBeenCalledTimes(starts);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("retains validated owned waits past the idle grace and resumes on the source event", async () => {
    const requesterRunId = "long-wait-parent";
    const requesterSessionKey = "agent:main:discord:channel:typing";
    const waitingRunId = "long-wait-approval-child";
    const waitingSessionKey = "agent:main:subagent:long-wait-approval";
    const otherRunId = "long-wait-active-child";
    const otherSessionKey = "agent:main:subagent:long-wait-active";
    const seededRunIds = [waitingRunId, otherRunId];
    const claims: Array<{ runId: string; claimId: string }> = [];
    const observerDisposers: Mock[] = [];
    const observedStates: string[] = [];
    const pause = vi.fn();
    const cleanup = vi.fn();
    const starts = vi.fn();
    let owner: ReturnType<typeof createTypingController> | undefined;

    const seedOwnedChild = (runId: string, childSessionKey: string) => {
      seedSubagentRunForReadTest({
        runId,
        childSessionKey,
        childAgentId: "main",
        requesterSessionKey,
        requesterAgentId: "main",
        requesterTurnRunId: requesterRunId,
        requesterTurnYielded: true,
        expectsCompletionMessage: true,
        generation: 1,
        createdAt: Date.now(),
        execution: { status: "running", startedAt: Date.now() },
      });
      const claimId = claimAgentRunContext(
        runId,
        { sessionKey: childSessionKey, agentId: "main" },
        { trackOwner: true, ownsContext: true },
      );
      if (!claimId) {
        throw new Error(`Could not claim test child owner ${runId}`);
      }
      claims.push({ runId, claimId });
    };

    try {
      expect(typingAudienceOwnerCountForTests()).toBe(0);
      seedOwnedChild(waitingRunId, waitingSessionKey);
      seedOwnedChild(otherRunId, otherSessionKey);
      emitAgentEvent({
        runId: waitingRunId,
        sessionKey: waitingSessionKey,
        stream: "execution",
        data: {
          state: "waiting",
          wait: { kind: "user_input" },
          executionId: "long-wait-execution",
          sourceId: "long-wait-source",
        },
      });

      owner = createTypingController({
        onReplyStart: starts,
        onCleanup: cleanup,
        typingIntervalSeconds: 1,
        backgroundWorkObserverFactory: (observerParams) => {
          const observer = createReplyBackgroundWorkObserver({
            ...observerParams,
            onChange: (state) => {
              observedStates.push(state);
              observerParams.onChange(state);
            },
          });
          const dispose = vi.fn(() => observer.dispose());
          observerDisposers.push(dispose);
          return { currentState: () => observer.currentState(), dispose };
        },
        parentWaitObserverFactory: () => ({
          waiting: false,
          resumeRequired: false,
          markExecutionResumed: vi.fn(),
          dispose: vi.fn(),
        }),
      });
      owner.setBackgroundWorkPause?.(pause, "discord/account/long-wait");
      owner.bindRunIdentity?.(requesterRunId, requesterSessionKey);
      await owner.startTypingLoop();
      for (let index = 0; index < 12; index += 1) {
        await Promise.resolve();
      }
      expect(observerDisposers).toHaveLength(1);
      expect(observedStates).toContain("active");
      owner.markRunComplete();
      owner.markDispatchIdle();

      const withConcurrentWork = starts.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(starts.mock.calls.length).toBeGreaterThan(withConcurrentWork);

      // One exact live sibling ends; the other current, leased child is still waiting.
      emitAgentEvent({
        runId: otherRunId,
        sessionKey: otherSessionKey,
        stream: "lifecycle",
        data: { phase: "end" },
      });
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
      const startsAtWait = starts.mock.calls.length;
      expect(pause).toHaveBeenCalledTimes(1);
      expect(observedStates).toContain("waiting");
      expect(owner.shouldRetainChannelCallbacks?.()).toBe(true);
      expect(owner.isActive()).toBe(false);
      // Valid waiting custody retains one inactive registration, not an active cadence.
      expect(typingAudienceOwnerCountForTests()).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(starts).toHaveBeenCalledTimes(startsAtWait);
      expect(cleanup).not.toHaveBeenCalled();
      expect(observerDisposers[0]).not.toHaveBeenCalled();
      expect(owner.shouldRetainChannelCallbacks?.()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      // The same exact leased child publishes execution-resumed after its input wait.
      emitAgentEvent({
        runId: waitingRunId,
        sessionKey: waitingSessionKey,
        stream: "execution",
        data: {
          state: "running",
          executionId: "long-wait-execution",
          sourceId: "long-wait-source",
        },
      });
      for (let index = 0; index < 12; index += 1) {
        await Promise.resolve();
      }
      const startsAfterResume = starts.mock.calls.length;
      expect(observedStates.at(-1)).toBe("active");
      expect(startsAfterResume).toBeGreaterThan(startsAtWait);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(starts.mock.calls.length).toBeGreaterThan(startsAfterResume);

      emitAgentEvent({
        runId: waitingRunId,
        sessionKey: waitingSessionKey,
        stream: "lifecycle",
        data: { phase: "end" },
      });
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(observerDisposers[0]).toHaveBeenCalledTimes(1);
      expect(observedStates.at(-1)).toBe("none");
      expect(owner.shouldRetainChannelCallbacks?.()).toBe(false);
      expect(typingAudienceOwnerCountForTests()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      const terminalStarts = starts.mock.calls.length;
      emitAgentEvent({
        runId: waitingRunId,
        sessionKey: waitingSessionKey,
        stream: "execution",
        data: { state: "running", executionId: "late-after-terminal" },
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(starts).toHaveBeenCalledTimes(terminalStarts);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(observerDisposers[0]).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      owner?.cleanup();
      for (const { runId, claimId } of claims) {
        releaseAgentRunContext(runId, claimId);
      }
      for (const runId of seededRunIds) {
        subagentRuns.delete(runId);
      }
    }
  });

  it("keeps an unresolved owner factory bounded and ignores its late active result", async () => {
    const unresolvedObserver = createDeferred<{
      currentState: () => "active" | "waiting" | "none";
      dispose: () => void;
    }>();
    const dispose = vi.fn();
    const cleanup = vi.fn();
    const starts = vi.fn();
    const factory = vi.fn(() => unresolvedObserver.promise);
    const owner = createTypingController({
      onReplyStart: starts,
      onCleanup: cleanup,
      typingIntervalSeconds: 1,
      backgroundWorkObserverFactory: factory,
    });
    owner.setBackgroundWorkPause?.(vi.fn());
    owner.bindRunIdentity?.("unresolved-owner-run", "agent:main:discord:channel:typing");
    await owner.startTypingLoop();
    for (let index = 0; index < 12; index += 1) {
      await Promise.resolve();
    }
    expect(factory).toHaveBeenCalledTimes(1);
    owner.markRunComplete();
    owner.markDispatchIdle();
    const startsAtLoad = starts.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(owner.shouldRetainChannelCallbacks?.()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    unresolvedObserver.resolve({ currentState: () => "active", dispose });
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
    await vi.advanceTimersByTimeAsync(2_000);
    expect(starts).toHaveBeenCalledTimes(startsAtLoad);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("should stop typing when both runComplete and dispatchIdle are true", async () => {
    // Start typing
    await controller.startTypingLoop();
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    // Mark run complete
    controller.markRunComplete();
    expect(onCleanupSpy).not.toHaveBeenCalled();

    // Mark dispatch idle - should trigger cleanup
    controller.markDispatchIdle();
    expect(onCleanupSpy).toHaveBeenCalledTimes(1);

    // After cleanup, typing interval should not restart typing
    vi.advanceTimersByTime(6000);
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1); // Still only the initial call
  });

  it.each(["cleanup", "run-first", "idle-first"] as const)(
    "disposes typing when %s closes the controller before start settles",
    async (completion) => {
      const starting = controller.startTypingLoop();
      if (completion === "cleanup") {
        controller.cleanup();
      } else if (completion === "run-first") {
        controller.markRunComplete();
        controller.markDispatchIdle();
      } else {
        controller.markDispatchIdle();
        controller.markRunComplete();
      }
      await starting;
      await controller.onReplyStart();
      await controller.startTypingLoop();
      await controller.startTypingOnText("late text");
      controller.refreshTypingTtl();
      controller.markRunComplete();
      controller.markDispatchIdle();
      controller.cleanup();

      expect(controller.isActive()).toBe(false);
      expect(onCleanupSpy).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(12_000);
      expect(onReplyStartSpy).toHaveBeenCalledTimes(1);
    },
  );

  it("should prevent typing restart even if cleanup is delayed", async () => {
    // Start typing
    await controller.startTypingLoop();
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    // Mark run complete (but dispatch not idle yet - simulating cleanup delay)
    controller.markRunComplete();

    // Multiple typing intervals should NOT restart typing
    vi.advanceTimersByTime(6000); // First interval
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(6000); // Second interval
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(6000); // Third interval
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    // Eventually dispatch becomes idle and triggers cleanup
    controller.markDispatchIdle();
    expect(onCleanupSpy).toHaveBeenCalledTimes(1);
  });

  it("returns an inert controller when typing callbacks are absent", async () => {
    const inert = createTypingController({});

    await inert.onReplyStart();
    await inert.startTypingLoop();
    await inert.startTypingOnText("hello");
    inert.refreshTypingTtl();
    inert.markRunComplete();
    inert.markDispatchIdle();
    inert.cleanup();

    expect(inert.isActive()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clamps an oversized typing interval and derives a longer TTL", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const boundedController = createTypingController({
      onReplyStart: onReplyStartSpy,
      onCleanup: onCleanupSpy,
      typingIntervalSeconds: Number.MAX_SAFE_INTEGER,
      log: vi.fn(),
    });

    await boundedController.startTypingLoop();

    const maxTypingIntervalMs = Math.floor(MAX_TIMER_TIMEOUT_MS / 2);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), maxTypingIntervalMs);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), maxTypingIntervalMs * 2);
    boundedController.cleanup();
  });
});
