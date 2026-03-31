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
        'Device returned 400 for POST /ISAPI/AccessControl/UserInfo/SetUp?format=json: {"statusString":"Invalid Content","subStatusCode":"badParameters"}'
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
        'Device returned 400 for POST /ISAPI/AccessControl/CardInfo/SetUp?format=json: {"statusString":"Invalid Content","subStatusCode":"badParameters"}'
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
