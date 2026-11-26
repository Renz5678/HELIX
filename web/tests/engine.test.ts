import { describe, it, expect, vi, afterEach } from "vitest";
import glucoseData from "../../examples/data/glucose.json";
import type { Dataset, Evaluation } from "../src/services/types";
import { EngineClient } from "../src/services/engine";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("EngineClient validate requests", () => {
  it("posts kind 'validate' with source and dataset and resolves with Evaluation", async () => {
    const posted: unknown[] = [];
    const listeners = new Map<string, Array<(e: { data: unknown }) => void>>();

    class MockWorker {
      addEventListener(type: string, cb: (e: { data: unknown }) => void) {
        const list = listeners.get(type) ?? [];
        list.push(cb);
        listeners.set(type, list);
      }
      postMessage(msg: { id: number; kind: string }) {
        posted.push(msg);
        const evalResult: Evaluation = {
          schemaVersion: 1,
          success: true,
          analysisSuccess: true,
          evaluationTime: "2026-10-31T12:00:00Z",
          results: [],
          diagnostics: [],
        };
        for (const cb of listeners.get("message") ?? []) {
          cb({ data: { id: msg.id, result: evalResult } });
        }
      }
      terminate() {}
    }

    vi.stubGlobal("Worker", MockWorker);
    const client = new EngineClient();
    for (const cb of listeners.get("message") ?? []) {
      cb({ data: { kind: "ready" } });
    }
    await client.ready;

    const ds = structuredClone(glucoseData) as Dataset;
    const result = await client.request("validate", "rule R:\n    source glucose_data\nend rule", ds);
    expect(result.success).toBe(true);
    expect(posted).toEqual([
      {
        id: 1,
        kind: "validate",
        source: "rule R:\n    source glucose_data\nend rule",
        dataset: ds,
      },
    ]);
    client.dispose();
  });
});

describe("engine.worker validate superseding", () => {
  it("supersedes older queued 'validate' requests without canceling 'analyze' or 'evaluate'", async () => {
    const messages: Array<Record<string, unknown>> = [];
    const fakeSelf: {
      location: { origin: string };
      postMessage: (msg: Record<string, unknown>) => void;
      onmessage: ((e: { data: unknown }) => void) | null;
    } = {
      location: { origin: "http://127.0.0.1" },
      postMessage: (msg) => {
        messages.push(msg);
      },
      onmessage: null,
    };

    vi.stubGlobal("self", fakeSelf);
    await import("../src/services/engine.worker");
    expect(fakeSelf.onmessage).toBeTypeOf("function");

    const ds = structuredClone(glucoseData) as Dataset;
    fakeSelf.onmessage!({ data: { id: 1, kind: "validate", source: "s1", dataset: ds } });
    fakeSelf.onmessage!({ data: { id: 2, kind: "analyze", source: "s1" } });
    fakeSelf.onmessage!({ data: { id: 3, kind: "evaluate", source: "s1", dataset: ds } });
    fakeSelf.onmessage!({ data: { id: 4, kind: "validate", source: "s2", dataset: ds } });

    expect(messages).toContainEqual({ id: 1, error: "Superseded validation" });
    expect(messages.some((m) => m.id === 2 && String(m.error).includes("Superseded"))).toBe(false);
    expect(messages.some((m) => m.id === 3 && String(m.error).includes("Superseded"))).toBe(false);
    expect(messages.some((m) => m.id === 4 && String(m.error).includes("Superseded"))).toBe(false);

    // Allow scheduled flush to settle cleanly before test finishes
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("executes 'validate' requests via _helix_evaluate and frees allocations", async () => {
    vi.stubGlobal("self", {
      location: { origin: "http://127.0.0.1" },
      postMessage: vi.fn(),
      onmessage: null,
    });
    const { executeWorkerRequest } = await import("../src/services/engine.worker");
    const evalJson = JSON.stringify({
      schemaVersion: 1,
      success: true,
      analysisSuccess: true,
      evaluationTime: "2026-10-31T12:00:00Z",
      results: [],
      diagnostics: [],
    });
    const fakeModule = {
      _malloc: vi.fn((n: number) => n),
      _free: vi.fn(),
      _helix_analyze: vi.fn(() => 0),
      _helix_evaluate: vi.fn(() => 999),
      _helix_free_result: vi.fn(),
      lengthBytesUTF8: (s: string) => new TextEncoder().encode(s).length,
      stringToUTF8: vi.fn(),
      UTF8ToString: vi.fn(() => evalJson),
    };
    const ds = structuredClone(glucoseData) as Dataset;
    const out = executeWorkerRequest(fakeModule, {
      id: 10,
      kind: "validate",
      source: "rule R:\n    source glucose_data\nend rule",
      dataset: ds,
    });

    expect(fakeModule._helix_evaluate).toHaveBeenCalledTimes(1);
    expect(fakeModule._helix_analyze).not.toHaveBeenCalled();
    expect(fakeModule._helix_free_result).toHaveBeenCalledWith(999);
    expect(fakeModule._free).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({ schemaVersion: 1, success: true });
  });
});
