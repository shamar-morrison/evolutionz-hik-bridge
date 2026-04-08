import { SEARCH_PAGE_SIZE, SLOT_TOKEN_PREFIX_PATTERN } from './hik/constants.js';
import { getCard, listAvailableCards, normalizeCardInfoList } from './hik/cards.js';
import { canonicalizeEmployeeNo } from './hik/shared.js';
import { searchUsers } from './hik/users.js';
import { fetchAllUsers } from './sync-members.js';

const UNASSIGNED_NAME_PATTERN = /\bunassigned\b/i;

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function extractCardCode(name) {
  const normalizedName = normalizeText(name);
  const match = normalizedName.match(SLOT_TOKEN_PREFIX_PATTERN);

  return match?.[1] ? match[1].toUpperCase() : null;
}

function normalizeCardCode(value) {
  const normalizedValue = normalizeText(value);
  return normalizedValue || null;
}

function upsertCard(cardsByNumber, nextCard) {
  if (!nextCard.cardNo) {
    return;
  }

  const existingCard = cardsByNumber.get(nextCard.cardNo);

  if (!existingCard || (!existingCard.card_code && nextCard.card_code)) {
    cardsByNumber.set(nextCard.cardNo, nextCard);
  }
}

function extractCardsFromGetCardResponse(response, employeeNo) {
  const cardInfoSearch = response?.CardInfoSearch;

  if (!cardInfoSearch || typeof cardInfoSearch !== 'object') {
    throw new Error(
      `Device returned an unexpected get card response for employee "${employeeNo}".`
    );
  }

  return normalizeCardInfoList(cardInfoSearch.CardInfo);
}

function extractCardsFromAvailableCardResponse(response) {
  const cards = response?.cards;

  if (!Array.isArray(cards)) {
    throw new Error('Device returned an unexpected available card list response.');
  }

  return cards;
}

function sortCards(leftCard, rightCard) {
  return leftCard.cardNo.localeCompare(rightCard.cardNo);
}

export async function syncAvailableCards({
  maxResults = SEARCH_PAGE_SIZE,
  searchUsersFn = searchUsers,
  getCardFn = getCard,
  listAvailableCardsFn = listAvailableCards,
} = {}) {
  const users = await fetchAllUsers({ searchUsersFn, maxResults });
  const cardsByNumber = new Map();

  console.log(`[sync-available-cards] fetchAllUsers returned ${users.length} users`);

  for (const userInfo of users) {
    const employeeNo = normalizeText(userInfo?.employeeNo);
    const name = normalizeText(userInfo?.name);
    const matchesUnassignedPattern = UNASSIGNED_NAME_PATTERN.test(name);

    if (!employeeNo || !matchesUnassignedPattern) {
      if (!matchesUnassignedPattern && name.toLowerCase().includes('unassigned')) {
        console.log(
          `[sync-available-cards] non-matching unassigned-like name="${name}" charCodes=${JSON.stringify(
            [...name].map((c) => c.charCodeAt(0))
          )}`
        );
      }

      continue;
    }

    console.log(
      `[sync-available-cards] matched unassigned user name="${name}" employeeNo="${employeeNo}"`
    );

    const cardCode = extractCardCode(name);
    const canonicalEmployeeNo = canonicalizeEmployeeNo(employeeNo);
    const cardResponse = await getCardFn({ employeeNo: canonicalEmployeeNo });

    if (cardCode === 'P86') {
      console.log('[sync-available-cards] raw getCard response for P86 user', cardResponse);
    }

    const matchedCards = extractCardsFromGetCardResponse(cardResponse, employeeNo);

    console.log(
      `[sync-available-cards] getCard returned ${matchedCards.length} cards for employeeNo="${employeeNo}"`
    );

    for (const cardInfo of matchedCards) {
      const cardNo = normalizeText(cardInfo?.cardNo);

      if (!cardNo) {
        continue;
      }

      upsertCard(cardsByNumber, {
        cardNo,
        card_code: cardCode,
      });
    }
  }

  const availableCardResponse = await listAvailableCardsFn({ maxResults });
  const deviceAvailableCards = extractCardsFromAvailableCardResponse(availableCardResponse);

  for (const card of deviceAvailableCards) {
    const cardNo = normalizeText(card?.cardNo);

    if (!cardNo) {
      continue;
    }

    upsertCard(cardsByNumber, {
      cardNo,
      card_code: normalizeCardCode(card?.card_code),
    });
  }

  console.log(
    `[sync-available-cards] cardsByNumber size before return: ${cardsByNumber.size}`
  );

  return Array.from(cardsByNumber.values()).sort(sortCards);
}
