/// <reference lib="webworker" />
export {};
interface Module {
  _malloc(n: number): number;
  _free(p: number): void;
  _helix_analyze(p: number): number;
  _helix_evaluate(p: number, q: number): number;
  _helix_free_result(p: number): void;
  lengthBytesUTF8(s: string): number;
  stringToUTF8(s: string, p: number, n: number): void;
  UTF8ToString(p: number): string;
}
const scope = self as unknown as DedicatedWorkerGlobalScope;
const url = new URL(
  `${import.meta.env.BASE_URL}wasm/helix_engine.mjs`,
  scope.location.origin,
).href;
const engine: Promise<Module|null> = import(/* @vite-ignore */ url)
  .then((m) => m.default())
  .then((module) => {
    scope.postMessage({ kind: "ready" });
    return module;
  })
  .catch((e) => {
    scope.postMessage({ kind: "load-error", error: String(e) });
    return null;
  });
interface Request {
  id: number;
  kind: "analyze" | "evaluate";
  source: string;
  dataset?: unknown;
}
let pending: Request[] = [];
let scheduled = false;
scope.onmessage = (e) => {
  const request = e.data as Request;
  if (request.kind === "analyze") {
    for (const old of pending.filter((x) => x.kind === "analyze"))
      scope.postMessage({ id: old.id, error: "Superseded analysis" });
    pending = pending.filter((x) => x.kind !== "analyze");
  }
  pending.push(request);
  if (!scheduled) {
    scheduled = true;
    setTimeout(flush, 0);
  }
};
async function flush() {
  try {
    const m = await engine;
    if(!m)throw Error("Engine failed to initialize");
    while (pending.length) {
      const r = pending.shift()!;
      let a = 0,
        b = 0,
        result = 0;
      try {
        if (r.source.includes("\0"))
          throw Error("Source contains an embedded NUL");
        const n = m.lengthBytesUTF8(r.source) + 1;
        a = m._malloc(n);
        if (!a) throw Error("Source allocation failed");
        m.stringToUTF8(r.source, a, n);
        if (r.kind === "evaluate") {
          const text = JSON.stringify(r.dataset);
          const size = m.lengthBytesUTF8(text) + 1;
          b = m._malloc(size);
          if (!b) throw Error("Table allocation failed");
          m.stringToUTF8(text, b, size);
          result = m._helix_evaluate(a, b);
        } else result = m._helix_analyze(a);
        if (!result) throw Error("C engine could not allocate a response");
        const parsed = JSON.parse(m.UTF8ToString(result));
        if (
          parsed.schemaVersion !== 1 ||
          typeof parsed.success !== "boolean" ||
          !Array.isArray(parsed.diagnostics)
        )
          throw Error("Invalid engine protocol response");
        scope.postMessage({ id: r.id, result: parsed });
      } catch (e) {
        scope.postMessage({ id: r.id, error: String(e) });
      } finally {
        if (result) m._helix_free_result(result);
        if (b) m._free(b);
        if (a) m._free(a);
      }
    }
  } catch (e) {
    for (const r of pending) scope.postMessage({ id: r.id, error: String(e) });
    pending = [];
  } finally {
    scheduled = false;
  }
}
