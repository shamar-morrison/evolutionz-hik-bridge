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

function createFakeSupabase({ existingMembers = [] } = {}) {
  const upsertedMembersPayloads = [];
  const membersTable = new Map(
    existingMembers.map((member) => {
      if (typeof member === 'string') {
        return [
          member,
          {
            employee_no: member,
            name: '',
            card_no: null,
            type: 'General',
            status: 'Active',
            end_time: null,
            gender: null,
            phone: null,
            email: null,
            remark: null,
          },
        ];
      }

      return [
        member.employee_no,
        {
          employee_no: member.employee_no,
          name: member.name ?? '',
          card_no: member.card_no ?? null,
          type: member.type ?? 'General',
          status: member.status ?? 'Active',
          end_time: member.end_time ?? null,
          gender: member.gender ?? null,
          phone: member.phone ?? null,
          email: member.email ?? null,
          remark: member.remark ?? null,
        },
      ];
    })
  );

  return {
    upsertedMembersPayloads,
    membersTable,
    client: {
      from(table) {
        if (table === 'members') {
          return {
            select(columns) {
              assert.equal(
                columns,
                'employee_no, name, card_no, type, status, end_time, gender, phone, email, remark'
              );

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
                          card_no: member.card_no,
                          type: member.type,
                          status: member.status,
                          end_time: member.end_time,
                          gender: member.gender,
                          phone: member.phone,
                          email: member.email,
                          remark: member.remark,
                        };
                      }),
                    error: null,
                  });
                },
              };
            },
            upsert(rows, options) {
              assert.equal(options.ignoreDuplicates, false);
              assert.equal(options.onConflict, 'employee_no');
              upsertedMembersPayloads.push(rows);
              const persistedRows = [];

              for (const row of rows) {
                const existingMember = membersTable.get(row.employee_no);

                membersTable.set(row.employee_no, {
                  employee_no: row.employee_no,
                  name: row.name,
                  card_no: row.card_no ?? null,
                  type: row.type,
                  status: row.status,
                  end_time: row.end_time ?? null,
                  gender: row.gender ?? existingMember?.gender ?? null,
                  phone: row.phone ?? existingMember?.phone ?? null,
                  email: row.email ?? existingMember?.email ?? null,
                  remark: row.remark ?? existingMember?.remark ?? null,
                });
                persistedRows.push({ employee_no: row.employee_no });
              }

              return {
                select() {
                  return Promise.resolve({ data: persistedRows, error: null });
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

test('syncAllMembers paginates device data, stores clean member names, and skips card-table sync', async () => {
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
    membersAdded: 3,
    membersUpdated: 0,
  });
  assert.deepEqual(supabase.upsertedMembersPayloads[0], [
    {
      employee_no: '0001',
      name: 'Alice Brown',
      card_no: 'CARD-1',
      type: 'General',
      status: 'Active',
      end_time: new Date('2026-07-15T23:59:59').toISOString(),
    },
    {
      employee_no: '0003',
      name: 'Expired Eve',
      card_no: 'EXPIRED-CARD',
      type: 'General',
      status: 'Expired',
      end_time: new Date('2020-01-01T00:00:00').toISOString(),
    },
    {
      employee_no: '0004',
      name: 'Invalid Ivan',
      card_no: null,
      type: 'General',
      status: 'Expired',
      end_time: null,
    },
  ]);
});

test('syncAllMembers skips unchanged members on rerun', async () => {
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
    membersAdded: 1,
    membersUpdated: 0,
  });
  assert.deepEqual(secondRun, {
    membersAdded: 0,
    membersUpdated: 0,
  });
  assert.equal(supabase.upsertedMembersPayloads.length, 1);
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
  });

  const result = await syncAllMembers({
    searchUsersFn: userSearch.fn,
    searchCardsFn: cardSearch.fn,
    supabase: supabase.client,
  });

  assert.deepEqual(result, {
    membersAdded: 0,
    membersUpdated: 1,
  });
  assert.deepEqual(supabase.upsertedMembersPayloads, [
    [
      {
        employee_no: '0001',
        name: 'Trishana Baker',
        card_no: 'CARD-1',
        type: 'General',
        status: 'Active',
        end_time: new Date('2026-07-15T23:59:59').toISOString(),
      },
    ],
  ]);
  assert.deepEqual(supabase.membersTable.get('0001'), {
    employee_no: '0001',
    name: 'Trishana Baker',
    card_no: 'CARD-1',
    type: 'General',
    status: 'Active',
    end_time: new Date('2026-07-15T23:59:59').toISOString(),
    gender: null,
    phone: null,
    email: null,
    remark: null,
  });
});

test('syncAllMembers maps gender, phone, email, and remark from Hik users', async () => {
  const users = [
    {
      employeeNo: '0501',
      name: 'Member 501',
      gender: 'male',
      phoneNo: ' ',
      Tel: '876-555-1000',
      email: 'member501@example.com',
      remark: 'VIP',
      Valid: {
        enable: true,
        endTime: '2026-07-15T23:59:59',
      },
    },
  ];
  const cards = [{ employeeNo: '0501', cardNo: 'CARD-501' }];
  const supabase = createFakeSupabase();

  const result = await syncAllMembers({
    searchUsersFn: createPagedUserSearch(users).fn,
    searchCardsFn: createPagedCardSearch(cards).fn,
    supabase: supabase.client,
  });

  assert.deepEqual(result, {
    membersAdded: 1,
    membersUpdated: 0,
  });
  assert.deepEqual(supabase.upsertedMembersPayloads, [
    [
      {
        employee_no: '0501',
        name: 'Member 501',
        card_no: 'CARD-501',
        type: 'General',
        status: 'Active',
        end_time: new Date('2026-07-15T23:59:59').toISOString(),
        gender: 'Male',
        phone: '876-555-1000',
        email: 'member501@example.com',
        remark: 'VIP',
      },
    ],
  ]);
});

test('syncAllMembers reads gender, phone, email, and remark from alias fields', async () => {
  const users = [
    {
      employeeNo: '0602',
      name: 'Member 602',
      sex: 'female',
      phoneNumber: '876-555-0602',
      Email: 'member602@example.com',
      Remark: 'Monthly',
      Valid: {
        enable: true,
        endTime: '2026-07-15T23:59:59',
      },
    },
  ];
  const cards = [{ employeeNo: '0602', cardNo: 'CARD-602' }];
  const supabase = createFakeSupabase();

  const result = await syncAllMembers({
    searchUsersFn: createPagedUserSearch(users).fn,
    searchCardsFn: createPagedCardSearch(cards).fn,
    supabase: supabase.client,
  });

  assert.deepEqual(result, {
    membersAdded: 1,
    membersUpdated: 0,
  });
  assert.deepEqual(supabase.upsertedMembersPayloads, [
    [
      {
        employee_no: '0602',
        name: 'Member 602',
        card_no: 'CARD-602',
        type: 'General',
        status: 'Active',
        end_time: new Date('2026-07-15T23:59:59').toISOString(),
        gender: 'Female',
        phone: '876-555-0602',
        email: 'member602@example.com',
        remark: 'Monthly',
      },
    ],
  ]);
});

test('syncAllMembers preserves existing profile data when the device returns blanks', async () => {
  const users = [
    {
      employeeNo: '0700',
      name: 'Member Seven',
      gender: ' ',
      phoneNo: ' ',
      Tel: '',
      email: null,
      remark: '',
      Valid: {
        enable: false,
        endTime: '2026-07-15T23:59:59',
      },
    },
  ];
  const cards = [{ employeeNo: '0700', cardNo: 'CARD-700' }];
  const supabase = createFakeSupabase({
    existingMembers: [
      {
        employee_no: '0700',
        name: 'Member Seven',
        card_no: 'OLD-CARD',
        type: 'Student/BPO',
        status: 'Active',
        end_time: '2025-07-15T23:59:59.000Z',
        gender: 'Female',
        phone: '876-555-0700',
        email: 'member700@example.com',
        remark: 'Existing note',
      },
    ],
  });

  const result = await syncAllMembers({
    searchUsersFn: createPagedUserSearch(users).fn,
    searchCardsFn: createPagedCardSearch(cards).fn,
    supabase: supabase.client,
  });

  assert.deepEqual(result, {
    membersAdded: 0,
    membersUpdated: 1,
  });
  assert.deepEqual(supabase.upsertedMembersPayloads, [
    [
      {
        employee_no: '0700',
        name: 'Member Seven',
        card_no: 'CARD-700',
        type: 'Student/BPO',
        status: 'Expired',
        end_time: new Date('2026-07-15T23:59:59').toISOString(),
        gender: 'Female',
        phone: '876-555-0700',
        email: 'member700@example.com',
        remark: 'Existing note',
      },
    ],
  ]);
  assert.deepEqual(supabase.membersTable.get('0700'), {
    employee_no: '0700',
    name: 'Member Seven',
    card_no: 'CARD-700',
    type: 'Student/BPO',
    status: 'Expired',
    end_time: new Date('2026-07-15T23:59:59').toISOString(),
    gender: 'Female',
    phone: '876-555-0700',
    email: 'member700@example.com',
    remark: 'Existing note',
  });
});
