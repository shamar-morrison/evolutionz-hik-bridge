import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createSerialJobQueue } from '../src/job-queue.js';

test('serial job queue runs one job at a time and keeps processing after failures', async () => {
  const events = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const enqueueJob = createSerialJobQueue(async (job) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    events.push(`start:${job.id}`);

    try {
      await delay(20);

      if (job.fail) {
        events.push(`fail:${job.id}`);
        throw new Error(`boom:${job.id}`);
      }

      events.push(`end:${job.id}`);
      return job.id;
    } finally {
      inFlight -= 1;
    }
  });

  const results = await Promise.allSettled([
    enqueueJob({ id: 1, fail: true }),
    enqueueJob({ id: 2 }),
    enqueueJob({ id: 3 }),
  ]);

  assert.equal(maxInFlight, 1);
  assert.deepEqual(events, [
    'start:1',
    'fail:1',
    'start:2',
    'end:2',
    'start:3',
    'end:3',
  ]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(results[2].status, 'fulfilled');
  assert.equal(results[1].value, 2);
  assert.equal(results[2].value, 3);
});
