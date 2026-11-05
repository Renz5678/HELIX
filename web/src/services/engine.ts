import type { Analysis, Dataset, Evaluation } from "./types";
export class EngineClient {
  private worker: Worker;
  private next = 0;
  private fault:Error|null=null;
  private rejectReady:((e:Error)=>void)|null=null;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  readonly ready: Promise<void>;
  constructor() {
    this.worker = new Worker(new URL("./engine.worker.ts", import.meta.url), {
      type: "module",
    });
    this.ready = new Promise((resolve, reject) => {
      this.rejectReady=reject;
      this.worker.addEventListener("message", (e) => {
        if (e.data.kind === "ready") resolve();
        if (e.data.kind === "load-error") {this.fault=Error(e.data.error);reject(this.fault);}
      });
      this.worker.addEventListener("error", (e) => {
        this.fault=Error(e.message);
        reject(Error(e.message));
        for (const p of this.pending.values()) p.reject(Error(e.message));
        this.pending.clear();
      });
    });
    this.worker.addEventListener("message", (e) => {
      const { id, result, error } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (error) p.reject(Error(error));
      else p.resolve(result);
    });
  }
  async request(kind: "analyze", source: string): Promise<Analysis>;
  async request(
    kind: "evaluate",
    source: string,
    dataset: Dataset,
  ): Promise<Evaluation>;
  async request(
    kind: "analyze" | "evaluate",
    source: string,
    dataset?: Dataset,
  ): Promise<unknown> {
    await this.ready;
    if(this.fault)throw this.fault;
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, kind, source, dataset });
    });
  }
  dispose() {
    this.fault=Error("Engine disposed");this.rejectReady?.(this.fault);
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(Error("Engine disposed"));
    this.pending.clear();
  }
}
