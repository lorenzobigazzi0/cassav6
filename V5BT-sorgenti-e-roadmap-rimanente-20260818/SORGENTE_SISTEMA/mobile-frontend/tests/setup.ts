import "@testing-library/jest-dom/vitest";

const createMemoryStorage = (): Storage => {
  const entries = new Map<string, string>();

  return {
    get length() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
    getItem(key: string) {
      return entries.get(String(key)) ?? null;
    },
    key(index: number) {
      return Array.from(entries.keys())[index] ?? null;
    },
    removeItem(key: string) {
      entries.delete(String(key));
    },
    setItem(key: string, value: string) {
      entries.set(String(key), String(value));
    },
  };
};

const ensureWindowStorage = (name: "localStorage" | "sessionStorage") => {
  if (typeof window === "undefined") return;
  const descriptor = Object.getOwnPropertyDescriptor(window, name);
  if (descriptor && "value" in descriptor && descriptor.value) return;
  Object.defineProperty(window, name, {
    configurable: true,
    value: createMemoryStorage(),
  });
};

ensureWindowStorage("localStorage");
ensureWindowStorage("sessionStorage");
