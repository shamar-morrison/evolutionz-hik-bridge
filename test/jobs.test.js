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

test('processJob dispatches sync_available_cards jobs', async () => {
  const calls = [];
  const hikApi = {
    syncAvailableCards: async (payload) => {
      calls.push(payload);
      return [{ cardNo: 'EF-009999', card_code: 'A18' }];
    },
  };

  const result = await processJob(
    {
      id: 'job-sync-cards',
      type: 'sync_available_cards',
      payload: {},
    },
    hikApi
  );

  assert.deepEqual(calls, [{}]);
  assert.deepEqual(result, {
    success: true,
    result: [{ cardNo: 'EF-009999', card_code: 'A18' }],
  });
});

test('processJob dispatches get_card jobs with card numbers', async () => {
  const calls = [];
  const hikApi = {
    getCard: async (payload) => {
      calls.push(payload);
      return { ok: true };
    },
  };

  const result = await processJob(
    {
      id: 'job-get-card',
      type: 'get_card',
      payload: { cardNo: '0102857149' },
    },
    hikApi
  );

  assert.deepEqual(calls, [{ cardNo: '0102857149' }]);
  assert.deepEqual(result, {
    success: true,
    result: { ok: true },
  });
});

test('processJob dispatches get_member_events jobs and normalizes device events', async () => {
  const calls = [];
  const hikApi = {
    getMemberEvents: async (payload) => {
      calls.push(payload);
      return {
        responseStatusStrg: 'OK',
        totalMatches: '41',
        InfoList: {
          time: '2026-04-02T14:17:00+08:00',
          major: '5',
          minor: '75',
          cardNo: ' 0102857149 ',
        },
      };
    },
  };

  const result = await processJob(
    {
      id: 'job-get-member-events',
      type: 'get_member_events',
      payload: {
        employeeNoString: '00000611',
        maxResults: 20,
        searchID: 'shared-search-id-123',
        searchResultPosition: 40,
      },
    },
    hikApi
  );

  assert.deepEqual(calls, [
    {
      employeeNoString: '00000611',
      maxResults: 20,
      searchID: 'shared-search-id-123',
      searchResultPosition: 40,
    },
  ]);
  assert.deepEqual(result, {
    success: true,
    result: {
      events: [
        {
          time: '2026-04-02T14:17:00+08:00',
          major: 5,
          minor: 75,
          cardNo: '0102857149',
        },
      ],
      totalMatches: 41,
    },
  });
});

test('processJob dispatches get_door_history jobs across all device pages and aggregates them', async () => {
  const calls = [];
  const hikApi = {
    getDoorHistory: async (payload) => {
      calls.push(payload);

      if (payload.searchResultPosition === 0) {
        return {
          AcsEvent: {
            totalMatches: '21',
            InfoList: Array.from({ length: 10 }, (_, index) => ({
              cardNo: `01028571${String(index).padStart(2, '0')}`,
              time: `2026-04-14T00:${String(index).padStart(2, '0')}:00-05:00`,
            })),
          },
        };
      }

      if (payload.searchResultPosition === 10) {
        return {
          AcsEvent: {
            totalMatches: '21',
            InfoList: Array.from({ length: 10 }, (_, index) => ({
              cardNo: `01028572${String(index).padStart(2, '0')}`,
              time: `2026-04-14T01:${String(index).padStart(2, '0')}:00-05:00`,
            })),
          },
        };
      }

      return {
        AcsEvent: {
          totalMatches: '21',
          InfoList: [
            {
              cardNo: '0102857300',
              time: '2026-04-14T02:00:00-05:00',
            },
          ],
        },
      };
    },
  };

  const result = await processJob(
    {
      id: 'job-get-door-history',
      type: 'get_door_history',
      payload: {
        startTime: '2026-04-14T00:00:00-05:00',
        endTime: '2026-04-15T00:00:00-05:00',
        searchID: 'door-history-search-id',
      },
    },
    hikApi
  );

  assert.deepEqual(calls, [
    {
      startTime: '2026-04-14T00:00:00-05:00',
      endTime: '2026-04-15T00:00:00-05:00',
      searchID: 'door-history-search-id',
      searchResultPosition: 0,
      maxResults: 10,
    },
    {
      startTime: '2026-04-14T00:00:00-05:00',
      endTime: '2026-04-15T00:00:00-05:00',
      searchID: 'door-history-search-id',
      searchResultPosition: 10,
      maxResults: 10,
    },
    {
      startTime: '2026-04-14T00:00:00-05:00',
      endTime: '2026-04-15T00:00:00-05:00',
      searchID: 'door-history-search-id',
      searchResultPosition: 20,
      maxResults: 10,
    },
  ]);
  assert.deepEqual(result, {
    success: true,
    result: {
      events: [
        ...Array.from({ length: 10 }, (_, index) => ({
          cardNo: `01028571${String(index).padStart(2, '0')}`,
          time: `2026-04-14T00:${String(index).padStart(2, '0')}:00-05:00`,
        })),
        ...Array.from({ length: 10 }, (_, index) => ({
          cardNo: `01028572${String(index).padStart(2, '0')}`,
          time: `2026-04-14T01:${String(index).padStart(2, '0')}:00-05:00`,
        })),
        {
          cardNo: '0102857300',
          time: '2026-04-14T02:00:00-05:00',
        },
      ],
      totalMatches: 21,
    },
  });
});

test('processJob dispatches get_door_history jobs until an empty final page after an exact multiple of 10', async () => {
  const calls = [];
  const hikApi = {
    getDoorHistory: async (payload) => {
      calls.push(payload);

      if (payload.searchResultPosition === 20) {
        return {
          AcsEvent: {
            totalMatches: '20',
            InfoList: [],
          },
        };
      }

      return {
        AcsEvent: {
          totalMatches: '20',
          InfoList: Array.from({ length: 10 }, (_, index) => ({
            cardNo: `${payload.searchResultPosition}-${index}`,
          })),
        },
      };
    },
  };

  const result = await processJob(
    {
      id: 'job-get-door-history-multiple-of-10',
      type: 'get_door_history',
      payload: {
        startTime: '2026-04-14T00:00:00-05:00',
        endTime: '2026-04-15T00:00:00-05:00',
      },
    },
    hikApi
  );

  assert.deepEqual(
    calls.map((call) => ({
      searchID: call.searchID,
      searchResultPosition: call.searchResultPosition,
      maxResults: call.maxResults,
    })),
    [
      {
        searchID: calls[0].searchID,
        searchResultPosition: 0,
        maxResults: 10,
      },
      {
        searchID: calls[0].searchID,
        searchResultPosition: 10,
        maxResults: 10,
      },
      {
        searchID: calls[0].searchID,
        searchResultPosition: 20,
        maxResults: 10,
      },
    ]
  );
  assert.equal(typeof calls[0].searchID, 'string');
  assert.ok(calls[0].searchID.length > 0);
  assert.deepEqual(result, {
    success: true,
    result: {
      events: [
        ...Array.from({ length: 10 }, (_, index) => ({
          cardNo: `0-${index}`,
        })),
        ...Array.from({ length: 10 }, (_, index) => ({
          cardNo: `10-${index}`,
        })),
      ],
      totalMatches: 20,
    },
  });
});

test('processJob dispatches list_available_slots jobs', async () => {
  const hikApi = {
    listAvailableSlots: async () => ({
      slots: [{ employeeNo: '00000611', cardNo: '0102857149', placeholderName: 'P42' }],
    }),
  };

  const result = await processJob(
    {
      id: 'job-slots',
      type: 'list_available_slots',
      payload: {},
    },
    hikApi
  );

  assert.deepEqual(result, {
    success: true,
    result: {
      slots: [{ employeeNo: '00000611', cardNo: '0102857149', placeholderName: 'P42' }],
    },
  });
});

test('processJob dispatches sync_all_members jobs', async () => {
  const calls = [];
  const hikApi = {
    syncAllMembers: async (payload) => {
      calls.push(payload);
      return {
        membersAdded: 3,
        membersUpdated: 4,
      };
    },
  };

  const result = await processJob(
    {
      id: 'job-sync',
      type: 'sync_all_members',
      payload: {},
    },
    hikApi
  );

  assert.deepEqual(calls, [{}]);
  assert.deepEqual(result, {
    success: true,
    result: {
      membersAdded: 3,
      membersUpdated: 4,
    },
  });
});

test('processJob dispatches reset_slot jobs', async () => {
  const calls = [];
  const hikApi = {
    resetSlot: async (payload) => {
      calls.push(payload);
      return { ok: true };
    },
  };

  const result = await processJob(
    {
      id: 'job-reset',
      type: 'reset_slot',
      payload: { employeeNo: '00000611', placeholderName: 'P42' },
    },
    hikApi
  );

  assert.deepEqual(calls, [{ employeeNo: '00000611', placeholderName: 'P42' }]);
  assert.deepEqual(result, {
    success: true,
    result: { ok: true },
  });
});

test('processJob logs add_user write diagnostics when debug flag is enabled', async () => {
  const hikApi = {
    addUser: async () => {
      throw new Error(
        'Device returned 400 for PUT /ISAPI/AccessControl/UserInfo/SetUp?format=json: {"statusString":"Invalid Content","subStatusCode":"badParameters"}'
      );
    },
  };
  const originalFlag = process.env.HIK_DEBUG_WRITE_PAYLOADS;
  const originalMode = process.env.HIK_USER_MODIFY_MODE;
  const originalError = console.error;
  const errorCalls = [];

  process.env.HIK_DEBUG_WRITE_PAYLOADS = '1';
  process.env.HIK_USER_MODIFY_MODE = 'full_access';
  console.error = (...args) => {
    errorCalls.push(args);
  };

  try {
    await assert.rejects(
      () =>
        processJob(
          {
            id: 'job-add-user',
            type: 'add_user',
            payload: {
              employeeNo: ' 00000611 ',
              name: ' Jane Doe ',
              beginTime: '2026-03-30T00:00:00',
              endTime: '2026-07-15T23:59:59',
            },
          },
          hikApi
        ),
      /UserInfo\/SetUp\?format=json/
    );
  } finally {
    console.error = originalError;

    if (originalFlag === undefined) {
      delete process.env.HIK_DEBUG_WRITE_PAYLOADS;
    } else {
      process.env.HIK_DEBUG_WRITE_PAYLOADS = originalFlag;
    }

    if (originalMode === undefined) {
      delete process.env.HIK_USER_MODIFY_MODE;
    } else {
      process.env.HIK_USER_MODIFY_MODE = originalMode;
    }
  }

  assert.equal(errorCalls.length, 1);
  const [message] = errorCalls[0];
  const diagnostics = JSON.parse(message.slice(message.indexOf('\n') + 1));

  assert.match(message, /^\[hik\] add_user write failure diagnostics\n/);
  assert.deepEqual(diagnostics, {
    jobType: 'add_user',
    route: '/ISAPI/AccessControl/UserInfo/SetUp?format=json',
    payloadSummary: {
      employeeNo: '00000611',
      name: 'Jane Doe',
      nameLength: 8,
      beginTime: '2026-03-30T00:00:00',
      endTime: '2026-07-15T23:59:59',
      cardNo: null,
      payloadMode: 'full_access',
      userType: 'normal',
      doorRight: '1',
      RightPlan: [{ doorNo: 1, planTemplateNo: '1' }],
    },
    rawDeviceErrorBody: '{"statusString":"Invalid Content","subStatusCode":"badParameters"}',
  });
});

test('processJob logs add_card write diagnostics when debug flag is enabled', async () => {
  const hikApi = {
    addCard: async () => {
      throw new Error(
        'Device returned 400 for PUT /ISAPI/AccessControl/CardInfo/SetUp?format=json: {"statusString":"Invalid Content","subStatusCode":"badParameters"}'
      );
    },
  };
  const originalFlag = process.env.HIK_DEBUG_WRITE_PAYLOADS;
  const originalError = console.error;
  const errorCalls = [];

  process.env.HIK_DEBUG_WRITE_PAYLOADS = '1';
  console.error = (...args) => {
    errorCalls.push(args);
  };

  try {
    await assert.rejects(
      () =>
        processJob(
          {
            id: 'job-add-card',
            type: 'add_card',
            payload: {
              employeeNo: ' 00000611 ',
              cardNo: ' 0102857149 ',
            },
          },
          hikApi
        ),
      /CardInfo\/SetUp\?format=json/
    );
  } finally {
    console.error = originalError;

    if (originalFlag === undefined) {
      delete process.env.HIK_DEBUG_WRITE_PAYLOADS;
    } else {
      process.env.HIK_DEBUG_WRITE_PAYLOADS = originalFlag;
    }
  }

  assert.equal(errorCalls.length, 1);
  const [message] = errorCalls[0];
  const diagnostics = JSON.parse(message.slice(message.indexOf('\n') + 1));

  assert.match(message, /^\[hik\] add_card write failure diagnostics\n/);
  assert.deepEqual(diagnostics, {
    jobType: 'add_card',
    route: '/ISAPI/AccessControl/CardInfo/SetUp?format=json',
    payloadSummary: {
      employeeNo: '00000611',
      name: null,
      nameLength: null,
      beginTime: null,
      endTime: null,
      cardNo: '0102857149',
      payloadMode: null,
      userType: null,
      doorRight: null,
      RightPlan: null,
    },
    rawDeviceErrorBody: '{"statusString":"Invalid Content","subStatusCode":"badParameters"}',
  });
});
