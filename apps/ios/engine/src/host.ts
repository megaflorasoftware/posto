/**
 * The engine's two outward edges: commands to the backend (the Rust bridge,
 * or the in-memory demo backend) and events to Swift.
 */

export interface Transport {
  invoke(command: string, args: Record<string, unknown> | undefined): Promise<unknown>;
}

type Listener = (payload: unknown) => void;

let transport: Transport | null = null;
const backendListeners = new Map<string, Set<Listener>>();
let notifier: (name: string, payload: unknown) => void = () => {};

export function setTransport(next: Transport): void {
  transport = next;
}

export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!transport) return Promise.reject(new Error("The Posto engine has no backend"));
  return transport.invoke(command, args) as Promise<T>;
}

/** Subscribes to a backend event (`clone-progress`, `fs-changed`, …). */
export function onBackendEvent<T>(name: string, listener: (payload: T) => void): () => void {
  let listeners = backendListeners.get(name);
  if (!listeners) backendListeners.set(name, (listeners = new Set()));
  listeners.add(listener as Listener);
  return () => listeners.delete(listener as Listener);
}

export function dispatchBackendEvent(name: string, payload: unknown): void {
  for (const listener of backendListeners.get(name) ?? []) {
    try {
      listener(payload);
    } catch (error) {
      console.error(`Backend event ${name} failed`, error);
    }
  }
}

export function setNotifier(next: (name: string, payload: unknown) => void): void {
  notifier = next;
}

/** Tells Swift that some engine state changed. */
export function notify(name: string, payload: unknown): void {
  notifier(name, payload);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
