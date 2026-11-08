/**
 * The few Cloudflare Workers runtime types the gateway uses, so it typechecks with the rest
 * of cns (whose types are Bun's) without @cloudflare/workers-types, as relay/worker.ts does.
 */
declare module "cloudflare:workers" {
  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
    fetch?(request: Request): Response | Promise<Response>;
  }
}

interface SqlCursor<T> extends Iterable<T> {
  toArray(): T[];
  one(): T;
}

interface DurableObjectState {
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    sql: { exec<T = Record<string, string | number | null>>(query: string, ...bindings: unknown[]): SqlCursor<T> };
  };
}

interface DurableObjectNamespace<T = unknown> {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub<T>;
}

/** A stub calls the object's public methods over RPC; each returns a promise. */
type DurableObjectStub<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never
} & { fetch(request: Request): Promise<Response> };

interface KVNamespace { get(key: string): Promise<string | null> }

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  props?: unknown;
}
