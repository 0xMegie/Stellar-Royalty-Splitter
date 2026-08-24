import "@testing-library/jest-dom/vitest";

// jsdom does not implement ResizeObserver, which recharts' ResponsiveContainer
// relies on to size the chart. Stub it so component tests can render charts
// without a real layout engine.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

// jsdom's localStorage can be partial or unavailable depending on the
// environment origin; provide a functional in-memory implementation so
// components and tests that persist state (e.g. collaborator names) work.
class LocalStorageStub {
  private store = new Map<string, string>();
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }
  get length() {
    return this.store.size;
  }
}

if (
  typeof globalThis.localStorage === "undefined" ||
  typeof globalThis.localStorage.clear !== "function"
) {
  const stub = new LocalStorageStub();
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, "localStorage", {
    value: stub,
    writable: true,
    configurable: true,
  });
}
