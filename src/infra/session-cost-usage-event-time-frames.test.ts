import { expect, it } from "vitest";
import type { MemoryTranscriptProjectionFrame } from "../config/sessions/session-transcript-reconcile-memory.js";
import { memoryTranscriptFramesMayOverlapRange } from "./session-cost-usage-event-time-frames.js";

function sourceFrame(
  bytes: Uint8Array,
  seq: number,
  final: boolean,
): MemoryTranscriptProjectionFrame {
  return { type: "source-frame", seq, createdAt: seq, bytes: Uint8Array.from(bytes), final };
}

function sourceEnd(): MemoryTranscriptProjectionFrame {
  return {
    type: "source-end",
    snapshot: {
      sessionId: "session",
      transcriptUpdatedAt: 1,
      maxSeq: 2,
      generation: "generation",
    },
  };
}

function reader(frames: MemoryTranscriptProjectionFrame[]) {
  let index = 0;
  return async () => {
    const frame = frames[index++];
    if (!frame) {
      throw new Error("test source exhausted before validated end");
    }
    return frame;
  };
}

function encodedEvent(event: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(event));
}

it("joins UTF-8 frames per event and continues across event boundaries", async () => {
  const outside = encodedEvent({ message: { timestamp: 900, content: "before" } });
  const included = encodedEvent({ message: { timestamp: 1_500, content: "snow 🪿 end" } });
  const emojiStart = Buffer.from(included).indexOf(Buffer.from("🪿"));
  expect(emojiStart).toBeGreaterThan(0);
  const frames: MemoryTranscriptProjectionFrame[] = [
    sourceFrame(outside, 1, true),
    sourceFrame(Uint8Array.from(included.subarray(0, emojiStart + 2)), 2, false),
    sourceFrame(Uint8Array.from(included.subarray(emojiStart + 2)), 2, true),
    sourceEnd(),
  ];
  await expect(
    memoryTranscriptFramesMayOverlapRange(reader(frames), { startMs: 1_000, endMs: 2_000 }),
  ).resolves.toBe(true);
});

it("uses an imported message clock instead of an in-range envelope clock", async () => {
  const event = encodedEvent({
    timestamp: "1970-01-01T00:00:01.500Z",
    message: { timestamp: 2_500, content: "imported message" },
  });
  await expect(
    memoryTranscriptFramesMayOverlapRange(reader([sourceFrame(event, 1, true), sourceEnd()]), {
      startMs: 1_000,
      endMs: 2_000,
    }),
  ).resolves.toBe(false);
});

it("conservatively includes malformed and untimestamped message events", async () => {
  const malformed = new TextEncoder().encode("not-json");
  const untimestamped = encodedEvent({ message: { role: "assistant", content: "unknown time" } });
  await expect(
    memoryTranscriptFramesMayOverlapRange(reader([sourceFrame(malformed, 1, true), sourceEnd()]), {
      startMs: 1_000,
      endMs: 2_000,
    }),
  ).resolves.toBe(true);
  await expect(
    memoryTranscriptFramesMayOverlapRange(
      reader([sourceFrame(untimestamped, 1, true), sourceEnd()]),
      { startMs: 1_000, endMs: 2_000 },
    ),
  ).resolves.toBe(true);
});

it("rejects an incomplete event at source-end", async () => {
  await expect(
    memoryTranscriptFramesMayOverlapRange(
      reader([sourceFrame(new TextEncoder().encode('{"message":'), 1, false), sourceEnd()]),
      { startMs: 1_000, endMs: 2_000 },
    ),
  ).rejects.toThrow("ended before an event frame was complete");
});

it("rejects unavailable sources and aborted reads instead of excluding them", async () => {
  await expect(
    memoryTranscriptFramesMayOverlapRange(reader([{ type: "source-unavailable" }]), {
      startMs: 1_000,
      endMs: 2_000,
    }),
  ).rejects.toThrow("source became unavailable");
  const controller = new AbortController();
  const cancellation = new Error("event-time read cancelled");
  controller.abort(cancellation);
  await expect(
    memoryTranscriptFramesMayOverlapRange(
      reader([]),
      { startMs: 1_000, endMs: 2_000 },
      controller.signal,
    ),
  ).rejects.toBe(cancellation);
});
