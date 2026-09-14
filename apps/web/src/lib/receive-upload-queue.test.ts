import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createReceiveUploadEntries,
  runReceiveUploadQueue,
  type ReceiveUploadAttemptResult,
} from './receive-upload-queue.js';

test('uploads entries serially in their original order', async () => {
  const events: string[] = [];
  const controller = new AbortController();
  const entries = createReceiveUploadEntries(['one', 'two', 'three']);

  const result = await runReceiveUploadQueue({
    entries,
    signal: controller.signal,
    attempt: async (entry, setStatus) => {
      events.push(`start:${entry.value}`);
      setStatus('uploading');
      await Promise.resolve();
      events.push(`finish:${entry.value}`);
      return { kind: 'completed' };
    },
  });

  assert.equal(result.kind, 'completed');
  assert.deepEqual(events, [
    'start:one',
    'finish:one',
    'start:two',
    'finish:two',
    'start:three',
    'finish:three',
  ]);
  assert.deepEqual(
    result.entries.map((entry) => entry.status),
    ['completed', 'completed', 'completed'],
  );
});

test('stops after a partial failure and leaves later entries unstarted', async () => {
  const attempted: string[] = [];
  const failure: ReceiveUploadAttemptResult = {
    kind: 'failed',
    error: 'no capacity',
    failureKind: 'terminal',
  };

  const result = await runReceiveUploadQueue({
    entries: createReceiveUploadEntries(['one', 'two', 'three']),
    signal: new AbortController().signal,
    attempt: async (entry) => {
      attempted.push(entry.value);
      return entry.value === 'two' ? failure : { kind: 'completed' };
    },
  });

  assert.equal(result.kind, 'failed');
  assert.deepEqual(attempted, ['one', 'two']);
  assert.deepEqual(
    result.entries.map((entry) => entry.status),
    ['completed', 'failed', 'not_started'],
  );
  if (result.kind === 'failed') assert.equal(result.failureKind, 'terminal');
});

test('cancellation stops before a later entry while preserving confirmed success', async () => {
  const attempted: string[] = [];
  const controller = new AbortController();

  const result = await runReceiveUploadQueue({
    entries: createReceiveUploadEntries(['one', 'two']),
    signal: controller.signal,
    attempt: async (entry) => {
      attempted.push(entry.value);
      controller.abort();
      return { kind: 'completed' };
    },
  });

  assert.equal(result.kind, 'cancelled');
  assert.deepEqual(attempted, ['one']);
  assert.deepEqual(
    result.entries.map((entry) => entry.status),
    ['completed', 'not_started'],
  );
});

test('an interrupted active entry is cancelled', async () => {
  const controller = new AbortController();

  const result = await runReceiveUploadQueue({
    entries: createReceiveUploadEntries(['one', 'two']),
    signal: controller.signal,
    attempt: async () => {
      controller.abort();
      return { kind: 'cancelled' };
    },
  });

  assert.equal(result.kind, 'cancelled');
  assert.deepEqual(
    result.entries.map((entry) => entry.status),
    ['cancelled', 'not_started'],
  );
});

test('duplicate names receive distinct stable identities', () => {
  const entries = createReceiveUploadEntries([{ name: 'same.txt' }, { name: 'same.txt' }]);

  assert.notEqual(entries[0].id, entries[1].id);
  assert.equal(entries[0].value.name, entries[1].value.name);
});

test('terminal policy failure prevents tickets for remaining entries', async () => {
  let ticketCount = 0;

  const result = await runReceiveUploadQueue({
    entries: createReceiveUploadEntries(['accepted', 'rejected', 'untouched']),
    signal: new AbortController().signal,
    attempt: async (entry) => {
      ticketCount += 1;
      return entry.value === 'rejected'
        ? { kind: 'failed', error: 'expired', failureKind: 'terminal' }
        : { kind: 'completed' };
    },
  });

  assert.equal(result.kind, 'failed');
  assert.equal(ticketCount, 2);
  assert.equal(result.entries[2].status, 'not_started');
});
