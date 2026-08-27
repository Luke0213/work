import test from "node:test";
import assert from "node:assert/strict";
import { isIPadOSChrome, shouldUseEnvironmentCapture } from "../lib/photo-capture.ts";

const ipadChrome = "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1";
const desktopModeIPadChrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1";
const androidChrome = "Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const ipadSafari = "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1";

test("iPadOS Chrome does not force environment capture", () => {
  assert.equal(isIPadOSChrome(ipadChrome), true);
  assert.equal(isIPadOSChrome(desktopModeIPadChrome), true);
  assert.equal(shouldUseEnvironmentCapture(ipadChrome), false);
});

test("Android Chrome and Safari keep environment capture", () => {
  assert.equal(isIPadOSChrome(androidChrome), false);
  assert.equal(shouldUseEnvironmentCapture(androidChrome), true);
  assert.equal(shouldUseEnvironmentCapture(ipadSafari), true);
});
