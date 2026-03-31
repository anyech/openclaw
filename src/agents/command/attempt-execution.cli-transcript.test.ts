import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { persistCliTurnTranscript } from "./attempt-execution.js";

const chatHistoryMock = vi.fn<(sessionKey: string) => Promise<{ messages?: Array<unknown> }>>(
  async (_sessionKey: string) => ({ messages: [] }),
);

vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn(async (request: unknown) => {
    const typed = request as { method?: string; params?: { sessionKey?: string } };
    if (typed.method === "chat.history") {
      return await chatHistoryMock(typed.params?.sessionKey ?? "");
    }
    return {};
  }),
}));

type TranscriptRecord = {
  type?: string;
  message?: unknown;
};

function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const msg = message as { content?: unknown };
  const content = msg.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") {
        return [] as string[];
      }
      const typed = block as { type?: unknown; text?: unknown };
      if (typed.type === "text" && typeof typed.text === "string") {
        return [typed.text];
      }
      return [] as string[];
    })
    .join("\n")
    .trim();
}

async function readTranscriptMessages(sessionFile: string): Promise<unknown[]> {
  try {
    const raw = await fs.readFile(sessionFile, "utf-8");
    const messages: unknown[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as TranscriptRecord;
        if (parsed.type === "message" && parsed.message) {
          messages.push(parsed.message);
        }
      } catch {
        // Ignore non-message or malformed lines in this narrow regression test.
      }
    }
    return messages;
  } catch {
    return [];
  }
}

describe("persistCliTurnTranscript", () => {
  let tempDir = "";
  let sessionFile = "";
  let captureSubagentCompletionReply: (typeof import("../subagent-announce.js"))["captureSubagentCompletionReply"];

  beforeEach(async () => {
    vi.resetModules();
    ({ captureSubagentCompletionReply } = await import("../subagent-announce.js"));
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-transcript-"));
    sessionFile = path.join(tempDir, "session.jsonl");
    chatHistoryMock.mockReset().mockImplementation(async () => ({
      messages: await readTranscriptMessages(sessionFile),
    }));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("writes CLI assistant output into transcript history so completion capture can read it", async () => {
    const expectedText = "ROUTE_OK\nroute=cli-transcript-test";

    await persistCliTurnTranscript({
      body: "Probe prompt for CLI transcript persistence",
      result: {
        payloads: [{ text: expectedText }],
        meta: {
          durationMs: 12,
          stopReason: "stop",
          agentMeta: {
            sessionId: "cli-session-1",
            provider: "google-gemini-cli",
            model: "gemini-2.5-flash",
            usage: {
              input: 11,
              output: 7,
              cacheRead: 0,
              cacheWrite: 0,
              total: 18,
            },
          },
        },
      },
      sessionId: "validation-session-1",
      sessionKey: undefined,
      sessionFile,
      sessionEntry: undefined,
      sessionAgentId: "main",
      sessionCwd: tempDir,
      provider: "google-gemini-cli",
      model: "gemini-2.5-flash",
    });

    const transcriptMessages = await readTranscriptMessages(sessionFile);
    expect(transcriptMessages).toHaveLength(2);
    expect((transcriptMessages[0] as { role?: unknown }).role).toBe("user");
    expect((transcriptMessages[1] as { role?: unknown }).role).toBe("assistant");
    expect(extractAssistantText(transcriptMessages[1])).toBe(expectedText);

    const captured = await captureSubagentCompletionReply("agent:main:subagent:child");
    expect(captured).toBe(expectedText);
  });
});
