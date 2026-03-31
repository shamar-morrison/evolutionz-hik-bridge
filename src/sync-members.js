import { SEARCH_PAGE_SIZE } from './hik/constants.js';
import {
  canonicalizeEmployeeNo,
  getNumericField,
  normalizeSearchMetadata,
  shouldContinuePagedSearch,
  toBoolean,
} from './hik/shared.js';
import { normalizeCardInfoList, searchCards } from './hik/cards.js';
import { normalizeUserInfoList, searchUsers } from './hik/users.js';
import { getSupabaseClient } from './supabase.js';

const PLACEHOLDER_SLOT_PATTERN = /^[A-Z]\d{1,2}$/;

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseDeviceTimestamp(value) {
  const normalizedValue = normalizeText(value);

  if (!normalizedValue) {
    return null;
  }

  const timestamp = new Date(normalizedValue);

  if (Number.isNaN(timestamp.getTime())) {
    return null;
  }

  return timestamp;
}

function buildPagedSearchEnvelope(searchKey, items, metadata) {
  return {
    items,
    totalMatches: getNumericField(
      metadata.totalMatches,
      metadata.searchResultPosition + metadata.numOfMatches
    ),
    shouldContinue: shouldContinuePagedSearch({
      responseStatus: metadata.responseStatusStrg,
      searchResultPosition: metadata.searchResultPosition,
      matchesOnPage: metadata.numOfMatches,
      totalMatches: getNumericField(
        metadata.totalMatches,
        metadata.searchResultPosition + metadata.numOfMatches
      ),
    }),
    searchKey,
  };
}

async function fetchAllUsers({ searchUsersFn, maxResults }) {
  const users = [];
  const searchID = `evolutionz-sync-users-${Date.now()}`;
  let searchResultPosition = 0;

  while (true) {
    const response = await searchUsersFn({
      searchID,
      searchResultPosition,
      maxResults,
    });
    const userInfoSearch = response?.UserInfoSearch;

    if (!userInfoSearch || typeof userInfoSearch !== 'object') {
      throw new Error('Device returned an unexpected user search response.');
    }

    const userInfoList = normalizeUserInfoList(userInfoSearch.UserInfo);
    const searchMetadata = normalizeSearchMetadata(userInfoSearch, userInfoList.length);
    const page = buildPagedSearchEnvelope('UserInfoSearch', userInfoList, {
      ...searchMetadata,
      searchResultPosition,
    });

    users.push(...page.items);

    if (!page.shouldContinue) {
      break;
    }

    searchResultPosition += searchMetadata.numOfMatches;
  }

  return users;
}

async function fetchAllCards({ searchCardsFn, maxResults }) {
  const cards = [];
  const searchID = `evolutionz-sync-cards-${Date.now()}`;
  let searchResultPosition = 0;

  while (true) {
    const response = await searchCardsFn({
      searchID,
      searchResultPosition,
      maxResults,
    });
    const cardInfoSearch = response?.CardInfoSearch;

    if (!cardInfoSearch || typeof cardInfoSearch !== 'object') {
      throw new Error('Device returned an unexpected card search response.');
    }

    const cardInfoList = normalizeCardInfoList(cardInfoSearch.CardInfo);
    const searchMetadata = normalizeSearchMetadata(cardInfoSearch, cardInfoList.length);
    const page = buildPagedSearchEnvelope('CardInfoSearch', cardInfoList, {
      ...searchMetadata,
      searchResultPosition,
    });

    cards.push(...page.items);

    if (!page.shouldContinue) {
      break;
    }

    searchResultPosition += searchMetadata.numOfMatches;
  }

  return cards;
}

function isPlaceholderName(name) {
  return PLACEHOLDER_SLOT_PATTERN.test(name);
}

function normalizeMemberValidity(valid, now) {
  const expiryDate = parseDeviceTimestamp(valid?.endTime);

  if (!toBoolean(valid?.enable, false) || !expiryDate || expiryDate.getTime() < now.getTime()) {
    return {
      status: 'Expired',
      expiry: expiryDate ? expiryDate.toISOString() : null,
    };
  }

  return {
    status: 'Active',
    expiry: expiryDate.toISOString(),
  };
}

function shouldReplaceUserRecord(existingRecord, nextRecord) {
  if (!existingRecord) {
    return true;
  }

  if (existingRecord.isPlaceholder && !nextRecord.isPlaceholder) {
    return true;
  }

  if (!existingRecord.name && nextRecord.name) {
    return true;
  }

  return false;
}

function upsertCardRow(cardsByNumber, nextCardRow) {
  const existingCardRow = cardsByNumber.get(nextCardRow.card_no);

  if (!existingCardRow) {
    cardsByNumber.set(nextCardRow.card_no, nextCardRow);
    return;
  }

  if (existingCardRow.status === 'available' && nextCardRow.status === 'assigned') {
    cardsByNumber.set(nextCardRow.card_no, nextCardRow);
  }
}

async function insertMembers(supabase, members) {
  if (members.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from('members')
    .upsert(members, {
      onConflict: 'employee_no',
      ignoreDuplicates: true,
    })
    .select('employee_no');

  if (error) {
    throw new Error(`Failed to sync members into Supabase: ${error.message}`);
  }

  return Array.isArray(data) ? data : [];
}

async function insertCards(supabase, cards) {
  if (cards.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from('cards')
    .upsert(cards, {
      onConflict: 'card_no',
      ignoreDuplicates: true,
    })
    .select('card_no');

  if (error) {
    throw new Error(`Failed to sync cards into Supabase: ${error.message}`);
  }

  return Array.isArray(data) ? data : [];
}

export async function syncAllMembers({
  maxResults = SEARCH_PAGE_SIZE,
  now = new Date(),
  searchUsersFn = searchUsers,
  searchCardsFn = searchCards,
  supabase = getSupabaseClient(),
} = {}) {
  const users = await fetchAllUsers({ searchUsersFn, maxResults });
  const cards = await fetchAllCards({ searchCardsFn, maxResults });

  const usersByCanonicalEmployeeNo = new Map();
  const primaryCardByCanonicalEmployeeNo = new Map();
  const cardsByNumber = new Map();

  for (const userInfo of users) {
    const employeeNo = normalizeText(userInfo?.employeeNo);
    const canonicalEmployeeNo = canonicalizeEmployeeNo(employeeNo);

    if (!employeeNo || !canonicalEmployeeNo) {
      continue;
    }

    const name = normalizeText(userInfo?.name);
    const userRecord = {
      canonicalEmployeeNo,
      employeeNo,
      name,
      isPlaceholder: isPlaceholderName(name),
      ...normalizeMemberValidity(userInfo?.Valid, now),
    };

    if (shouldReplaceUserRecord(usersByCanonicalEmployeeNo.get(canonicalEmployeeNo), userRecord)) {
      usersByCanonicalEmployeeNo.set(canonicalEmployeeNo, userRecord);
    }
  }

  for (const cardInfo of cards) {
    const cardNo = normalizeText(cardInfo?.cardNo);

    if (!cardNo) {
      continue;
    }

    const rawEmployeeNo = normalizeText(cardInfo?.employeeNo);
    const canonicalEmployeeNo = canonicalizeEmployeeNo(rawEmployeeNo);
    const matchedUser =
      canonicalEmployeeNo ? usersByCanonicalEmployeeNo.get(canonicalEmployeeNo) ?? null : null;

    if (matchedUser && !matchedUser.isPlaceholder) {
      const currentPrimaryCardNo = primaryCardByCanonicalEmployeeNo.get(canonicalEmployeeNo);

      if (!currentPrimaryCardNo || cardNo.localeCompare(currentPrimaryCardNo) < 0) {
        primaryCardByCanonicalEmployeeNo.set(canonicalEmployeeNo, cardNo);
      }
    }

    upsertCardRow(
      cardsByNumber,
      matchedUser && !matchedUser.isPlaceholder
        ? {
            card_no: cardNo,
            employee_no: matchedUser.employeeNo,
            status: 'assigned',
          }
        : {
            card_no: cardNo,
            employee_no: null,
            status: 'available',
          }
    );
  }

  let placeholderSlotsSkipped = 0;
  const members = [];

  for (const userRecord of usersByCanonicalEmployeeNo.values()) {
    if (userRecord.isPlaceholder) {
      placeholderSlotsSkipped += 1;
      continue;
    }

    members.push({
      employee_no: userRecord.employeeNo,
      name: userRecord.name || userRecord.employeeNo,
      card_no: primaryCardByCanonicalEmployeeNo.get(userRecord.canonicalEmployeeNo) ?? null,
      type: 'General',
      status: userRecord.status,
      expiry: userRecord.expiry,
      balance: 0,
    });
  }

  const insertedMembers = await insertMembers(supabase, members);
  const insertedCards = await insertCards(supabase, Array.from(cardsByNumber.values()));

  return {
    membersImported: insertedMembers.length,
    cardsImported: insertedCards.length,
    placeholderSlotsSkipped,
  };
}
