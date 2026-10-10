import type { MemoryTranscriptProjectionFrame } from "../config/sessions/session-transcript-reconcile-memory.js";
import {
  transcriptEventJsonMayOverlapRange,
  type SessionTranscriptEventTimeRange,
} from "../config/sessions/transcript-event-time.js";

/**
 * Inspect one canonical memory source at a time. The source owner validates its snapshot before
 * returning source-end; fragments are retained only until that event's final frame.
 */
export async function memoryTranscriptFramesMayOverlapRange(
  read: () => MemoryTranscriptProjectionFrame | Promise<MemoryTranscriptProjectionFrame>,
  range: SessionTranscriptEventTimeRange,
  signal?: AbortSignal,
): Promise<boolean> {
  let eventFragments: Uint8Array[] = [];
  for (;;) {
    signal?.throwIfAborted();
    const frame = await read();
    signal?.throwIfAborted();
    if (frame.type === "source-unavailable") {
      throw new Error("Memory transcript source became unavailable during event-time preflight");
    }
    if (frame.type === "source-end") {
      if (eventFragments.length > 0) {
        throw new Error("Memory transcript source ended before an event frame was complete");
      }
      return false;
    }
    eventFragments.push(frame.bytes);
    if (frame.final) {
      const eventJson = Buffer.concat(eventFragments).toString("utf8");
      eventFragments = [];
      if (transcriptEventJsonMayOverlapRange(eventJson, range)) {
        return true;
      }
    }
  }
}
