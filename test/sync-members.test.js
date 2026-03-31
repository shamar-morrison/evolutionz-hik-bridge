import assert from 'node:assert/strict';
import test from 'node:test';
import { syncAllMembers } from '../src/sync-members.js';

function createPagedUserSearch(users) {
  const calls = [];

  return {
    calls,
    fn: async ({ searchResultPosition, maxResults }) => {
      calls.push({ searchResultPosition, maxResults });

      const page = users.slice(searchResultPosition, searchResultPosition + maxResults);
      const hasMore = searchResultPosition + page.length < users.length;

      return {
        UserInfoSearch: {
          responseStatusStrg: hasMore ? 'MORE' : 'OK',
          numOfMatches: page.length,
          totalMatches: users.length,
          UserInfo: page,
        },
      };
    },
  };
}

function createPagedCardSearch(cards) {
  const calls = [];

  return {
    calls,
    fn: async ({ searchResultPosition, maxResults }) => {
      calls.push({ searchResultPosition, maxResults });

      const page = cards.slice(searchResultPosition, searchResultPosition + maxResults);
      const hasMore = searchResultPosition + page.length < cards.length;

      return {
        CardInfoSearch: {
          responseStatusStrg: hasMore ? 'MORE' : 'OK',
          numOfMatches: page.length,
          totalMatches: cards.length,
          CardInfo: page,
        },
      };
    },
  };
}

function createFakeSupabase({
  existingMembers = [],
  existingCards = [],
} = {}) {
  const insertedMembersPayloads = [];
  const insertedCardsPayloads = [];
  const seenMembers = new Set(existingMembers);
  const seenCards = new Set(existingCards);

  return {
    insertedMembersPayloads,
    insertedCardsPayloads,
    client: {
      from(table) {
        return {
          upsert(rows, options) {
            assert.equal(options.ignoreDuplicates, true);

            if (table === 'members') {
              assert.equal(options.onConflict, 'employee_no');
              insertedMembersPayloads.push(rows);

              const insertedRows = [];

              for (const row of rows) {
                if (seenMembers.has(row.employee_no)) {
                  continue;
                }

                seenMembers.add(row.employee_no);
                insertedRows.push({ employee_no: row.employee_no });
              }

              return {
                select() {
                  return Promise.resolve({ data: insertedRows, error: null });
                },
              };
            }

            if (table === 'cards') {
              assert.equal(options.onConflict, 'card_no');
              insertedCardsPayloads.push(rows);

              const insertedRows = [];

              for (const row of rows) {
                if (seenCards.has(row.card_no)) {
                  continue;
                }

                seenCards.add(row.card_no);
                insertedRows.push({ card_no: row.card_no });
              }

              return {
                select() {
                  return Promise.resolve({ data: insertedRows, error: null });
                },
              };
            }

            throw new Error(`Unexpected table: ${table}`);
          },
        };
      },
    },
  };
}

test('syncAllMembers paginates device data, skips placeholder members, and persists card assignments', async () => {
  const users = [
    {
      employeeNo: '0001',
      name: 'Alice Brown',
      Valid: {
        enable: true,
        endTime: '2026-07-15T23:59:59',
      },
    },
    {
      employeeNo: '0002',
      name: 'B3',
      Valid: {
        enable: false,
        endTime: '2020-01-01T00:00:00',
      },
    },
    {
      employeeNo: '0003',
      name: 'Expired Eve',
      Valid: {
        enable: true,
        endTime: '2020-01-01T00:00:00',
      },
    },
    {
      employeeNo: '0004',
      name: 'Invalid Ivan',
      Valid: {
        enable: true,
        endTime: 'not-a-date',
      },
    },
  ];
  const cards = [
    { employeeNo: '1', cardNo: 'CARD-2' },
    { employeeNo: '0001', cardNo: 'CARD-1' },
    { employeeNo: '2', cardNo: 'PH-CARD' },
    { employeeNo: '9999', cardNo: 'ORPHAN' },
    { employeeNo: '0003', cardNo: 'EXPIRED-CARD' },
  ];
  const userSearch = createPagedUserSearch(users);
  const cardSearch = createPagedCardSearch(cards);
  const supabase = createFakeSupabase();

  const result = await syncAllMembers({
    maxResults: 2,
    now: new Date('2026-03-30T12:00:00Z'),
    searchUsersFn: userSearch.fn,
    searchCardsFn: cardSearch.fn,
    supabase: supabase.client,
  });

  assert.deepEqual(userSearch.calls, [
    { searchResultPosition: 0, maxResults: 2 },
    { searchResultPosition: 2, maxResults: 2 },
  ]);
  assert.deepEqual(cardSearch.calls, [
    { searchResultPosition: 0, maxResults: 2 },
    { searchResultPosition: 2, maxResults: 2 },
    { searchResultPosition: 4, maxResults: 2 },
  ]);
  assert.deepEqual(result, {
    membersImported: 3,
    cardsImported: 5,
    placeholderSlotsSkipped: 1,
  });
  assert.deepEqual(supabase.insertedMembersPayloads[0], [
    {
      employee_no: '0001',
      name: 'Alice Brown',
      card_no: 'CARD-1',
      type: 'General',
      status: 'Active',
      expiry: new Date('2026-07-15T23:59:59').toISOString(),
      balance: 0,
    },
    {
      employee_no: '0003',
      name: 'Expired Eve',
      card_no: 'EXPIRED-CARD',
      type: 'General',
      status: 'Expired',
      expiry: new Date('2020-01-01T00:00:00').toISOString(),
      balance: 0,
    },
    {
      employee_no: '0004',
      name: 'Invalid Ivan',
      card_no: null,
      type: 'General',
      status: 'Expired',
      expiry: null,
      balance: 0,
    },
  ]);
  assert.deepEqual(supabase.insertedCardsPayloads[0], [
    {
      card_no: 'CARD-2',
      employee_no: '0001',
      status: 'assigned',
    },
    {
      card_no: 'CARD-1',
      employee_no: '0001',
      status: 'assigned',
    },
    {
      card_no: 'PH-CARD',
      employee_no: null,
      status: 'available',
    },
    {
      card_no: 'ORPHAN',
      employee_no: null,
      status: 'available',
    },
    {
      card_no: 'EXPIRED-CARD',
      employee_no: '0003',
      status: 'assigned',
    },
  ]);
});

test('syncAllMembers ignores duplicates on rerun and reports only newly inserted rows', async () => {
  const users = [
    {
      employeeNo: '0001',
      name: 'Alice Brown',
      Valid: {
        enable: true,
        endTime: '2026-07-15T23:59:59',
      },
    },
  ];
  const cards = [{ employeeNo: '0001', cardNo: 'CARD-1' }];
  const userSearch = createPagedUserSearch(users);
  const cardSearch = createPagedCardSearch(cards);
  const supabase = createFakeSupabase();

  const firstRun = await syncAllMembers({
    searchUsersFn: userSearch.fn,
    searchCardsFn: cardSearch.fn,
    supabase: supabase.client,
  });
  const secondRun = await syncAllMembers({
    searchUsersFn: userSearch.fn,
    searchCardsFn: cardSearch.fn,
    supabase: supabase.client,
  });

  assert.deepEqual(firstRun, {
    membersImported: 1,
    cardsImported: 1,
    placeholderSlotsSkipped: 0,
  });
  assert.deepEqual(secondRun, {
    membersImported: 0,
    cardsImported: 0,
    placeholderSlotsSkipped: 0,
  });
});
