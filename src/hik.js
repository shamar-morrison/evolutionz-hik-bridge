// src/hik.js
// Wrapper for HiKVision ISAPI endpoints using Digest Authentication

import DigestFetch from 'digest-fetch';
import { parseStringPromise } from 'xml2js';

const BASE_URL = `http://${process.env.HIK_IP}:${process.env.HIK_PORT}`;
const DIGEST_RETRY_ATTEMPTS = 2;
const AUTH_DEBUG_ENABLED = process.env.HIK_DEBUG_AUTH === '1';
const REMOTE_CONTROL_PASSWORD_PATTERN = /^\d{6}$/;
const SEARCH_PAGE_SIZE = 30;
const DEFAULT_PLACEHOLDER_SLOT_PATTERN = '^[A-Z]\\d{2}$';
const DEFAULT_RESET_SLOT_END_TIME = '2037-12-31T23:59:59';
const AVAILABLE_SLOT_DEBUG_SAMPLE_LIMIT = 10;
const VALIDITY_DROP_REASONS = [
  'missingValid',
  'disabled',
  'invalidBeginTime',
  'futureBeginTime',
  'missingEndTime',
  'invalidEndTime',
  'expiredEndTime',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createDigestClient() {
  return new DigestFetch(
    process.env.HIK_USERNAME,
    process.env.HIK_PASSWORD
  );
}

function buildUrl(path) {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }

  return `${BASE_URL}${path}`;
}

function cloneHeaders(headers) {
  if (!headers) {
    return undefined;
  }

  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return new Headers(headers);
  }

  if (Array.isArray(headers)) {
    return new Headers(headers);
  }

  return { ...headers };
}

function cloneRequestOptions(init = {}) {
  const nextOptions = { ...init };

  if (init.headers) {
    nextOptions.headers = cloneHeaders(init.headers);
  }

  return nextOptions;
}

function getRequestMethod(init = {}) {
  return (init.method ?? 'GET').toUpperCase();
}

function describeRequest(path, init = {}) {
  return `${getRequestMethod(init)} ${path}`;
}

function logAuthDebug(message, res, attempt) {
  if (!AUTH_DEBUG_ENABLED) {
    return;
  }

  const challenge = res.headers.get('www-authenticate');
  const challengeSuffix = challenge ? ` challenge=${challenge}` : '';

  console.warn(
    `[hik] ${message} attempt=${attempt} status=${res.status}${challengeSuffix}`
  );
}

async function requestIsapi(path, init = {}) {
  const url = buildUrl(path);
  const requestDescription = describeRequest(path, init);

  for (let attempt = 1; attempt <= DIGEST_RETRY_ATTEMPTS; attempt += 1) {
    const client = createDigestClient();
    const res = await client.fetch(url, cloneRequestOptions(init));

    if (res.status !== 401) {
      return res;
    }

    logAuthDebug('Digest auth request returned 401', res, attempt);

    if (attempt === DIGEST_RETRY_ATTEMPTS) {
      const challenge = res.headers.get('www-authenticate');
      const text = await res.text();
      const challengeSuffix = challenge ? '' : ' without a digest challenge';
      throw new Error(
        `Device returned ${res.status} for ${requestDescription}${challengeSuffix}: ${text}`
      );
    }
  }

  throw new Error('Device request failed before receiving a response');
}

function getRemoteDoorPassword() {
  const remotePassword = process.env.HIK_REMOTE_PASSWORD?.trim();

  if (!REMOTE_CONTROL_PASSWORD_PATTERN.test(remotePassword ?? '')) {
    const message = 'Bridge misconfiguration: HIK_REMOTE_PASSWORD must be set to a 6-digit code for unlock_door';
    console.error(`[hik] ${message}`);
    throw new Error(message);
  }

  return remotePassword;
}

function buildUnlockDoorBody(remotePassword) {
  return `<?xml version="1.0" encoding="UTF-8"?><RemoteControlDoor version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><cmd>open</cmd><remotePassword>${remotePassword}</remotePassword></RemoteControlDoor>`;
}

function toNumberIfNumeric(value) {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();

  if (trimmed === '' || Number.isNaN(Number(trimmed))) {
    return value;
  }

  return Number(trimmed);
}

function toBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();

    if (normalized === 'true' || normalized === '1') {
      return true;
    }

    if (normalized === 'false' || normalized === '0') {
      return false;
    }
  }

  return fallback;
}

function normalizeList(value) {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatDatePart(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function getPlaceholderSlotPattern() {
  const rawPattern = process.env.HIK_PLACEHOLDER_SLOT_PATTERN?.trim();

  if (!rawPattern) {
    return new RegExp(DEFAULT_PLACEHOLDER_SLOT_PATTERN);
  }

  try {
    return new RegExp(rawPattern);
  } catch {
    console.warn(
      `[hik] Invalid HIK_PLACEHOLDER_SLOT_PATTERN="${rawPattern}". Falling back to ${DEFAULT_PLACEHOLDER_SLOT_PATTERN}.`
    );
    return new RegExp(DEFAULT_PLACEHOLDER_SLOT_PATTERN);
  }
}

function getResetSlotEndTime() {
  return process.env.HIK_RESET_SLOT_END_TIME?.trim() || DEFAULT_RESET_SLOT_END_TIME;
}

function isAvailableSlotsDebugEnabled() {
  return process.env.HIK_DEBUG_AVAILABLE_SLOTS === '1';
}

function createInvalidValidityDiagnostics() {
  return {
    total: 0,
    missingValid: 0,
    disabled: 0,
    invalidBeginTime: 0,
    futureBeginTime: 0,
    missingEndTime: 0,
    invalidEndTime: 0,
    expiredEndTime: 0,
  };
}

function analyzeUserValidity(userInfo, now = new Date()) {
  const valid = userInfo?.Valid;
  const hasValidObject = !!valid && typeof valid === 'object';
  const beginTime =
    hasValidObject && typeof valid.beginTime === 'string' ? valid.beginTime.trim() : '';
  const endTime =
    hasValidObject && typeof valid.endTime === 'string' ? valid.endTime.trim() : '';
  const beginTimestamp = beginTime ? Date.parse(beginTime) : null;
  const endTimestamp = endTime ? Date.parse(endTime) : null;
  const normalizedValidity = {
    hasValidObject,
    enableRaw: hasValidObject ? valid.enable ?? null : null,
    enable: hasValidObject ? toBoolean(valid.enable, false) : false,
    beginTime,
    beginTimestamp: Number.isNaN(beginTimestamp) ? null : beginTimestamp,
    endTime,
    endTimestamp: Number.isNaN(endTimestamp) ? null : endTimestamp,
    nowTimestamp: now.getTime(),
  };

  if (!hasValidObject) {
    return {
      isValid: false,
      reason: 'missingValid',
      rawValid: valid ?? null,
      normalizedValidity,
    };
  }

  if (!normalizedValidity.enable) {
    return {
      isValid: false,
      reason: 'disabled',
      rawValid: valid,
      normalizedValidity,
    };
  }

  if (beginTime) {
    if (normalizedValidity.beginTimestamp === null) {
      return {
        isValid: false,
        reason: 'invalidBeginTime',
        rawValid: valid,
        normalizedValidity,
      };
    }

    if (normalizedValidity.beginTimestamp > normalizedValidity.nowTimestamp) {
      return {
        isValid: false,
        reason: 'futureBeginTime',
        rawValid: valid,
        normalizedValidity,
      };
    }
  }

  if (!endTime) {
    return {
      isValid: false,
      reason: 'missingEndTime',
      rawValid: valid,
      normalizedValidity,
    };
  }

  if (normalizedValidity.endTimestamp === null) {
    return {
      isValid: false,
      reason: 'invalidEndTime',
      rawValid: valid,
      normalizedValidity,
    };
  }

  if (normalizedValidity.endTimestamp < normalizedValidity.nowTimestamp) {
    return {
      isValid: false,
      reason: 'expiredEndTime',
      rawValid: valid,
      normalizedValidity,
    };
  }

  return {
    isValid: true,
    reason: null,
    rawValid: valid,
    normalizedValidity,
  };
}

function recordInvalidValidity(invalidValidityDiagnostics, reason) {
  invalidValidityDiagnostics.total += 1;

  if (VALIDITY_DROP_REASONS.includes(reason)) {
    invalidValidityDiagnostics[reason] += 1;
  }
}

function addDroppedPlaceholderSample({
  droppedPlaceholderSamples,
  employeeNo,
  placeholderName,
  reason,
  rawValid,
  normalizedValidity,
}) {
  if (droppedPlaceholderSamples.samples.length >= AVAILABLE_SLOT_DEBUG_SAMPLE_LIMIT) {
    droppedPlaceholderSamples.omittedCount += 1;
    return;
  }

  droppedPlaceholderSamples.samples.push({
    reason,
    employeeNo,
    name: placeholderName,
    rawValid,
    normalizedValidity,
  });
}

function canonicalizeEmployeeNo(value) {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return '';
  }

  if (!/^\d+$/.test(trimmed)) {
    return trimmed;
  }

  const normalized = trimmed.replace(/^0+/, '');
  return normalized || '0';
}

function shouldContinuePagedSearch({
  responseStatus,
  searchResultPosition,
  matchesOnPage,
  totalMatches,
}) {
  if (matchesOnPage <= 0) {
    return false;
  }

  const normalizedStatus = String(responseStatus ?? 'OK').toUpperCase();

  if (normalizedStatus === 'MORE') {
    return true;
  }

  return searchResultPosition + matchesOnPage < totalMatches;
}

function normalizeResponseStatus(parsedXml) {
  const responseStatus = parsedXml?.ResponseStatus;

  if (!responseStatus || typeof responseStatus !== 'object') {
    return null;
  }

  const normalized = {
    ok: true,
    type: 'ResponseStatus',
  };

  const fields = [
    'requestURL',
    'statusCode',
    'statusString',
    'subStatusCode',
    'errorCode',
    'errorMsg',
  ];

  for (const field of fields) {
    if (responseStatus[field] === undefined || responseStatus[field] === '') {
      continue;
    }

    normalized[field] = field === 'statusCode' || field === 'errorCode'
      ? toNumberIfNumeric(responseStatus[field])
      : responseStatus[field];
  }

  return normalized;
}

async function parseResponse(res, path, init = {}) {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Device returned ${res.status} for ${describeRequest(path, init)}: ${text}`);
  }
  // Try JSON first, fall back to XML
  try {
    return JSON.parse(text);
  } catch {
    const parsedXml = await parseStringPromise(text, { explicitArray: false });
    return normalizeResponseStatus(parsedXml) ?? parsedXml;
  }
}

async function performIsapiRequest(path, init = {}) {
  const res = await requestIsapi(path, init);
  return await parseResponse(res, path, init);
}

function jsonHeaders() {
  return { 'Content-Type': 'application/json;charset=UTF-8' };
}

function xmlHeaders() {
  return { 'Content-Type': 'application/xml;charset=UTF-8' };
}

// ─── Door Control ─────────────────────────────────────────────────────────────

/**
 * Remotely unlock a door
 * @param {number} doorNo - Door number (usually 1)
 */
export async function unlockDoor(doorNo = 1) {
  const remotePassword = getRemoteDoorPassword();
  return await performIsapiRequest(`/ISAPI/AccessControl/RemoteControl/door/${doorNo}`, {
    method: 'PUT',
    headers: xmlHeaders(),
    body: buildUnlockDoorBody(remotePassword),
  });
}

// ─── User Management ──────────────────────────────────────────────────────────

/**
 * Add or update a user on the device
 * @param {object} user
 * @param {string} user.employeeNo  - Unique ID (use member's ID from Supabase)
 * @param {string} user.name        - Member's full name
 * @param {string} user.userType    - 'normal' | 'administrator'
 * @param {string} user.beginTime   - ISO date string e.g. '2026-01-01T00:00:00'
 * @param {string} user.endTime     - ISO date string e.g. '2027-01-01T00:00:00'
 */
export async function addUser({ employeeNo, name, userType = 'normal', beginTime, endTime }) {
  return await performIsapiRequest('/ISAPI/AccessControl/UserInfo/Modify?format=json', {
    method: 'PUT',
    headers: jsonHeaders(),
    body: JSON.stringify({
      UserInfo: {
        employeeNo: String(employeeNo),
        name,
        userType,
        Valid: {
          enable: true,
          beginTime,
          endTime,
        },
        doorRight: '1',
        RightPlan: [{ doorNo: 1, planTemplateNo: '1' }],
      },
    }),
  });
}

/**
 * Delete a user from the device entirely
 * @param {string} employeeNo - Member's ID
 */
export async function deleteUser(employeeNo) {
  return await performIsapiRequest('/ISAPI/AccessControl/UserInfo/Delete?format=json', {
    method: 'PUT',
    headers: jsonHeaders(),
    body: JSON.stringify({
      UserInfoDelCond: {
        EmployeeNoList: [{ employeeNo: String(employeeNo) }],
      },
    }),
  });
}

/**
 * Search for a user on the device
 * @param {string} employeeNo - Member's ID
 */
export async function getUser(employeeNo) {
  return await performIsapiRequest('/ISAPI/AccessControl/UserInfo/Search?format=json', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      UserInfoSearchCond: {
        searchID: '1',
        searchResultPosition: 0,
        maxResults: 1,
        EmployeeNoList: [{ employeeNo: String(employeeNo) }],
      },
    }),
  });
}

function normalizeUserInfoList(userInfo) {
  return normalizeList(userInfo);
}

async function searchUsers({
  searchID,
  searchResultPosition,
  maxResults = SEARCH_PAGE_SIZE,
}) {
  return await performIsapiRequest('/ISAPI/AccessControl/UserInfo/Search?format=json', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      UserInfoSearchCond: {
        searchID,
        searchResultPosition,
        maxResults,
      },
    }),
  });
}

// ─── Card Management ─────────────────────────────────────────────────────────

/**
 * Assign an existing card record to a user
 * @param {string} employeeNo - Member's ID
 * @param {string} cardNo     - The pre-created card number
 */
export async function addCard(employeeNo, cardNo) {
  return await performIsapiRequest('/ISAPI/AccessControl/CardInfo/Modify?format=json', {
    method: 'PUT',
    headers: jsonHeaders(),
    body: JSON.stringify({
      CardInfo: {
        employeeNo: String(employeeNo),
        cardNo: String(cardNo),
        cardType: 'normalCard',
      },
    }),
  });
}

/**
 * Revoke a card (removes it from the device — card will no longer grant access)
 * @param {string} employeeNo - Member's ID
 * @param {string} cardNo     - The card number to revoke
 */
export async function revokeCard(employeeNo, cardNo) {
  return await performIsapiRequest('/ISAPI/AccessControl/CardInfo/Delete?format=json', {
    method: 'PUT',
    headers: jsonHeaders(),
    body: JSON.stringify({
      CardInfoDelCond: {
        EmployeeNoList: [{ employeeNo: String(employeeNo) }],
      },
    }),
  });
}

/**
 * Look up card info for a user
 * @param {string} employeeNo - Member's ID
 */
export async function getCard(employeeNo) {
  return await performIsapiRequest('/ISAPI/AccessControl/CardInfo/Search?format=json', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      CardInfoSearchCond: {
        searchID: '1',
        searchResultPosition: 0,
        maxResults: 10,
        EmployeeNoList: [{ employeeNo: String(employeeNo) }],
      },
    }),
  });
}

function normalizeCardInfoList(cardInfo) {
  return normalizeList(cardInfo);
}

function getNumericField(value, fallback) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

async function searchCards({
  searchID,
  searchResultPosition,
  maxResults = SEARCH_PAGE_SIZE,
}) {
  return await performIsapiRequest('/ISAPI/AccessControl/CardInfo/Search?format=json', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      CardInfoSearchCond: {
        searchID,
        searchResultPosition,
        maxResults,
      },
    }),
  });
}

export async function listAvailableCards({ maxResults = SEARCH_PAGE_SIZE } = {}) {
  const cardsByNumber = new Map();
  const searchID = `evolutionz-${Date.now()}`;
  let searchResultPosition = 0;

  while (true) {
    const response = await searchCards({
      searchID,
      searchResultPosition,
      maxResults,
    });
    const cardInfoSearch = response?.CardInfoSearch;

    if (!cardInfoSearch || typeof cardInfoSearch !== 'object') {
      throw new Error('Device returned an unexpected card search response.');
    }

    const cardInfoList = normalizeCardInfoList(cardInfoSearch.CardInfo);

    for (const cardInfo of cardInfoList) {
      const cardNo = typeof cardInfo?.cardNo === 'string' ? cardInfo.cardNo.trim() : '';
      const employeeNo =
        typeof cardInfo?.employeeNo === 'string' ? cardInfo.employeeNo.trim() : '';

      if (!cardNo || employeeNo) {
        continue;
      }

      cardsByNumber.set(cardNo, { cardNo });
    }

    const responseStatus = String(cardInfoSearch.responseStatusStrg ?? 'OK').toUpperCase();
    const matchesOnPage = getNumericField(cardInfoSearch.numOfMatches, cardInfoList.length);

    if (responseStatus !== 'MORE' || matchesOnPage <= 0) {
      break;
    }

    searchResultPosition += matchesOnPage;
  }

  return {
    cards: Array.from(cardsByNumber.values()).sort((left, right) =>
      left.cardNo.localeCompare(right.cardNo)
    ),
  };
}

export async function listAvailableSlots({ maxResults = SEARCH_PAGE_SIZE, now = new Date() } = {}) {
  const placeholderPattern = getPlaceholderSlotPattern();
  const availableSlotsDebugEnabled = isAvailableSlotsDebugEnabled();
  const userSearchID = `evolutionz-users-${Date.now()}`;
  const cardSearchID = `evolutionz-cards-${Date.now()}`;
  const placeholderUsers = new Map();
  const cardsByEmployeeNo = new Map();
  const droppedPlaceholderSamples = {
    samples: [],
    omittedCount: 0,
  };
  const diagnostics = {
    userPages: 0,
    cardPages: 0,
    totalUsersScanned: 0,
    totalCardsScanned: 0,
    matchedPlaceholderUsers: 0,
    matchedJoinedSlots: 0,
    droppedUsers: {
      missingEmployeeNo: 0,
      missingPlaceholderName: 0,
      nonPlaceholderName: 0,
      invalidValidity: createInvalidValidityDiagnostics(),
    },
    droppedCards: {
      missingEmployeeNo: 0,
      missingCardNo: 0,
    },
    droppedSlots: {
      withoutCard: 0,
    },
  };
  let userSearchResultPosition = 0;
  let cardSearchResultPosition = 0;

  while (true) {
    const response = await searchUsers({
      searchID: userSearchID,
      searchResultPosition: userSearchResultPosition,
      maxResults,
    });
    const userInfoSearch = response?.UserInfoSearch;

    if (!userInfoSearch || typeof userInfoSearch !== 'object') {
      throw new Error('Device returned an unexpected user search response.');
    }

    const userInfoList = normalizeUserInfoList(userInfoSearch.UserInfo);
    diagnostics.userPages += 1;
    diagnostics.totalUsersScanned += userInfoList.length;

    for (const userInfo of userInfoList) {
      const employeeNo = typeof userInfo?.employeeNo === 'string' ? userInfo.employeeNo.trim() : '';
      const placeholderName = typeof userInfo?.name === 'string' ? userInfo.name.trim() : '';

      if (!employeeNo || !placeholderName) {
        if (!employeeNo) {
          diagnostics.droppedUsers.missingEmployeeNo += 1;
        }

        if (!placeholderName) {
          diagnostics.droppedUsers.missingPlaceholderName += 1;
        }

        continue;
      }

      if (!placeholderPattern.test(placeholderName)) {
        diagnostics.droppedUsers.nonPlaceholderName += 1;
        continue;
      }

      const validity = analyzeUserValidity(userInfo, now);

      if (!validity.isValid) {
        recordInvalidValidity(diagnostics.droppedUsers.invalidValidity, validity.reason);

        if (availableSlotsDebugEnabled) {
          addDroppedPlaceholderSample({
            droppedPlaceholderSamples,
            employeeNo,
            placeholderName,
            reason: validity.reason,
            rawValid: validity.rawValid,
            normalizedValidity: validity.normalizedValidity,
          });
        }

        continue;
      }

      const joinEmployeeNo = canonicalizeEmployeeNo(employeeNo);

      if (!joinEmployeeNo) {
        diagnostics.droppedUsers.missingEmployeeNo += 1;
        continue;
      }

      placeholderUsers.set(joinEmployeeNo, {
        employeeNo,
        joinEmployeeNo,
        placeholderName,
      });
    }

    const responseStatus = String(userInfoSearch.responseStatusStrg ?? 'OK').toUpperCase();
    const matchesOnPage = getNumericField(userInfoSearch.numOfMatches, userInfoList.length);
    const totalMatches = getNumericField(userInfoSearch.totalMatches, userSearchResultPosition + matchesOnPage);

    if (!shouldContinuePagedSearch({
      responseStatus,
      searchResultPosition: userSearchResultPosition,
      matchesOnPage,
      totalMatches,
    })) {
      break;
    }

    userSearchResultPosition += matchesOnPage;
  }

  diagnostics.matchedPlaceholderUsers = placeholderUsers.size;

  while (true) {
    const response = await searchCards({
      searchID: cardSearchID,
      searchResultPosition: cardSearchResultPosition,
      maxResults,
    });
    const cardInfoSearch = response?.CardInfoSearch;

    if (!cardInfoSearch || typeof cardInfoSearch !== 'object') {
      throw new Error('Device returned an unexpected card search response.');
    }

    const cardInfoList = normalizeCardInfoList(cardInfoSearch.CardInfo);
    diagnostics.cardPages += 1;
    diagnostics.totalCardsScanned += cardInfoList.length;

    for (const cardInfo of cardInfoList) {
      const employeeNo = typeof cardInfo?.employeeNo === 'string' ? cardInfo.employeeNo.trim() : '';
      const cardNo = typeof cardInfo?.cardNo === 'string' ? cardInfo.cardNo.trim() : '';

      if (!employeeNo || !cardNo) {
        if (!employeeNo) {
          diagnostics.droppedCards.missingEmployeeNo += 1;
        }

        if (!cardNo) {
          diagnostics.droppedCards.missingCardNo += 1;
        }

        continue;
      }

      const joinEmployeeNo = canonicalizeEmployeeNo(employeeNo);

      if (!joinEmployeeNo) {
        diagnostics.droppedCards.missingEmployeeNo += 1;
        continue;
      }

      const existingCardNo = cardsByEmployeeNo.get(joinEmployeeNo);

      if (!existingCardNo || cardNo.localeCompare(existingCardNo) < 0) {
        cardsByEmployeeNo.set(joinEmployeeNo, cardNo);
      }
    }

    const responseStatus = String(cardInfoSearch.responseStatusStrg ?? 'OK').toUpperCase();
    const matchesOnPage = getNumericField(cardInfoSearch.numOfMatches, cardInfoList.length);
    const totalMatches = getNumericField(cardInfoSearch.totalMatches, cardSearchResultPosition + matchesOnPage);

    if (!shouldContinuePagedSearch({
      responseStatus,
      searchResultPosition: cardSearchResultPosition,
      matchesOnPage,
      totalMatches,
    })) {
      break;
    }

    cardSearchResultPosition += matchesOnPage;
  }

  const slots = Array.from(placeholderUsers.values())
    .map((user) => {
      const cardNo = cardsByEmployeeNo.get(user.joinEmployeeNo);

      if (!cardNo) {
        diagnostics.droppedSlots.withoutCard += 1;
        return null;
      }

      return {
        employeeNo: user.employeeNo,
        cardNo,
        placeholderName: user.placeholderName,
      };
    })
    .filter(Boolean)
    .sort((left, right) =>
      left.placeholderName.localeCompare(right.placeholderName) ||
      left.cardNo.localeCompare(right.cardNo)
    );

  diagnostics.matchedJoinedSlots = slots.length;

  console.info('[hik] listAvailableSlots diagnostics', diagnostics);

  if (availableSlotsDebugEnabled) {
    console.info('[hik] listAvailableSlots dropped placeholder samples', {
      sampleLimit: AVAILABLE_SLOT_DEBUG_SAMPLE_LIMIT,
      sampledCount: droppedPlaceholderSamples.samples.length,
      omittedCount: droppedPlaceholderSamples.omittedCount,
      samples: droppedPlaceholderSamples.samples,
    });
  }

  return {
    slots,
    diagnostics,
  };
}

export async function resetSlot({ employeeNo, placeholderName, now = new Date() }) {
  return await addUser({
    employeeNo,
    name: placeholderName,
    userType: 'normal',
    beginTime: `${formatDatePart(now)}T00:00:00`,
    endTime: getResetSlotEndTime(),
  });
}

// ─── Device Info ─────────────────────────────────────────────────────────────

/**
 * Fetch device capabilities — useful for debugging what the device supports
 */
export async function getCapabilities() {
  return await performIsapiRequest('/ISAPI/AccessControl/capabilities');
}
