import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  diffBaseline,
  fingerprint,
  mentionsFile,
  MAX_SIGNATURES_PER_COMMAND,
  signatureLines,
  type FeedbackBaseline,
} from '../src/ralph/baseline.ts';
import type { CommandResult } from '../src/ralph/verify.ts';

const result = (extra: Partial<CommandResult>): CommandResult => ({
  command: 'npm test',
  ok: false,
  exitCode: 1,
  output: '',
  ...extra,
});

test('signatureLines strips ANSI and normalizes volatile fragments', () => {
  const out = [
    '\x1b[31mFAIL\x1b[0m suite took 12.5ms',
    'FAIL suite took 3ms',
    'error at 2026-01-02T03:04:05.123Z in /tmp/abc-123/x',
    'error at 2027-02-03 04:05:06 in /tmp/zzz',
    'id deadbeef1234 failed',
  ].join('\n');
  assert.deepEqual(
    signatureLines(out),
    [
      'FAIL suite took <v>',
      'error at <v> in <v>/x',
      'error at <v> in <v>',
      'id <v> failed',
    ].sort(),
  );
});

test('signatureLines drops progress, summary and passing TAP lines', () => {
  const out = [
    'TAP version 13',
    'Running tests...',
    '✓ passes',
    '1..3',
    'ok 1 - fine',
    'not ok 2 - broken',
    '# tests 3',
    '# pass 2',
    '# fail 1',
    '# fail 0',
    '# 12ms',
    'Running the suite failed with error',
  ].join('\n');
  assert.deepEqual(signatureLines(out), [
    '# fail 1',
    'Running the suite failed with error',
    'not ok 2 - broken',
  ]);
});

test('signatureLines sorts, dedupes and caps', () => {
  assert.deepEqual(signatureLines('b\na\nb\n\n  a  '), ['a', 'b']);
  const many = Array.from({ length: 500 }, (_, i) => `line ${i}x`).join('\n');
  assert.equal(signatureLines(many).length, MAX_SIGNATURES_PER_COMMAND);
});

test('fingerprint: a passing command has no signatures', () => {
  assert.deepEqual(
    fingerprint(result({ ok: true, exitCode: 0, output: 'new chatter' })),
    { signatures: [] },
  );
});

test('fingerprint: unrunnable commands', () => {
  const missing = fingerprint(
    result({ exitCode: 127, output: 'sh: 1: foo: command not found' }),
  );
  assert.deepEqual(missing, { signatures: [], unrunnable: true });
  const spawn = fingerprint(
    result({ exitCode: null, output: '[spawn ENOENT]' }),
  );
  assert.equal(spawn.unrunnable, true);
});

test('fingerprint: failures are never invisible', () => {
  assert.deepEqual(fingerprint(result({ exitCode: 3, output: '# pass 3' })), {
    signatures: ['<exit 3>'],
  });
  assert.deepEqual(
    fingerprint(
      result({
        exitCode: null,
        output: 'x\n[killed: timeout 5ms or cancelled]',
      }),
    ),
    { signatures: ['<timeout>'] },
  );
  assert.deepEqual(fingerprint(result({ output: 'FAIL a\nFAIL a' })), {
    signatures: ['FAIL a'],
  });
});

test('mentionsFile: path, basename segment, no partial names', () => {
  assert.ok(mentionsFile('FAIL src/index.ts: boom', 'src/index.ts'));
  assert.ok(mentionsFile('FAIL src/index.ts: boom', './src/index.ts'));
  assert.ok(mentionsFile('error in lib/index.ts:3', 'src/index.ts'));
  assert.ok(mentionsFile("cannot read 'index.ts'", 'src/index.ts'));
  assert.ok(mentionsFile('at (index.ts)', 'src/index.ts'));
  assert.ok(!mentionsFile('FAIL xindex.ts: boom', 'src/index.ts'));
  assert.ok(!mentionsFile('FAIL index.tsx: boom', 'src/index.ts'));
  assert.ok(!mentionsFile('anything', ''));
});

test('diffBaseline: every branch', () => {
  const baseline: FeedbackBaseline = {
    a: { signatures: ['old', 'gone'] },
    b: { signatures: [], unrunnable: true },
    c: { signatures: [] },
    d: { signatures: ['FAIL src/x.ts'] },
  };
  const current: FeedbackBaseline = {
    a: { signatures: ['old', 'fresh'] },
    b: { signatures: [], unrunnable: true },
    c: { signatures: [], unrunnable: true },
    d: { signatures: ['FAIL src/x.ts'] },
    e: { signatures: ['whatever'] },
  };
  assert.deepEqual(diffBaseline(baseline, current, []), {
    newFailures: ['a: fresh', 'c: <command became unrunnable>', 'e: whatever'],
    baselineFailures: ['a: old', 'b: <unrunnable>', 'd: FAIL src/x.ts'],
    resolved: ['a: gone'],
  });
  // touching a file a baseline failure mentions promotes it to new
  const touched = diffBaseline(baseline, current, ['src/x.ts']);
  assert.ok(touched.newFailures.includes('d: FAIL src/x.ts'));
  assert.ok(!touched.baselineFailures.includes('d: FAIL src/x.ts'));
});

test('diffBaseline: no baseline means everything is new', () => {
  assert.deepEqual(diffBaseline(null, { a: { signatures: ['x', 'y'] } }, []), {
    newFailures: ['a: x', 'a: y'],
    baselineFailures: [],
    resolved: [],
  });
});

// Captured live: legacy.test.js fails before the run; the run adds three
// passing tests. Only the legacy failure may remain, with no new signature.
test('node:test spec reporter: added passing tests are not failures', () => {
  const fixture = (name: string) =>
    readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
  const result = (output: string) => ({
    command: 'node --test',
    ok: false,
    exitCode: 1,
    output,
  });
  const before = fingerprint(result(fixture('node-test-spec-before.txt')));
  const after = fingerprint(result(fixture('node-test-spec-after.txt')));
  const diff = diffBaseline(
    { 'node --test': before },
    { 'node --test': after },
    ['math.js', 'add.test.js'],
  );
  assert.deepEqual(diff.newFailures, []);
  assert.ok(
    diff.baselineFailures.some((s) => s.includes('legacy flaky check')),
  );
  assert.ok(!after.signatures.some((s) => /^ℹ (pass|tests)|^✔/.test(s)));
});

test('pass counters are masked, failed counts kept', () => {
  assert.deepEqual(
    signatureLines('Tests: 1 failed, 3 passed, 4 total\n  5 passing (3ms)'),
    ['Tests: 1 failed, <n> passed, <n> total'],
  );
});
