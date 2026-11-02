import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getHostRuntimeInfo } from 'pi-agent-runner';
import spiralExtension from '../extensions/spiral.ts';

// Minimal ExtensionAPI: every registration method is a no-op.
const fakeApi = () => {
  const noop = () => {};
  const target = { events: { on: () => noop, emit: noop } };
  return new Proxy(target, {
    get: (t, key) => (key in t ? Reflect.get(t, key) : noop),
  });
};

test('extension entry binds the host runtime', () => {
  assert.equal(getHostRuntimeInfo().bound, false);
  spiralExtension(fakeApi() as never);
  assert.equal(getHostRuntimeInfo().bound, true);
  // Loading again (e.g. /reload) rebinds idempotently.
  spiralExtension(fakeApi() as never);
  assert.equal(getHostRuntimeInfo().bound, true);
});
