import { SEARCH_PAGE_SIZE, SLOT_TOKEN_PREFIX_PATTERN } from './hik/constants.js';
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

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function extractCardCode(name) {
  const normalizedName = normalizeText(name);
  const match = normalizedName.match(SLOT_TOKEN_PREFIX_PATTERN);

  return match?.[1] ? match[1].toUpperCase() : null;
}

function stripCardCodePrefix(name) {
  const normalizedName = normalizeText(name);
  const cardCode = extractCardCode(normalizedName);

  if (!cardCode) {
    return normalizedName;
  }

  return normalizeText(normalizedName.slice(cardCode.length));
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
  const searchID = '1';
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
  const searchID = '1';
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

    console.info('[hik] syncAllMembers card page trace', {
      searchResultPosition,
      pageCardCount: page.items.length,
      totalCardsSoFar: cards.length,
      containsTargetCardInPage: page.items.some(
        (card) => String(card?.cardNo ?? '').trim() === '3582702940'
      ),
      shouldContinue: page.shouldContinue,
      responseStatusStrg: searchMetadata.responseStatusStrg,
    });

    if (!page.shouldContinue) {
      break;
    }

    searchResultPosition += searchMetadata.numOfMatches;
  }

  return cards;
}

function isPlaceholderName(name) {
  const normalizedName = normalizeText(name);
  const cardCode = extractCardCode(normalizedName);

  return !!cardCode && normalizedName.toUpperCase() === cardCode;
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
    return;
  }

  if (!existingCardRow.card_code && nextCardRow.card_code) {
    cardsByNumber.set(nextCardRow.card_no, {
      ...existingCardRow,
      card_code: nextCardRow.card_code,
    });
  }
}

async function insertMembers(supabase, members) {
  if (members.length === 0) {
    return [];
  }

  const employeeNos = members.map((member) => member.employee_no);
  const membersByEmployeeNo = new Map(members.map((member) => [member.employee_no, member]));
  const { data: existingMembers, error: existingMembersError } = await supabase
    .from('members')
    .select('employee_no, name')
    .in('employee_no', employeeNos);

  if (existingMembersError) {
    throw new Error(`Failed to read existing members from Supabase: ${existingMembersError.message}`);
  }

  const existingMembersByEmployeeNo = new Map(
    (Array.isArray(existingMembers) ? existingMembers : []).map((member) => [
      normalizeText(member.employee_no),
      normalizeText(member.name),
    ])
  );
  const newMembers = members.filter((member) => !existingMembersByEmployeeNo.has(member.employee_no));
  let insertedRows = [];

  if (newMembers.length > 0) {
    const { data, error } = await supabase
      .from('members')
      .upsert(newMembers, {
        onConflict: 'employee_no',
        ignoreDuplicates: true,
      })
      .select('employee_no');

    if (error) {
      throw new Error(`Failed to sync members into Supabase: ${error.message}`);
    }

    insertedRows = Array.isArray(data) ? data : [];
  }

  const updatedRows = [];
  const updatedAt = new Date().toISOString();

  for (const [employeeNo, existingName] of existingMembersByEmployeeNo.entries()) {
    const incomingMember = membersByEmployeeNo.get(employeeNo);

    if (!incomingMember || !existingName || existingName === incomingMember.name) {
      continue;
    }

    if (stripCardCodePrefix(existingName) !== incomingMember.name) {
      continue;
    }

    const { data, error } = await supabase
      .from('members')
      .update({
        name: incomingMember.name,
        updated_at: updatedAt,
      })
      .eq('employee_no', employeeNo)
      .select('employee_no');

    if (error) {
      throw new Error(`Failed to normalize member names in Supabase: ${error.message}`);
    }

    if (Array.isArray(data)) {
      updatedRows.push(...data);
    }
  }

  return [...insertedRows, ...updatedRows];
}

async function insertCards(supabase, cards) {
  if (cards.length === 0) {
    return [];
  }

  const cardNos = cards.map((card) => card.card_no);
  const cardsByNumber = new Map(cards.map((card) => [card.card_no, card]));
  const { data: existingCards, error: existingCardsError } = await supabase
    .from('cards')
    .select('card_no, card_code')
    .in('card_no', cardNos);

  if (existingCardsError) {
    throw new Error(`Failed to read existing cards from Supabase: ${existingCardsError.message}`);
  }

  const existingCardsByNumber = new Map(
    (Array.isArray(existingCards) ? existingCards : []).map((card) => [
      normalizeText(card.card_no),
      {
        card_no: normalizeText(card.card_no),
        card_code: normalizeText(card.card_code) || null,
      },
    ])
  );
  const newCards = cards.filter((card) => !existingCardsByNumber.has(card.card_no));
  let insertedRows = [];

  if (newCards.length > 0) {
    const { data, error } = await supabase
      .from('cards')
      .upsert(newCards, {
        onConflict: 'card_no',
        ignoreDuplicates: true,
      })
      .select('card_no');

    if (error) {
      throw new Error(`Failed to insert new cards into Supabase: ${error.message}`);
    }

    insertedRows = Array.isArray(data) ? data : [];
  }

  const updatedRows = [];
  const updatedAt = new Date().toISOString();

  for (const [cardNo, existingCard] of existingCardsByNumber.entries()) {
    const incomingCard = cardsByNumber.get(cardNo);
    const incomingCardCode = normalizeText(incomingCard?.card_code) || null;

    if (existingCard.card_code || !incomingCardCode) {
      continue;
    }

    const { data, error } = await supabase
      .from('cards')
      .update({
        card_code: incomingCardCode,
        updated_at: updatedAt,
      })
      .eq('card_no', cardNo)
      .is('card_code', null)
      .select('card_no');

    if (error) {
      throw new Error(`Failed to backfill card codes into Supabase: ${error.message}`);
    }

    if (Array.isArray(data)) {
      updatedRows.push(...data);
    }
  }

  return [...insertedRows, ...updatedRows];
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

  const placeholderUsersByCanonicalEmployeeNo = new Map();
  const membersByCanonicalEmployeeNo = new Map();
  const primaryCardByCanonicalEmployeeNo = new Map();
  const cardsByNumber = new Map();

  for (const userInfo of users) {
    const employeeNo = normalizeText(userInfo?.employeeNo);
    const canonicalEmployeeNo = canonicalizeEmployeeNo(employeeNo);

    if (!employeeNo || !canonicalEmployeeNo) {
      continue;
    }

    const name = normalizeText(userInfo?.name);
    const cardCode = extractCardCode(name);
    const isPlaceholder = isPlaceholderName(name);

    if (isPlaceholder) {
      const placeholderRecord = {
        canonicalEmployeeNo,
        employeeNo,
        name,
        cardCode,
        isPlaceholder: true,
      };

      if (
        shouldReplaceUserRecord(
          placeholderUsersByCanonicalEmployeeNo.get(canonicalEmployeeNo),
          placeholderRecord
        )
      ) {
        placeholderUsersByCanonicalEmployeeNo.set(canonicalEmployeeNo, placeholderRecord);
      }

      continue;
    }

    const memberRecord = {
      canonicalEmployeeNo,
      employeeNo,
      name: stripCardCodePrefix(name) || employeeNo,
      cardCode,
      isPlaceholder: false,
      ...normalizeMemberValidity(userInfo?.Valid, now),
    };

    if (shouldReplaceUserRecord(membersByCanonicalEmployeeNo.get(canonicalEmployeeNo), memberRecord)) {
      membersByCanonicalEmployeeNo.set(canonicalEmployeeNo, memberRecord);
    }
  }

  for (const cardInfo of cards) {
    const cardNo = normalizeText(cardInfo?.cardNo);

    if (!cardNo) {
      continue;
    }

    const rawEmployeeNo = normalizeText(cardInfo?.employeeNo);
    const canonicalEmployeeNo = canonicalizeEmployeeNo(rawEmployeeNo);
    const matchedPlaceholderUser =
      canonicalEmployeeNo
        ? placeholderUsersByCanonicalEmployeeNo.get(canonicalEmployeeNo) ?? null
        : null;
    const matchedMember =
      canonicalEmployeeNo ? membersByCanonicalEmployeeNo.get(canonicalEmployeeNo) ?? null : null;

    if (matchedMember) {
      const currentPrimaryCardNo = primaryCardByCanonicalEmployeeNo.get(canonicalEmployeeNo);

      if (!currentPrimaryCardNo || cardNo.localeCompare(currentPrimaryCardNo) < 0) {
        primaryCardByCanonicalEmployeeNo.set(canonicalEmployeeNo, cardNo);
      }
    }

    upsertCardRow(
      cardsByNumber,
      matchedPlaceholderUser
        ? {
            card_no: cardNo,
            employee_no: null,
            status: 'available',
            card_code: matchedPlaceholderUser.cardCode ?? null,
          }
        : matchedMember
        ? {
            card_no: cardNo,
            employee_no: matchedMember.employeeNo,
            status: 'assigned',
            card_code: matchedMember.cardCode ?? null,
          }
        : {
            card_no: cardNo,
            employee_no: null,
            status: 'available',
            card_code: null,
          }
    );
  }

  let placeholderSlotsSkipped = 0;
  const members = [];

  placeholderSlotsSkipped = placeholderUsersByCanonicalEmployeeNo.size;

  for (const userRecord of membersByCanonicalEmployeeNo.values()) {
    members.push({
      employee_no: userRecord.employeeNo,
      name: userRecord.name || userRecord.employeeNo,
      card_no: primaryCardByCanonicalEmployeeNo.get(userRecord.canonicalEmployeeNo) ?? null,
      type: 'General',
      status: userRecord.status,
      end_time: userRecord.expiry,
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
