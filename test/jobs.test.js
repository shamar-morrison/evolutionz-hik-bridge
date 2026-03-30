import assert from 'node:assert/strict';
import test from 'node:test';
import { processJob } from '../src/jobs.js';

test('processJob dispatches unlock_door jobs unchanged', async () => {
  const hikApi = {
    unlockDoor: async (doorNo) => ({ doorNo, ok: true }),
  };

  const result = await processJob(
    {
      id: 'job-unlock',
      type: 'unlock_door',
      payload: { doorNo: 2 },
    },
    hikApi
  );

  assert.deepEqual(result, {
    success: true,
    result: { doorNo: 2, ok: true },
  });
});

test('processJob dispatches list_available_cards jobs', async () => {
  const hikApi = {
    listAvailableCards: async () => ({
      cards: [{ cardNo: 'EF-009999' }],
    }),
  };

  const result = await processJob(
    {
      id: 'job-cards',
      type: 'list_available_cards',
      payload: {},
    },
    hikApi
  );

  assert.deepEqual(result, {
    success: true,
    result: {
      cards: [{ cardNo: 'EF-009999' }],
    },
  });
});
