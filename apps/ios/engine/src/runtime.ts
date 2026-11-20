/**
 * Globals the shared TypeScript expects from a browser, rebuilt on top of the
 * functions the Swift host installs on `__postoNative` before this bundle
 * loads. JavaScriptCore ships the language but none of the web platform:
 * no timers, console, URL, or structuredClone. Each polyfill installs only
 * when the global is missing, so the same bundle runs under Node in tests.
 */

export interface NativeHost {
  /** Starts a Rust (or demo) command; the result arrives through
   * `PostoEngine.resolveInvoke(requestId, responseJSON)`. */
  invoke(requestId: number, command: string, argsJSON: string): void;
  /** Pushes an engine event to Swift. */
  emit(name: string, payloadJSON: string): void;
  /** Finishes a Swift → engine call started with `PostoEngine.call`. */
  reply(callId: number, responseJSON: string): void;
  log(level: string, message: string): void;
  setTimer(id: number, delayMs: number, repeats: boolean): void;
  clearTimer(id: number): void;
  /** Foundation URL parsing: JSON of the parts, or null when invalid. */
  parseURL(input: string, base: string | null): string | null;
}

declare global {
  // oxlint-disable-next-line no-var -- installed by the Swift host
  var __postoNative: NativeHost | undefined;
}

type TimerCallback = (...args: unknown[]) => void;

const timers = new Map<number, { callback: TimerCallback; args: unknown[]; repeats: boolean }>();
let nextTimerId = 1;

/** Called by the host when a timer fires. */
export function fireTimer(id: number): void {
  const timer = timers.get(id);
  if (!timer) return;
  if (!timer.repeats) timers.delete(id);
  try {
    timer.callback(...timer.args);
  } catch (error) {
    console.error("Timer callback failed", error);
  }
}

function format(value: unknown): string {
  if (value instanceof Error) return `${value.message}\n${value.stack ?? ""}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function structuredCloneValue<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map(structuredCloneValue) as T;
  if (value instanceof Map) {
    return new Map(
      [...value].map(([k, v]) => [structuredCloneValue(k), structuredCloneValue(v)]),
    ) as T;
  }
  if (value instanceof Set) return new Set([...value].map(structuredCloneValue)) as T;
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) copy[key] = structuredCloneValue(entry);
  return copy as T;
}

interface ParsedUrlParts {
  href: string;
  protocol: string;
  username: string;
  password: string;
  host: string;
  hostname: string;
  port: string;
  pathname: string;
  search: string;
  hash: string;
  origin: string;
}

/** Read-only URL backed by Foundation's parser; enough for validation and
 * normalization, which is all the shared code does with URLs. */
class NativeURL {
  readonly href: string;
  readonly protocol: string;
  readonly username: string;
  readonly password: string;
  readonly host: string;
  readonly hostname: string;
  readonly port: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  readonly origin: string;

  constructor(input: string, base?: string) {
    const parsed = globalThis.__postoNative?.parseURL(String(input), base ?? null);
    if (!parsed) throw new TypeError(`Invalid URL: ${input}`);
    const parts = JSON.parse(parsed) as ParsedUrlParts;
    this.href = parts.href;
    this.protocol = parts.protocol;
    this.username = parts.username;
    this.password = parts.password;
    this.host = parts.host;
    this.hostname = parts.hostname;
    this.port = parts.port;
    this.pathname = parts.pathname;
    this.search = parts.search;
    this.hash = parts.hash;
    this.origin = parts.origin;
  }

  get searchParams(): URLSearchParams {
    return new URLSearchParams(this.search);
  }

  toString(): string {
    return this.href;
  }

  toJSON(): string {
    return this.href;
  }
}

class SimpleURLSearchParams {
  private readonly entries: Array<[string, string]> = [];

  constructor(init?: string) {
    const query = (init ?? "").replace(/^\?/, "");
    for (const part of query.split("&")) {
      if (!part) continue;
      const [key, value = ""] = part.split("=");
      this.entries.push([decodeURIComponent(key), decodeURIComponent(value)]);
    }
  }

  has(name: string): boolean {
    return this.entries.some(([key]) => key === name);
  }

  get(name: string): string | null {
    return this.entries.find(([key]) => key === name)?.[1] ?? null;
  }
}

/** In-memory Storage: the demo backend keeps its remembered selections here. */
class MemoryStorage {
  private readonly items = new Map<string, string>();

  get length(): number {
    return this.items.size;
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  clear(): void {
    this.items.clear();
  }
}

export function installRuntime(): void {
  const host = globalThis.__postoNative;
  const scope = globalThis as unknown as Record<string, unknown>;

  if (typeof scope.window === "undefined") scope.window = globalThis;
  if (typeof scope.location === "undefined")
    scope.location = { search: "", href: "posto://engine" };
  if (typeof scope.document === "undefined") {
    scope.document = {
      visibilityState: "visible",
      addEventListener() {},
      removeEventListener() {},
    };
  }

  if (typeof scope.console === "undefined" && host) {
    const log =
      (level: string) =>
      (...values: unknown[]) =>
        host.log(level, values.map(format).join(" "));
    scope.console = {
      log: log("info"),
      info: log("info"),
      debug: log("debug"),
      warn: log("warn"),
      error: log("error"),
    };
  }

  if (typeof scope.setTimeout === "undefined" && host) {
    const schedule =
      (repeats: boolean) =>
      (callback: TimerCallback, delay = 0, ...args: unknown[]) => {
        const id = nextTimerId++;
        timers.set(id, { callback, args, repeats });
        host.setTimer(id, Math.max(0, Number(delay) || 0), repeats);
        return id;
      };
    const clear = (id: unknown) => {
      if (typeof id !== "number" || !timers.delete(id)) return;
      host.clearTimer(id);
    };
    scope.setTimeout = schedule(false);
    scope.setInterval = schedule(true);
    scope.clearTimeout = clear;
    scope.clearInterval = clear;
  }

  if (typeof scope.queueMicrotask === "undefined") {
    scope.queueMicrotask = (callback: () => void) => void Promise.resolve().then(callback);
  }
  if (typeof scope.structuredClone === "undefined") scope.structuredClone = structuredCloneValue;
  if (typeof scope.URL === "undefined") scope.URL = NativeURL;
  if (typeof scope.URLSearchParams === "undefined") scope.URLSearchParams = SimpleURLSearchParams;
  if (typeof scope.localStorage === "undefined") scope.localStorage = new MemoryStorage();
}
