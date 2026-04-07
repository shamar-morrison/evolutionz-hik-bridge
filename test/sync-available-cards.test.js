import assert from 'node:assert/strict';
import test from 'node:test';
import { syncAvailableCards } from '../src/sync-available-cards.js';

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

test(
  'syncAvailableCards paginates users, looks up UNASSIGNED holders directly, and merges cards',
  async () => {
    const users = [
      { employeeNo: '0001', name: 'p4 unassigned slot' },
      { employeeNo: '0002', name: 'Jane Doe' },
      { employeeNo: '0003', name: 'UNASSIGNED' },
      { employeeNo: '0004', name: 'b1 helper unassigned lane' },
    ];
    const userSearch = createPagedUserSearch(users);
    const getCardCalls = [];
    const result = await syncAvailableCards({
      maxResults: 2,
      searchUsersFn: userSearch.fn,
      getCardFn: async (payload) => {
        getCardCalls.push(payload);

        if (payload.employeeNo === '1') {
          return {
            CardInfoSearch: {
              CardInfo: [{ cardNo: 'CARD-2' }, { cardNo: 'CARD-1' }],
            },
          };
        }

        if (payload.employeeNo === '3') {
          return {
            CardInfoSearch: {
              CardInfo: [{ cardNo: 'CARD-4' }],
            },
          };
        }

        if (payload.employeeNo === '4') {
          return {
            CardInfoSearch: {
              CardInfo: { cardNo: 'CARD-4' },
            },
          };
        }

        throw new Error(`Unexpected getCard lookup for ${payload.employeeNo}`);
      },
      listAvailableCardsFn: async () => ({
        cards: [{ cardNo: 'CARD-4' }, { cardNo: 'CARD-3' }, { cardNo: 'CARD-2' }],
      }),
    });

    assert.deepEqual(userSearch.calls, [
      { searchResultPosition: 0, maxResults: 2 },
      { searchResultPosition: 2, maxResults: 2 },
    ]);
    assert.deepEqual(getCardCalls, [
      { employeeNo: '1' },
      { employeeNo: '3' },
      { employeeNo: '4' },
    ]);
    assert.deepEqual(result, [
      { cardNo: 'CARD-1', card_code: 'P4' },
      { cardNo: 'CARD-2', card_code: 'P4' },
      { cardNo: 'CARD-3', card_code: null },
      { cardNo: 'CARD-4', card_code: 'B1' },
    ]);
  }
);

test('syncAvailableCards rejects unexpected getCard responses', async () => {
  const userSearch = createPagedUserSearch([{ employeeNo: '0001', name: 'A18 UNASSIGNED' }]);

  await assert.rejects(
    () =>
      syncAvailableCards({
        searchUsersFn: userSearch.fn,
        getCardFn: async () => ({}),
        listAvailableCardsFn: async () => ({ cards: [] }),
      }),
    /unexpected get card response/
  );
});
