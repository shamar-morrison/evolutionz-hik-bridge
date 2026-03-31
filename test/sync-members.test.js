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

function normalizeExistingCard(card) {
  if (typeof card === 'string') {
    return {
      card_no: card,
      card_code: null,
      employee_no: null,
      status: 'available',
      updated_at: null,
    };
  }

  return {
    card_no: card.card_no,
    card_code: card.card_code ?? null,
    employee_no: card.employee_no ?? null,
    status: card.status ?? 'available',
    updated_at: card.updated_at ?? null,
  };
}

function createFakeSupabase({
  existingMembers = [],
  existingCards = [],
} = {}) {
  const insertedMembersPayloads = [];
  const updatedMembersPayloads = [];
  const insertedCardsPayloads = [];
  const updatedCardsPayloads = [];
  const membersTable = new Map(
    existingMembers.map((member) => {
      if (typeof member === 'string') {
        return [member, { employee_no: member, name: '' }];
      }

      return [
        member.employee_no,
        {
          employee_no: member.employee_no,
          name: member.name ?? '',
          updated_at: member.updated_at ?? null,
        },
      ];
    })
  );
  const cardsTable = new Map(
    existingCards.map((card) => {
      const normalizedCard = normalizeExistingCard(card);
      return [normalizedCard.card_no, normalizedCard];
    })
  );

  return {
    insertedMembersPayloads,
    updatedMembersPayloads,
    insertedCardsPayloads,
    updatedCardsPayloads,
    membersTable,
    cardsTable,
    client: {
      from(table) {
        if (table === 'members') {
          return {
            select(columns) {
              assert.equal(columns, 'employee_no, name');

              return {
                in(column, values) {
                  assert.equal(column, 'employee_no');

                  return Promise.resolve({
                    data: values
                      .filter((value) => membersTable.has(value))
                      .map((value) => {
                        const member = membersTable.get(value);
                        return {
                          employee_no: member.employee_no,
                          name: member.name,
                        };
                      }),
                    error: null,
                  });
                },
              };
            },
            upsert(rows, options) {
              assert.equal(options.ignoreDuplicates, true);
              assert.equal(options.onConflict, 'employee_no');
              insertedMembersPayloads.push(rows);

              const insertedRows = [];

              for (const row of rows) {
                if (membersTable.has(row.employee_no)) {
                  continue;
                }

                membersTable.set(row.employee_no, {
                  employee_no: row.employee_no,
                  name: row.name,
                  updated_at: null,
                });
                insertedRows.push({ employee_no: row.employee_no });
              }

              return {
                select() {
                  return Promise.resolve({ data: insertedRows, error: null });
                },
              };
            },
            update(values) {
              return {
                eq(column, value) {
                  assert.equal(column, 'employee_no');

                  const member = membersTable.get(value);
                  const updatedRows = [];

                  if (member) {
                    member.name = values.name;
                    member.updated_at = values.updated_at;
                    updatedMembersPayloads.push({
                      employee_no: value,
                      values,
                    });
                    updatedRows.push({ employee_no: value });
                  }

                  return {
                    select(selectColumns) {
                      assert.equal(selectColumns, 'employee_no');
                      return Promise.resolve({ data: updatedRows, error: null });
                    },
                  };
                },
              };
            },
          };
        }

        if (table === 'cards') {
          return {
            select(columns) {
              assert.equal(columns, 'card_no, card_code');

              return {
                in(column, values) {
                  assert.equal(column, 'card_no');

                  return Promise.resolve({
                    data: values
                      .filter((value) => cardsTable.has(value))
                      .map((value) => {
                        const card = cardsTable.get(value);
                        return {
                          card_no: card.card_no,
                          card_code: card.card_code,
                        };
                      }),
                    error: null,
                  });
                },
              };
            },
            upsert(rows, options) {
              assert.equal(options.onConflict, 'card_no');
              assert.equal(options.ignoreDuplicates, true);
              insertedCardsPayloads.push(rows);

              const insertedRows = [];

              for (const row of rows) {
                if (cardsTable.has(row.card_no)) {
                  continue;
                }

                cardsTable.set(row.card_no, {
                  card_no: row.card_no,
                  card_code: row.card_code ?? null,
                  employee_no: row.employee_no ?? null,
                  status: row.status,
                  updated_at: null,
                });
                insertedRows.push({ card_no: row.card_no });
              }

              return {
                select() {
                  return Promise.resolve({ data: insertedRows, error: null });
                },
              };
            },
            update(values) {
              return {
                eq(column, value) {
                  assert.equal(column, 'card_no');

                  return {
                    is(isColumn, expectedValue) {
                      assert.equal(isColumn, 'card_code');
                      assert.equal(expectedValue, null);

                      const card = cardsTable.get(value);
                      const updatedRows = [];

                      if (card && card.card_code === null) {
                        card.card_code = values.card_code;
                        card.updated_at = values.updated_at;
                        updatedCardsPayloads.push({
                          card_no: value,
                          values,
                        });
                        updatedRows.push({ card_no: value });
                      }

                      return {
                        select(selectColumns) {
                          assert.equal(selectColumns, 'card_no');
                          return Promise.resolve({ data: updatedRows, error: null });
                        },
                      };
                    },
                  };
                },
              };
            },
          };
        }

        throw new Error(`Unexpected table: ${table}`);
      },
    },
  };
}

test('syncAllMembers paginates device data, stores clean member names, and persists card codes', async () => {
  const users = [
    {
      employeeNo: '0001',
      name: 'A1 Alice Brown',
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
      name: 'C4 Expired Eve',
      Valid: {
        enable: true,
        endTime: '2020-01-01T00:00:00',
      },
    },
    {
      employeeNo: '0004',
      name: 'D5 Invalid Ivan',
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
      card_code: 'A1',
    },
    {
      card_no: 'CARD-1',
      employee_no: '0001',
      status: 'assigned',
      card_code: 'A1',
    },
    {
      card_no: 'PH-CARD',
      employee_no: null,
      status: 'available',
      card_code: 'B3',
    },
    {
      card_no: 'ORPHAN',
      employee_no: null,
      status: 'available',
      card_code: null,
    },
    {
      card_no: 'EXPIRED-CARD',
      employee_no: '0003',
      status: 'assigned',
      card_code: 'C4',
    },
  ]);
});

test('syncAllMembers backfills missing card codes on rerun without changing assignment state', async () => {
  const users = [
    {
      employeeNo: '0001',
      name: 'A1 Alice Brown',
      Valid: {
        enable: true,
        endTime: '2026-07-15T23:59:59',
      },
    },
  ];
  const cards = [{ employeeNo: '0001', cardNo: 'CARD-1' }];
  const userSearch = createPagedUserSearch(users);
  const cardSearch = createPagedCardSearch(cards);
  const supabase = createFakeSupabase({
    existingCards: [
      {
        card_no: 'CARD-1',
        card_code: null,
        employee_no: '0001',
        status: 'assigned',
      },
    ],
  });

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
  assert.deepEqual(supabase.updatedCardsPayloads, [
    {
      card_no: 'CARD-1',
      values: {
        card_code: 'A1',
        updated_at: supabase.cardsTable.get('CARD-1').updated_at,
      },
    },
  ]);
  assert.deepEqual(supabase.cardsTable.get('CARD-1'), {
    card_no: 'CARD-1',
    card_code: 'A1',
    employee_no: '0001',
    status: 'assigned',
    updated_at: supabase.cardsTable.get('CARD-1').updated_at,
  });
});

test('syncAllMembers normalizes existing prefixed member names on rerun', async () => {
  const users = [
    {
      employeeNo: '0001',
      name: 'J11 Trishana Baker',
      Valid: {
        enable: true,
        endTime: '2026-07-15T23:59:59',
      },
    },
  ];
  const cards = [{ employeeNo: '0001', cardNo: 'CARD-1' }];
  const userSearch = createPagedUserSearch(users);
  const cardSearch = createPagedCardSearch(cards);
  const supabase = createFakeSupabase({
    existingMembers: [
      {
        employee_no: '0001',
        name: 'J11 Trishana Baker',
      },
    ],
    existingCards: [
      {
        card_no: 'CARD-1',
        card_code: 'J11',
        employee_no: '0001',
        status: 'assigned',
      },
    ],
  });

  const result = await syncAllMembers({
    searchUsersFn: userSearch.fn,
    searchCardsFn: cardSearch.fn,
    supabase: supabase.client,
  });

  assert.deepEqual(result, {
    membersImported: 1,
    cardsImported: 0,
    placeholderSlotsSkipped: 0,
  });
  assert.deepEqual(supabase.updatedMembersPayloads, [
    {
      employee_no: '0001',
      values: {
        name: 'Trishana Baker',
        updated_at: supabase.membersTable.get('0001').updated_at,
      },
    },
  ]);
  assert.deepEqual(supabase.membersTable.get('0001'), {
    employee_no: '0001',
    name: 'Trishana Baker',
    updated_at: supabase.membersTable.get('0001').updated_at,
  });
});
