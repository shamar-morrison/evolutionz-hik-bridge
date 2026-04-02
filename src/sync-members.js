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

function normalizeNullableText(value) {
  const normalizedValue = normalizeText(value);
  return normalizedValue || null;
}

function normalizeMemberGender(value) {
  const normalizedValue = normalizeText(value).toLowerCase();

  if (normalizedValue === 'male') {
    return 'Male';
  }

  if (normalizedValue === 'female') {
    return 'Female';
  }

  return null;
}

function getFirstNormalizedAlias(source, keys) {
  for (const key of keys) {
    const value = normalizeNullableText(source?.[key]);

    if (value) {
      return value;
    }
  }

  return null;
}

function extractMemberProfile(userInfo) {
  return {
    gender: normalizeMemberGender(getFirstNormalizedAlias(userInfo, ['gender', 'sex'])),
    phone: getFirstNormalizedAlias(userInfo, ['phoneNo', 'Tel', 'tel', 'phone', 'phoneNumber']),
    email: getFirstNormalizedAlias(userInfo, ['email', 'Email']),
    remark: getFirstNormalizedAlias(userInfo, ['remark', 'Remark']),
  };
}

function resolveProfileFieldValue(existingValue, nextValue) {
  return normalizeNullableText(nextValue) ?? normalizeNullableText(existingValue);
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

export async function fetchAllUsers({ searchUsersFn, maxResults }) {
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
  const beginDate = parseDeviceTimestamp(valid?.beginTime);
  const expiryDate = parseDeviceTimestamp(valid?.endTime);

  if (!toBoolean(valid?.enable, false) || !expiryDate || expiryDate.getTime() < now.getTime()) {
    return {
      status: 'Expired',
      begin_time: beginDate ? beginDate.toISOString() : null,
      end_time: expiryDate ? expiryDate.toISOString() : null,
    };
  }

  return {
    status: 'Active',
    begin_time: beginDate ? beginDate.toISOString() : null,
    end_time: expiryDate.toISOString(),
  };
}

function shouldReplaceMemberRecord(existingRecord, nextRecord) {
  if (!existingRecord) {
    return true;
  }

  if (!existingRecord.name && nextRecord.name) {
    return true;
  }

  return false;
}

function resolveMemberName(existingName, nextName) {
  const normalizedExistingName = normalizeText(existingName);

  if (!normalizedExistingName || normalizedExistingName === nextName) {
    return nextName;
  }

  if (stripCardCodePrefix(normalizedExistingName) === nextName) {
    return nextName;
  }

  return normalizedExistingName;
}

function buildSyncedMemberRow(existingMember, incomingMember) {
  const nextName = resolveMemberName(existingMember?.name, incomingMember.name);
  const nextBeginTime = resolveProfileFieldValue(existingMember?.begin_time, incomingMember.begin_time);
  const nextEndTime = resolveProfileFieldValue(existingMember?.end_time, incomingMember.end_time);
  const nextGender = resolveProfileFieldValue(existingMember?.gender, incomingMember.gender);
  const nextPhone = resolveProfileFieldValue(existingMember?.phone, incomingMember.phone);
  const nextEmail = resolveProfileFieldValue(existingMember?.email, incomingMember.email);
  const nextRemark = resolveProfileFieldValue(existingMember?.remark, incomingMember.remark);

  return {
    employee_no: incomingMember.employee_no,
    name: nextName,
    card_no: incomingMember.card_no,
    type: normalizeText(existingMember?.type) || incomingMember.type,
    status: incomingMember.status,
    ...(nextBeginTime ? { begin_time: nextBeginTime } : {}),
    ...(nextEndTime ? { end_time: nextEndTime } : {}),
    ...(nextGender ? { gender: nextGender } : {}),
    ...(nextPhone ? { phone: nextPhone } : {}),
    ...(nextEmail ? { email: nextEmail } : {}),
    ...(nextRemark ? { remark: nextRemark } : {}),
  };
}

function hasMemberRowChanged(existingMember, nextMemberRow) {
  if (!existingMember) {
    return true;
  }

  return (
    normalizeText(existingMember.name) !== normalizeText(nextMemberRow.name) ||
    normalizeText(existingMember.card_no) !== normalizeText(nextMemberRow.card_no) ||
    normalizeText(existingMember.type) !== normalizeText(nextMemberRow.type) ||
    normalizeText(existingMember.status) !== normalizeText(nextMemberRow.status) ||
    normalizeNullableText(existingMember.begin_time) !== normalizeNullableText(nextMemberRow.begin_time) ||
    normalizeNullableText(existingMember.end_time) !== normalizeNullableText(nextMemberRow.end_time) ||
    normalizeNullableText(existingMember.gender) !== normalizeNullableText(nextMemberRow.gender) ||
    normalizeNullableText(existingMember.phone) !== normalizeNullableText(nextMemberRow.phone) ||
    normalizeNullableText(existingMember.email) !== normalizeNullableText(nextMemberRow.email) ||
    normalizeNullableText(existingMember.remark) !== normalizeNullableText(nextMemberRow.remark)
  );
}

async function insertMembers(supabase, members) {
  if (members.length === 0) {
    return { membersAdded: 0, membersUpdated: 0 };
  }

  const employeeNos = members.map((member) => member.employee_no);
  const { data: existingMembers, error: existingMembersError } = await supabase
    .from('members')
    .select('employee_no, name, card_no, type, status, begin_time, end_time, gender, phone, email, remark')
    .in('employee_no', employeeNos);

  if (existingMembersError) {
    throw new Error(`Failed to read existing members from Supabase: ${existingMembersError.message}`);
  }

  const existingMembersByEmployeeNo = new Map(
    (Array.isArray(existingMembers) ? existingMembers : []).map((member) => [
      normalizeText(member.employee_no),
      {
        employee_no: normalizeText(member.employee_no),
        name: normalizeText(member.name),
        card_no: normalizeNullableText(member.card_no),
        type: normalizeText(member.type),
        status: normalizeText(member.status),
        begin_time: normalizeNullableText(member.begin_time),
        end_time: normalizeNullableText(member.end_time),
        gender: normalizeNullableText(member.gender),
        phone: normalizeNullableText(member.phone),
        email: normalizeNullableText(member.email),
        remark: normalizeNullableText(member.remark),
      },
    ])
  );
  const upsertMembers = [];
  let membersAdded = 0;
  let membersUpdated = 0;

  for (const member of members) {
    const existingMember = existingMembersByEmployeeNo.get(member.employee_no);
    const nextMemberRow = buildSyncedMemberRow(existingMember, member);

    if (!existingMember) {
      membersAdded += 1;
      upsertMembers.push(nextMemberRow);
      continue;
    }

    if (!hasMemberRowChanged(existingMember, nextMemberRow)) {
      continue;
    }

    membersUpdated += 1;
    upsertMembers.push(nextMemberRow);
  }

  if (upsertMembers.length === 0) {
    return { membersAdded: 0, membersUpdated: 0 };
  }

  const { error } = await supabase
    .from('members')
    .upsert(upsertMembers, {
      onConflict: 'employee_no',
      ignoreDuplicates: false,
    })
    .select('employee_no');

  if (error) {
    throw new Error(`Failed to sync members into Supabase: ${error.message}`);
  }

  return { membersAdded, membersUpdated };
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

  const membersByCanonicalEmployeeNo = new Map();
  const primaryCardByCanonicalEmployeeNo = new Map();

  for (const userInfo of users) {
    const employeeNo = normalizeText(userInfo?.employeeNo);
    const canonicalEmployeeNo = canonicalizeEmployeeNo(employeeNo);

    if (!employeeNo || !canonicalEmployeeNo) {
      continue;
    }

    const name = normalizeText(userInfo?.name);

    if (isPlaceholderName(name)) {
      continue;
    }

    const memberRecord = {
      canonicalEmployeeNo,
      employeeNo,
      name: stripCardCodePrefix(name) || employeeNo,
      ...extractMemberProfile(userInfo),
      ...normalizeMemberValidity(userInfo?.Valid, now),
    };

    if (
      shouldReplaceMemberRecord(
        membersByCanonicalEmployeeNo.get(canonicalEmployeeNo),
        memberRecord
      )
    ) {
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
    const matchedMember =
      canonicalEmployeeNo ? membersByCanonicalEmployeeNo.get(canonicalEmployeeNo) ?? null : null;

    if (!matchedMember) {
      continue;
    }

    const currentPrimaryCardNo = primaryCardByCanonicalEmployeeNo.get(canonicalEmployeeNo);

    if (!currentPrimaryCardNo || cardNo.localeCompare(currentPrimaryCardNo) < 0) {
      primaryCardByCanonicalEmployeeNo.set(canonicalEmployeeNo, cardNo);
    }
  }

  const members = [];

  for (const userRecord of membersByCanonicalEmployeeNo.values()) {
    members.push({
      employee_no: userRecord.employeeNo,
      name: userRecord.name || userRecord.employeeNo,
      card_no: primaryCardByCanonicalEmployeeNo.get(userRecord.canonicalEmployeeNo) ?? null,
      type: 'General',
      status: userRecord.status,
      ...(userRecord.begin_time ? { begin_time: userRecord.begin_time } : {}),
      ...(userRecord.end_time ? { end_time: userRecord.end_time } : {}),
      ...(userRecord.gender ? { gender: userRecord.gender } : {}),
      ...(userRecord.phone ? { phone: userRecord.phone } : {}),
      ...(userRecord.email ? { email: userRecord.email } : {}),
      ...(userRecord.remark ? { remark: userRecord.remark } : {}),
    });
  }

  return await insertMembers(supabase, members);
}
