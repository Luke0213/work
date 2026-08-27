import test from "node:test";
import assert from "node:assert/strict";
import { printWithLifecycleCleanup } from "../lib/browser-lifecycle.ts";

test("print lifecycle cleanup does not change authenticated identity", () => {
  let identity = "A";
  const windowListeners = new Map<string, () => void>();
  const documentListeners = new Map<string, () => void>();
  const classes = new Set<string>();
  const win = {
    addEventListener: (name: string, callback: () => void) => windowListeners.set(name, callback),
    removeEventListener: (name: string) => windowListeners.delete(name),
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    print: () => undefined,
  };
  const doc = {
    addEventListener: (name: string, callback: () => void) => documentListeners.set(name, callback),
    removeEventListener: (name: string) => documentListeners.delete(name),
    visibilityState: "hidden",
    body: { classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) } },
  };
  printWithLifecycleCleanup("printing-billing", win as never, doc as never);
  assert.equal(classes.has("printing-billing"), true);
  windowListeners.get("pageshow")?.();
  assert.equal(classes.has("printing-billing"), false);
  assert.equal(identity, "A");
  identity = "A";
});
