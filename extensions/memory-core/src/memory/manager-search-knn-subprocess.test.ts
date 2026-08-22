import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { loadSqliteVecExtension } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runVectorKnnInSubprocess,
  testing as subprocessTesting,
  type VectorKnnSubprocessExit,
} from "./manager-search-knn-subprocess.js";
import { runVectorKnnQuery, type VectorKnnRequest } from "./manager-search-knn.js";
import { searchVector } from "./manager-search.js";
import { buildMemorySourceFilter } from "./source-filter.js";
import { vectorToBlob } from "./vector-blob.js";

const fixtureChildUrl = new URL("./fixtures/manager-search-knn-child.fixture.mjs", import.meta.url);

function request(limit: number): VectorKnnRequest {
  return {
    vectorTable: "memory_index_chunks_vec",
    providerModels: ["test-model"],
    queryVec: [1, 0],
    limit,
    sourceFilter: { sql: "", params: [] },
  };
}

function insertVectorRow(
  db: DatabaseSync,
  params: { id: string; source: "memory" | "sessions"; vector: [number, number] },
): void {
  db.prepare(
    "INSERT INTO memory_index_chunks (id, path, start_line, end_line, text, source, model) VALUES (?, ?, 1, 1, ?, ?, ?)",
  ).run(
    params.id,
    `${params.source}/${params.id}.md`,
    `text ${params.id}`,
    params.source,
    "test-model",
  );
  db.prepare("INSERT INTO memory_index_chunks_vec (id, embedding) VALUES (?, ?)").run(
    params.id,
    vectorToBlob(params.vector),
  );
}

async function createFileBackedVectorDatabase(): Promise<{
  db: DatabaseSync;
  databasePath: string;
  cleanup: () => void;
}> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-knn-"));
  const databasePath = path.join(directory, "memory.sqlite");
  const db = openNodeSqliteDatabase(databasePath, { allowExtension: true });
  try {
    const loaded = await loadSqliteVecExtension({ db });
    if (!loaded.ok) {
      throw new Error(loaded.error ?? "sqlite-vec unavailable in test");
    }
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE memory_index_chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        model TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[2]
      );
    `);
    return {
      db,
      databasePath,
      cleanup: () => {
        db.close();
        fs.rmSync(directory, { force: true, recursive: true });
      },
    };
  } catch (error) {
    db.close();
    fs.rmSync(directory, { force: true, recursive: true });
    throw error;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("memory vector KNN subprocess boundary", () => {
  it("demonstrates that same-thread synchronous KNN delays a timer", async () => {
    const blockMs = 120;
    const startedAt = performance.now();
    let timerFiredAt = 0;
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        timerFiredAt = performance.now();
        resolve();
      }, 0);
    });
    const fakeDb = {
      prepare: () => ({
        all: () => {
          const deadline = performance.now() + blockMs;
          while (performance.now() < deadline) {}
          return [
            {
              id: "hit",
              path: "memory/hit.md",
              start_line: 1,
              end_line: 1,
              text: "hit",
              source: "memory",
              dist: 0,
            },
          ];
        },
      }),
    } as unknown as Pick<DatabaseSync, "prepare">;

    const result = runVectorKnnQuery(fakeDb, request(1));
    expect(result.rows).toHaveLength(1);
    expect(timerFiredAt).toBe(0);
    await timer;
    expect(timerFiredAt - startedAt).toBeGreaterThanOrEqual(blockMs - 10);
  });

  it("keeps the parent event loop responsive during equivalent synchronous child work", async () => {
    let childFinished = false;
    let timerBeatChild = false;
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        timerBeatChild = !childFinished;
        resolve();
      }, 20);
    });
    const resultPromise = runVectorKnnInSubprocess({
      databasePath: "fixture:ok",
      request: request(250),
      childUrl: fixtureChildUrl,
    }).finally(() => {
      childFinished = true;
    });

    const [result] = await Promise.all([resultPromise, timer]);
    expect(result).toEqual({ rows: [], fallbackScanRequired: false });
    expect(timerBeatChild).toBe(true);
  });

  it("hard-kills and reaps a synchronous child on caller abort", async () => {
    const controller = new AbortController();
    let pid: number | undefined;
    let exit: VectorKnnSubprocessExit | undefined;
    let abortedAt = 0;
    const resultPromise = runVectorKnnInSubprocess({
      databasePath: "fixture:ok",
      request: request(5_000),
      signal: controller.signal,
      childUrl: fixtureChildUrl,
      onSpawn: (spawnedPid) => {
        pid = spawnedPid;
      },
      onExit: (value) => {
        exit = value;
      },
    });
    setTimeout(() => {
      abortedAt = performance.now();
      controller.abort(new Error("test KNN deadline"));
    }, 250);

    await expect(resultPromise).rejects.toThrow("test KNN deadline");
    expect(performance.now() - abortedAt).toBeLessThan(1_000);
    expect(pid).toBeTypeOf("number");
    expect(exit).toMatchObject({ pid, code: null, signal: "SIGKILL", pidAlive: false });
    expect(subprocessTesting.isProcessAlive(pid)).toBe(false);
  });

  it("keeps cleanup ownership and bounds admission after terminal cleanup timeout", async () => {
    const admission = subprocessTesting.createVectorKnnAdmission(1);
    const controller = new AbortController();
    let firstExited = false;
    const first = subprocessTesting.runVectorKnnWithAdmission(
      {
        databasePath: "fixture:ok",
        request: request(250),
        signal: controller.signal,
        childUrl: fixtureChildUrl,
        onExit: () => {
          firstExited = true;
        },
      },
      admission,
      0,
      () => {},
    );
    setTimeout(() => controller.abort(new Error("terminal cleanup test")), 10);

    await expect(first).rejects.toMatchObject({ code: "termination-timeout" });
    expect(firstExited).toBe(false);
    expect(admission.active()).toBe(1);

    const queuedController = new AbortController();
    let queuedSpawned = false;
    const queued = subprocessTesting.runVectorKnnWithAdmission(
      {
        databasePath: "fixture:ok",
        request: request(1),
        signal: queuedController.signal,
        childUrl: fixtureChildUrl,
        onSpawn: () => {
          queuedSpawned = true;
        },
      },
      admission,
      0,
    );
    expect(admission.queued()).toBe(1);
    queuedController.abort(new Error("queued KNN deadline"));
    await expect(queued).rejects.toThrow("queued KNN deadline");
    expect(queuedSpawned).toBe(false);

    await vi.waitFor(() => {
      expect(firstExited).toBe(true);
      expect(admission.active()).toBe(0);
      expect(admission.queued()).toBe(0);
    });
  });

  it("queries the real source child across WAL writer visibility and source filters", async () => {
    const fixture = await createFileBackedVectorDatabase();
    try {
      insertVectorRow(fixture.db, { id: "committed", source: "memory", vector: [1, 0] });
      fixture.db.exec("BEGIN IMMEDIATE");
      insertVectorRow(fixture.db, { id: "pending", source: "sessions", vector: [0.9, 0.1] });

      const memoryResult = await runVectorKnnInSubprocess({
        databasePath: fixture.databasePath,
        request: {
          ...request(2),
          sourceFilter: buildMemorySourceFilter("c", ["memory"]),
        },
      });
      expect(memoryResult.rows.map((row) => row.id)).toEqual(["committed"]);

      const beforeCommit = await runVectorKnnInSubprocess({
        databasePath: fixture.databasePath,
        request: {
          ...request(2),
          sourceFilter: buildMemorySourceFilter("c", ["sessions"]),
        },
      });
      expect(beforeCommit.rows).toEqual([]);

      fixture.db.exec("COMMIT");
      const afterCommit = await runVectorKnnInSubprocess({
        databasePath: fixture.databasePath,
        request: {
          ...request(2),
          sourceFilter: buildMemorySourceFilter("c", ["sessions"]),
        },
      });
      expect(afterCommit.rows.map((row) => row.id)).toEqual(["pending"]);
      expect(fixture.db.prepare("PRAGMA journal_mode").get()).toMatchObject({
        journal_mode: "wal",
      });
    } finally {
      try {
        fixture.db.exec("ROLLBACK");
      } catch {}
      fixture.cleanup();
    }
  });

  it("fails closed on malformed output, oversized output, and early exit", async () => {
    await expect(
      runVectorKnnInSubprocess({
        databasePath: "fixture:malformed",
        request: request(1),
        childUrl: fixtureChildUrl,
      }),
    ).rejects.toThrow("malformed JSON");
    await expect(
      runVectorKnnInSubprocess({
        databasePath: "fixture:oversized",
        request: request(1),
        childUrl: fixtureChildUrl,
      }),
    ).rejects.toThrow("stdout exceeded its limit");
    await expect(
      runVectorKnnInSubprocess({
        databasePath: "fixture:early-exit",
        request: request(1),
        childUrl: fixtureChildUrl,
      }),
    ).rejects.toThrow("exited before returning a result");
  });

  it("fails vector recall closed when the subprocess is unavailable", async () => {
    const prepare = vi.fn(() => {
      throw new Error("same-thread SQLite must not run");
    });
    await expect(
      searchVector({
        db: { prepare } as unknown as DatabaseSync,
        vectorTable: "memory_index_chunks_vec",
        providerModel: "test-model",
        queryVec: [1, 0],
        limit: 1,
        snippetMaxChars: 200,
        ensureVectorReady: async () => true,
        runVectorKnn: async () => {
          throw new Error("subprocess unavailable");
        },
        sourceFilterVec: { sql: "", params: [] },
        sourceFilterChunks: { sql: "", params: [] },
      }),
    ).rejects.toThrow("subprocess unavailable");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("resolves source and hashed-dist child artifacts exactly", () => {
    expect(
      subprocessTesting.resolveVectorKnnChildUrl(
        "file:///repo/extensions/memory-core/src/memory/manager-search-knn-subprocess.ts",
      ).pathname,
    ).toBe("/repo/extensions/memory-core/src/memory/manager-search-knn.child.ts");
    expect(
      subprocessTesting.resolveVectorKnnChildUrl("file:///pkg/dist/manager-hashed.js").pathname,
    ).toBe("/pkg/dist/extensions/memory-core/memory-search-knn.child.js");
  });
});
