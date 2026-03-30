// src/hik.js
// Wrapper for HiKVision ISAPI endpoints using Digest Authentication

import DigestFetch from 'digest-fetch';
import { parseStringPromise } from 'xml2js';

const BASE_URL = `http://${process.env.HIK_IP}:${process.env.HIK_PORT}`;
const DIGEST_RETRY_ATTEMPTS = 2;
const AUTH_DEBUG_ENABLED = process.env.HIK_DEBUG_AUTH === '1';
const REMOTE_CONTROL_PASSWORD_PATTERN = /^\d{6}$/;
const SEARCH_PAGE_SIZE = 30;
const DEFAULT_PLACEHOLDER_SLOT_PATTERN = '^[A-Z]\\d{1,2}$';
const DEFAULT_RESET_SLOT_END_TIME = '2037-12-31T23:59:59';
const AVAILABLE_SLOT_DEBUG_SAMPLE_LIMIT = 10;
const SLOT_TOKEN_PREFIX_PATTERN = /^([A-Z]\d{1,2})(?=\s|$)/i;
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

function matchesPlaceholderPattern(placeholderPattern, value) {
  if (typeof value !== 'string' || !value) {
    return false;
  }

  placeholderPattern.lastIndex = 0;
  return placeholderPattern.test(value);
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

function parseCommaSeparatedEnv(value) {
  if (typeof value !== 'string') {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizePlaceholderNameForDebug(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().toUpperCase();
}

function getAvailableSlotsDebugConfig() {
  const focusedPlaceholderNames = parseCommaSeparatedEnv(
    process.env.HIK_DEBUG_AVAILABLE_SLOTS_PLACEHOLDER_NAMES
  );
  const focusedCardNos = parseCommaSeparatedEnv(
    process.env.HIK_DEBUG_AVAILABLE_SLOTS_CARD_NOS
  );

  return {
    enabled: isAvailableSlotsDebugEnabled(),
    focusedPlaceholderNames,
    focusedCardNos,
    focusedPlaceholderNameSet: new Set(
      focusedPlaceholderNames.map((value) => normalizePlaceholderNameForDebug(value))
    ),
    focusedCardNoSet: new Set(focusedCardNos),
  };
}

function createCardBackedNonSlotDiagnostics() {
  return {
    total: 0,
    missingUserRecord: 0,
    missingPlaceholderName: 0,
    occupiedSlotName: 0,
    otherNonPlaceholderName: 0,
    invalidValidity: createInvalidValidityDiagnostics(),
  };
}

function extractNameCandidates(record) {
  const nameCandidates = {};

  if (!record || typeof record !== 'object') {
    return nameCandidates;
  }

  for (const [key, value] of Object.entries(record)) {
    if (!key.toLowerCase().includes('name') || typeof value !== 'string') {
      continue;
    }

    const trimmedValue = value.trim();

    if (!trimmedValue) {
      continue;
    }

    nameCandidates[key] = trimmedValue;
  }

  return nameCandidates;
}

function collectMatchingPlaceholderNames(nameCandidates, placeholderPattern) {
  const matchingPlaceholderNames = [];
  const seenValues = new Set();

  for (const [key, value] of Object.entries(nameCandidates)) {
    if (!matchesPlaceholderPattern(placeholderPattern, value) || seenValues.has(value)) {
      continue;
    }

    seenValues.add(value);
    matchingPlaceholderNames.push({
      key,
      value,
    });
  }

  return matchingPlaceholderNames;
}

function extractSlotToken(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return null;
  }

  const match = trimmedValue.match(SLOT_TOKEN_PREFIX_PATTERN);
  return match ? match[1].toUpperCase() : null;
}

function collectSlotTokenCandidates(nameCandidates) {
  const slotTokenCandidates = [];
  const seenCandidates = new Set();

  for (const [key, value] of Object.entries(nameCandidates)) {
    const slotToken = extractSlotToken(value);

    if (!slotToken) {
      continue;
    }

    const candidateKey = `${key}\u0000${slotToken}\u0000${value}`;

    if (seenCandidates.has(candidateKey)) {
      continue;
    }

    seenCandidates.add(candidateKey);
    slotTokenCandidates.push({
      key,
      value,
      slotToken,
      exactMatch: value === slotToken,
    });
  }

  return slotTokenCandidates;
}

function hasFocusedPlaceholderMatch(debugConfig, values = []) {
  if (!debugConfig.focusedPlaceholderNameSet.size) {
    return false;
  }

  return values.some((value) =>
    debugConfig.focusedPlaceholderNameSet.has(normalizePlaceholderNameForDebug(value))
  );
}

function isFocusedCardNoMatch(debugConfig, cardNo) {
  return !!cardNo && debugConfig.focusedCardNoSet.has(cardNo);
}

function collectFocusedPlaceholderValues({
  extractedName,
  placeholderNameHint,
  slotToken,
  nameCandidates,
  matchingPlaceholderNames,
  slotTokenCandidates,
}) {
  return [
    extractedName,
    placeholderNameHint,
    slotToken,
    ...Object.values(nameCandidates ?? {}),
    ...(matchingPlaceholderNames ?? []).map((entry) => entry.value),
    ...(slotTokenCandidates ?? []).map((entry) => entry.slotToken),
  ].filter(Boolean);
}

function createUserDebugRecord(userInfo, placeholderPattern, now) {
  const employeeNo = typeof userInfo?.employeeNo === 'string' ? userInfo.employeeNo.trim() : '';
  const canonicalEmployeeNo = canonicalizeEmployeeNo(employeeNo);
  const extractedName = typeof userInfo?.name === 'string' ? userInfo.name.trim() : '';
  const nameCandidates = extractNameCandidates(userInfo);
  const matchingPlaceholderNames = collectMatchingPlaceholderNames(
    nameCandidates,
    placeholderPattern
  );
  const slotTokenCandidates = collectSlotTokenCandidates(nameCandidates);
  const slotToken = extractSlotToken(extractedName);
  const hasExactPlaceholderName = matchesPlaceholderPattern(placeholderPattern, extractedName);
  const hasOccupiedSlotName = !!slotToken && extractedName !== slotToken;
  const placeholderNameHint =
    matchingPlaceholderNames[0]?.value ??
    (hasExactPlaceholderName ? extractedName : null);

  let classification = 'validPlaceholder';
  let validityEvaluated = false;
  let isCurrentlyValid = null;
  let validityReason = null;
  let normalizedValidity = null;

  if (!employeeNo) {
    classification = 'missingEmployeeNo';
  } else if (!extractedName) {
    classification = 'missingPlaceholderName';
  } else if (!hasExactPlaceholderName) {
    classification = hasOccupiedSlotName ? 'occupiedSlotName' : 'otherNonPlaceholderName';
  } else {
    const validity = analyzeUserValidity(userInfo, now);

    validityEvaluated = true;
    isCurrentlyValid = validity.isValid;
    validityReason = validity.reason;
    normalizedValidity = validity.normalizedValidity;
    classification = validity.isValid ? 'validPlaceholder' : 'invalidValidity';
  }

  return {
    employeeNo,
    canonicalEmployeeNo,
    extractedName,
    placeholderNameHint,
    slotToken,
    nameCandidates,
    matchingPlaceholderNames,
    slotTokenCandidates,
    classification,
    validityEvaluated,
    isCurrentlyValid,
    validityReason,
    normalizedValidity,
    rawUserInfo: userInfo ?? null,
  };
}

function createCardDebugRecord(cardInfo) {
  const employeeNo = typeof cardInfo?.employeeNo === 'string' ? cardInfo.employeeNo.trim() : '';
  const cardNo = typeof cardInfo?.cardNo === 'string' ? cardInfo.cardNo.trim() : '';

  return {
    employeeNo,
    canonicalEmployeeNo: canonicalizeEmployeeNo(employeeNo),
    cardNo,
    rawCardInfo: cardInfo ?? null,
  };
}

function isFocusedDirectProbeEnabled(debugConfig) {
  return debugConfig.enabled && debugConfig.focusedCardNos.length > 0;
}

function getFocusedPlaceholderMatches(debugConfig, values = []) {
  if (!debugConfig.focusedPlaceholderNameSet.size) {
    return [];
  }

  const matches = [];
  const seenMatches = new Set();

  for (const value of values) {
    if (typeof value !== 'string' || !value) {
      continue;
    }

    const normalizedValue = normalizePlaceholderNameForDebug(value);

    if (
      !normalizedValue ||
      !debugConfig.focusedPlaceholderNameSet.has(normalizedValue) ||
      seenMatches.has(normalizedValue)
    ) {
      continue;
    }

    seenMatches.add(normalizedValue);
    matches.push(normalizedValue);
  }

  return matches;
}

function collectFocusedExactPlaceholderNames(debugConfig, userDebugRecord) {
  return getFocusedPlaceholderMatches(
    debugConfig,
    (userDebugRecord?.matchingPlaceholderNames ?? []).map((entry) => entry.value)
  );
}

function collectFocusedSlotTokenPrefixes(debugConfig, userDebugRecord) {
  return getFocusedPlaceholderMatches(
    debugConfig,
    (userDebugRecord?.slotTokenCandidates ?? [])
      .filter((entry) => !entry.exactMatch)
      .map((entry) => entry.slotToken)
  );
}

function buildUserDebugRecordKey(userDebugRecord) {
  return (
    userDebugRecord?.slotToken ??
    userDebugRecord?.placeholderNameHint ??
    userDebugRecord?.extractedName ??
    userDebugRecord?.employeeNo ??
    null
  );
}

function buildCardDebugRecordKey(cardDebugRecord) {
  return cardDebugRecord?.cardNo ?? cardDebugRecord?.employeeNo ?? null;
}

function createCompactCardSnippet(cardInfo) {
  if (!cardInfo || typeof cardInfo !== 'object') {
    return null;
  }

  const cardNo = typeof cardInfo.cardNo === 'string' ? cardInfo.cardNo.trim() : null;
  const employeeNo =
    typeof cardInfo.employeeNo === 'string' ? cardInfo.employeeNo.trim() : null;
  const cardType = typeof cardInfo.cardType === 'string' ? cardInfo.cardType.trim() : null;

  return {
    employeeNo,
    cardNo,
    cardType,
  };
}

function createCompactUserSnippet(userInfo) {
  if (!userInfo || typeof userInfo !== 'object') {
    return null;
  }

  const employeeNo =
    typeof userInfo.employeeNo === 'string' ? userInfo.employeeNo.trim() : null;
  const name = typeof userInfo.name === 'string' ? userInfo.name.trim() : null;

  return {
    employeeNo,
    name,
    Valid:
      userInfo.Valid && typeof userInfo.Valid === 'object'
        ? {
            enable: userInfo.Valid.enable ?? null,
            beginTime: userInfo.Valid.beginTime ?? null,
            endTime: userInfo.Valid.endTime ?? null,
          }
        : null,
  };
}

function normalizeSearchMetadata(searchResult, fallbackCount) {
  return {
    responseStatusStrg: String(searchResult?.responseStatusStrg ?? 'OK').toUpperCase(),
    numOfMatches: getNumericField(searchResult?.numOfMatches, fallbackCount),
    totalMatches: getNumericField(searchResult?.totalMatches, fallbackCount),
  };
}

function buildDebugReport({
  focusedPlaceholderNames,
  focusedCardNos,
  records,
}) {
  const selectedRecords = [];
  let sampledNonForcedCount = 0;
  let omittedCount = 0;

  for (const record of records) {
    const { forceInclude = false, ...serializableRecord } = record;

    if (forceInclude || sampledNonForcedCount < AVAILABLE_SLOT_DEBUG_SAMPLE_LIMIT) {
      selectedRecords.push(serializableRecord);

      if (!forceInclude) {
        sampledNonForcedCount += 1;
      }

      continue;
    }

    omittedCount += 1;
  }

  return {
    sampleLimit: AVAILABLE_SLOT_DEBUG_SAMPLE_LIMIT,
    focusedPlaceholderNames,
    focusedCardNos,
    totalRelevantRecords: records.length,
    omittedCount,
    records: selectedRecords,
  };
}

function logDebugJson(label, value) {
  console.info(`${label}\n${JSON.stringify(value, null, 2)}`);
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
  employeeNos = [],
}) {
  const normalizedEmployeeNos = employeeNos
    .map((employeeNo) => String(employeeNo).trim())
    .filter(Boolean);

  return await performIsapiRequest('/ISAPI/AccessControl/UserInfo/Search?format=json', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      UserInfoSearchCond: {
        searchID,
        searchResultPosition,
        maxResults,
        ...(normalizedEmployeeNos.length > 0
          ? {
              EmployeeNoList: normalizedEmployeeNos.map((employeeNo) => ({
                employeeNo,
              })),
            }
          : {}),
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
  employeeNos = [],
  cardNos = [],
}) {
  const normalizedEmployeeNos = employeeNos
    .map((employeeNo) => String(employeeNo).trim())
    .filter(Boolean);
  const normalizedCardNos = cardNos
    .map((cardNo) => String(cardNo).trim())
    .filter(Boolean);

  return await performIsapiRequest('/ISAPI/AccessControl/CardInfo/Search?format=json', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      CardInfoSearchCond: {
        searchID,
        searchResultPosition,
        maxResults,
        ...(normalizedEmployeeNos.length > 0
          ? {
              EmployeeNoList: normalizedEmployeeNos.map((employeeNo) => ({
                employeeNo,
              })),
            }
          : {}),
        ...(normalizedCardNos.length > 0
          ? {
              CardNoList: normalizedCardNos.map((cardNo) => ({
                cardNo,
              })),
            }
          : {}),
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
  const debugConfig = getAvailableSlotsDebugConfig();
  const availableSlotsDebugEnabled = debugConfig.enabled;
  const focusedDirectProbeEnabled = isFocusedDirectProbeEnabled(debugConfig);
  const userSearchID = `evolutionz-users-${Date.now()}`;
  const cardSearchID = `evolutionz-cards-${Date.now()}`;
  const placeholderUsers = new Map();
  const userDebugRecords = [];
  const userDebugRecordsByJoinEmployeeNo = new Map();
  const cardsByEmployeeNo = new Map();
  const cardDebugRecords = [];
  const cardDebugRecordsByCardNo = new Map();
  const selectedCardRecordsByJoinEmployeeNo = new Map();
  const focusedBulkUserPageTraces = [];
  const focusedBulkCardPageTraces = [];
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
      occupiedSlotName: 0,
      otherNonPlaceholderName: 0,
      invalidValidity: createInvalidValidityDiagnostics(),
    },
    droppedCards: {
      missingEmployeeNo: 0,
      missingCardNo: 0,
    },
    droppedSlots: {
      withoutCard: 0,
    },
    cardBackedNonSlots: createCardBackedNonSlotDiagnostics(),
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
    const userSearchMetadata = normalizeSearchMetadata(
      userInfoSearch,
      userInfoList.length
    );
    const pageUserDebugRecords = [];
    diagnostics.userPages += 1;
    diagnostics.totalUsersScanned += userInfoList.length;

    for (const userInfo of userInfoList) {
      const userDebugRecord = createUserDebugRecord(userInfo, placeholderPattern, now);
      userDebugRecords.push(userDebugRecord);
      pageUserDebugRecords.push(userDebugRecord);

      if (userDebugRecord.canonicalEmployeeNo) {
        userDebugRecordsByJoinEmployeeNo.set(
          userDebugRecord.canonicalEmployeeNo,
          userDebugRecord
        );
      }

      if (userDebugRecord.classification === 'missingEmployeeNo') {
        diagnostics.droppedUsers.missingEmployeeNo += 1;
        continue;
      }

      if (userDebugRecord.classification === 'missingPlaceholderName') {
        diagnostics.droppedUsers.missingPlaceholderName += 1;
        continue;
      }

      if (userDebugRecord.classification === 'occupiedSlotName') {
        diagnostics.droppedUsers.occupiedSlotName += 1;
        continue;
      }

      if (userDebugRecord.classification === 'otherNonPlaceholderName') {
        diagnostics.droppedUsers.otherNonPlaceholderName += 1;
        continue;
      }

      if (userDebugRecord.classification === 'invalidValidity') {
        recordInvalidValidity(
          diagnostics.droppedUsers.invalidValidity,
          userDebugRecord.validityReason
        );
        continue;
      }

      if (!userDebugRecord.canonicalEmployeeNo) {
        diagnostics.droppedUsers.missingEmployeeNo += 1;
        continue;
      }

      placeholderUsers.set(userDebugRecord.canonicalEmployeeNo, {
        employeeNo: userDebugRecord.employeeNo,
        joinEmployeeNo: userDebugRecord.canonicalEmployeeNo,
        placeholderName: userDebugRecord.extractedName,
      });
    }

    if (focusedDirectProbeEnabled) {
      const matchingExactFocusedPlaceholderNames = Array.from(
        new Set(
          pageUserDebugRecords.flatMap((record) =>
            collectFocusedExactPlaceholderNames(debugConfig, record)
          )
        )
      );
      const matchingFocusedSlotTokenPrefixes = Array.from(
        new Set(
          pageUserDebugRecords.flatMap((record) =>
            collectFocusedSlotTokenPrefixes(debugConfig, record)
          )
        )
      );

      focusedBulkUserPageTraces.push({
        searchResultPosition: userSearchResultPosition,
        numOfMatches: userSearchMetadata.numOfMatches,
        totalMatches: userSearchMetadata.totalMatches,
        responseStatusStrg: userSearchMetadata.responseStatusStrg,
        firstResultKey: buildUserDebugRecordKey(pageUserDebugRecords[0]),
        lastResultKey: buildUserDebugRecordKey(
          pageUserDebugRecords[pageUserDebugRecords.length - 1]
        ),
        containsFocusedCardNo: false,
        containsExactFocusedPlaceholderName:
          matchingExactFocusedPlaceholderNames.length > 0,
        containsFocusedSlotTokenPrefix:
          matchingFocusedSlotTokenPrefixes.length > 0,
        matchingFocusedCardNos: [],
        matchingExactFocusedPlaceholderNames,
        matchingFocusedSlotTokenPrefixes,
      });
    }

    const responseStatus = userSearchMetadata.responseStatusStrg;
    const matchesOnPage = userSearchMetadata.numOfMatches;
    const totalMatches = getNumericField(
      userSearchMetadata.totalMatches,
      userSearchResultPosition + matchesOnPage
    );

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
    const cardSearchMetadata = normalizeSearchMetadata(
      cardInfoSearch,
      cardInfoList.length
    );
    const pageCardDebugRecords = [];
    diagnostics.cardPages += 1;
    diagnostics.totalCardsScanned += cardInfoList.length;

    for (const cardInfo of cardInfoList) {
      const cardDebugRecord = createCardDebugRecord(cardInfo);
      cardDebugRecords.push(cardDebugRecord);
      pageCardDebugRecords.push(cardDebugRecord);

      if (cardDebugRecord.cardNo) {
        cardDebugRecordsByCardNo.set(cardDebugRecord.cardNo, cardDebugRecord);
      }

      if (!cardDebugRecord.employeeNo || !cardDebugRecord.cardNo) {
        if (!cardDebugRecord.employeeNo) {
          diagnostics.droppedCards.missingEmployeeNo += 1;
        }

        if (!cardDebugRecord.cardNo) {
          diagnostics.droppedCards.missingCardNo += 1;
        }

        continue;
      }

      if (!cardDebugRecord.canonicalEmployeeNo) {
        diagnostics.droppedCards.missingEmployeeNo += 1;
        continue;
      }

      const existingCardNo = cardsByEmployeeNo.get(cardDebugRecord.canonicalEmployeeNo);

      if (
        !existingCardNo ||
        cardDebugRecord.cardNo.localeCompare(existingCardNo) < 0
      ) {
        cardsByEmployeeNo.set(
          cardDebugRecord.canonicalEmployeeNo,
          cardDebugRecord.cardNo
        );
        selectedCardRecordsByJoinEmployeeNo.set(
          cardDebugRecord.canonicalEmployeeNo,
          cardDebugRecord
        );
      }
    }

    if (focusedDirectProbeEnabled) {
      const pageUserDebugRecords = pageCardDebugRecords
        .map((record) =>
          record.canonicalEmployeeNo
            ? userDebugRecordsByJoinEmployeeNo.get(record.canonicalEmployeeNo) ?? null
            : null
        )
        .filter(Boolean);
      const matchingFocusedCardNos = pageCardDebugRecords
        .filter((record) => isFocusedCardNoMatch(debugConfig, record.cardNo))
        .map((record) => record.cardNo);
      const matchingExactFocusedPlaceholderNames = Array.from(
        new Set(
          pageUserDebugRecords.flatMap((record) =>
            collectFocusedExactPlaceholderNames(debugConfig, record)
          )
        )
      );
      const matchingFocusedSlotTokenPrefixes = Array.from(
        new Set(
          pageUserDebugRecords.flatMap((record) =>
            collectFocusedSlotTokenPrefixes(debugConfig, record)
          )
        )
      );

      focusedBulkCardPageTraces.push({
        searchResultPosition: cardSearchResultPosition,
        numOfMatches: cardSearchMetadata.numOfMatches,
        totalMatches: cardSearchMetadata.totalMatches,
        responseStatusStrg: cardSearchMetadata.responseStatusStrg,
        firstResultKey: buildCardDebugRecordKey(pageCardDebugRecords[0]),
        lastResultKey: buildCardDebugRecordKey(
          pageCardDebugRecords[pageCardDebugRecords.length - 1]
        ),
        containsFocusedCardNo: matchingFocusedCardNos.length > 0,
        containsExactFocusedPlaceholderName:
          matchingExactFocusedPlaceholderNames.length > 0,
        containsFocusedSlotTokenPrefix:
          matchingFocusedSlotTokenPrefixes.length > 0,
        matchingFocusedCardNos,
        matchingExactFocusedPlaceholderNames,
        matchingFocusedSlotTokenPrefixes,
      });
    }

    const responseStatus = cardSearchMetadata.responseStatusStrg;
    const matchesOnPage = cardSearchMetadata.numOfMatches;
    const totalMatches = getNumericField(
      cardSearchMetadata.totalMatches,
      cardSearchResultPosition + matchesOnPage
    );

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

  const cardBackedNonSlotRecords = [];

  for (const [joinEmployeeNo, cardNo] of Array.from(cardsByEmployeeNo.entries()).sort(
    (left, right) => left[1].localeCompare(right[1]) || left[0].localeCompare(right[0])
  )) {
    if (placeholderUsers.has(joinEmployeeNo)) {
      continue;
    }

    diagnostics.cardBackedNonSlots.total += 1;

    const cardDebugRecord = selectedCardRecordsByJoinEmployeeNo.get(joinEmployeeNo) ?? null;
    const userDebugRecord = userDebugRecordsByJoinEmployeeNo.get(joinEmployeeNo) ?? null;
    const placeholderNameValues = userDebugRecord
      ? collectFocusedPlaceholderValues(userDebugRecord)
      : [];
    const forceInclude =
      hasFocusedPlaceholderMatch(debugConfig, placeholderNameValues) ||
      isFocusedCardNoMatch(debugConfig, cardNo);
    const debugMatchedBy = [];

    if (hasFocusedPlaceholderMatch(debugConfig, placeholderNameValues)) {
      debugMatchedBy.push('focusedPlaceholderName');
    }

    if (isFocusedCardNoMatch(debugConfig, cardNo)) {
      debugMatchedBy.push('focusedCardNo');
    }

    let userClassification = 'missingUserRecord';

    if (!userDebugRecord) {
      diagnostics.cardBackedNonSlots.missingUserRecord += 1;
    } else {
      userClassification = userDebugRecord.classification;

      if (userClassification === 'missingPlaceholderName') {
        diagnostics.cardBackedNonSlots.missingPlaceholderName += 1;
      } else if (userClassification === 'occupiedSlotName') {
        diagnostics.cardBackedNonSlots.occupiedSlotName += 1;
      } else if (userClassification === 'otherNonPlaceholderName') {
        diagnostics.cardBackedNonSlots.otherNonPlaceholderName += 1;
      } else if (userClassification === 'invalidValidity') {
        recordInvalidValidity(
          diagnostics.cardBackedNonSlots.invalidValidity,
          userDebugRecord.validityReason
        );
      }
    }

    cardBackedNonSlotRecords.push({
      key:
        userDebugRecord?.slotToken || userDebugRecord?.placeholderNameHint
          ? `${cardNo} • ${userDebugRecord?.slotToken ?? userDebugRecord?.placeholderNameHint}`
          : cardNo,
      cardNo,
      employeeNo: cardDebugRecord?.employeeNo ?? userDebugRecord?.employeeNo ?? null,
      canonicalEmployeeNo: joinEmployeeNo,
      placeholderNameHint: userDebugRecord?.placeholderNameHint ?? null,
      slotToken: userDebugRecord?.slotToken ?? null,
      extractedName: userDebugRecord?.extractedName ?? null,
      nameCandidates: userDebugRecord?.nameCandidates ?? {},
      matchingPlaceholderNames: userDebugRecord?.matchingPlaceholderNames ?? [],
      slotTokenCandidates: userDebugRecord?.slotTokenCandidates ?? [],
      userRecordFound: !!userDebugRecord,
      userClassification,
      validityEvaluated: userDebugRecord?.validityEvaluated ?? false,
      isCurrentlyValid: userDebugRecord?.isCurrentlyValid ?? null,
      validityReason: userDebugRecord?.validityReason ?? null,
      normalizedValidity: userDebugRecord?.normalizedValidity ?? null,
      debugMatchedBy,
      rawCardInfo: cardDebugRecord?.rawCardInfo ?? null,
      rawUserInfo: userDebugRecord?.rawUserInfo ?? null,
      forceInclude,
    });
  }

  const focusedDirectProbeRecords = [];
  const focusedComparisonRecords = [];

  if (focusedDirectProbeEnabled) {
    const bulkFocusedUserRecords = userDebugRecords.filter((record) => {
      const exactMatches = collectFocusedExactPlaceholderNames(debugConfig, record);
      const prefixMatches = collectFocusedSlotTokenPrefixes(debugConfig, record);

      return exactMatches.length > 0 || prefixMatches.length > 0;
    });

    for (const [probeIndex, focusedCardNo] of debugConfig.focusedCardNos.entries()) {
      const directCardProbeRecord = {
        key: focusedCardNo,
        cardNo: focusedCardNo,
        request: {
          searchID: `focused-card-probe-${probeIndex + 1}`,
          searchResultPosition: 0,
          maxResults,
          cardNoList: [focusedCardNo],
        },
        responseStatusStrg: null,
        numOfMatches: null,
        totalMatches: null,
        returnedEmployeeNos: [],
        rawCardInfo: [],
        userProbes: [],
        error: null,
      };
      const directCardDebugRecords = [];

      try {
        const directCardResponse = await searchCards({
          searchID: `evolutionz-focused-card-${Date.now()}-${probeIndex}`,
          searchResultPosition: 0,
          maxResults,
          cardNos: [focusedCardNo],
        });
        const directCardSearch = directCardResponse?.CardInfoSearch;

        if (!directCardSearch || typeof directCardSearch !== 'object') {
          throw new Error('Device returned an unexpected focused card probe response.');
        }

        const directCardInfoList = normalizeCardInfoList(directCardSearch.CardInfo);
        const directCardMetadata = normalizeSearchMetadata(
          directCardSearch,
          directCardInfoList.length
        );

        directCardProbeRecord.responseStatusStrg = directCardMetadata.responseStatusStrg;
        directCardProbeRecord.numOfMatches = directCardMetadata.numOfMatches;
        directCardProbeRecord.totalMatches = directCardMetadata.totalMatches;
        directCardProbeRecord.rawCardInfo = directCardInfoList;

        const directEmployeeNos = [];
        const seenDirectEmployeeNos = new Set();

        for (const cardInfo of directCardInfoList) {
          const directCardDebugRecord = createCardDebugRecord(cardInfo);
          directCardDebugRecords.push(directCardDebugRecord);

          if (
            directCardDebugRecord.employeeNo &&
            !seenDirectEmployeeNos.has(directCardDebugRecord.employeeNo)
          ) {
            seenDirectEmployeeNos.add(directCardDebugRecord.employeeNo);
            directEmployeeNos.push(directCardDebugRecord.employeeNo);
          }
        }

        directCardProbeRecord.returnedEmployeeNos = directEmployeeNos;

        for (const [userProbeIndex, employeeNo] of directEmployeeNos.entries()) {
          const directUserProbeRecord = {
            key: employeeNo,
            employeeNo,
            canonicalEmployeeNo: canonicalizeEmployeeNo(employeeNo),
            request: {
              searchID: `focused-user-probe-${probeIndex + 1}-${userProbeIndex + 1}`,
              searchResultPosition: 0,
              maxResults,
              employeeNoList: [employeeNo],
            },
            responseStatusStrg: null,
            numOfMatches: null,
            totalMatches: null,
            returnedNames: [],
            rawUserInfo: [],
            userRecords: [],
            error: null,
          };

          try {
            const directUserResponse = await searchUsers({
              searchID: `evolutionz-focused-user-${Date.now()}-${probeIndex}-${userProbeIndex}`,
              searchResultPosition: 0,
              maxResults,
              employeeNos: [employeeNo],
            });
            const directUserSearch = directUserResponse?.UserInfoSearch;

            if (!directUserSearch || typeof directUserSearch !== 'object') {
              throw new Error('Device returned an unexpected focused user probe response.');
            }

            const directUserInfoList = normalizeUserInfoList(directUserSearch.UserInfo);
            const directUserMetadata = normalizeSearchMetadata(
              directUserSearch,
              directUserInfoList.length
            );

            directUserProbeRecord.responseStatusStrg = directUserMetadata.responseStatusStrg;
            directUserProbeRecord.numOfMatches = directUserMetadata.numOfMatches;
            directUserProbeRecord.totalMatches = directUserMetadata.totalMatches;
            directUserProbeRecord.returnedNames = Array.from(
              new Set(
                directUserInfoList
                  .map((userInfo) =>
                    typeof userInfo?.name === 'string' ? userInfo.name.trim() : ''
                  )
                  .filter(Boolean)
              )
            );
            directUserProbeRecord.rawUserInfo = directUserInfoList;
            directUserProbeRecord.userRecords = directUserInfoList.map((userInfo) =>
              createUserDebugRecord(userInfo, placeholderPattern, now)
            );
          } catch (error) {
            directUserProbeRecord.error = error instanceof Error ? error.message : String(error);
          }

          directCardProbeRecord.userProbes.push(directUserProbeRecord);
        }
      } catch (error) {
        directCardProbeRecord.error = error instanceof Error ? error.message : String(error);
      }

      focusedDirectProbeRecords.push(directCardProbeRecord);

      const bulkCardRecord = cardDebugRecordsByCardNo.get(focusedCardNo) ?? null;
      const bulkUserRecord =
        bulkCardRecord?.canonicalEmployeeNo
          ? userDebugRecordsByJoinEmployeeNo.get(bulkCardRecord.canonicalEmployeeNo) ?? null
          : null;
      const directMatchingCardRecords = directCardDebugRecords.filter(
        (record) => record.cardNo === focusedCardNo
      );
      const directMatchingJoinEmployeeNos = new Set(
        directMatchingCardRecords
          .map((record) => record.canonicalEmployeeNo)
          .filter(Boolean)
      );
      const directMatchingUserRecords = directCardProbeRecord.userProbes
        .flatMap((probe) => probe.userRecords ?? [])
        .filter(
          (record) =>
            !!record.canonicalEmployeeNo &&
            directMatchingJoinEmployeeNos.has(record.canonicalEmployeeNo)
        );
      const matchedFocusedSlotTokens = Array.from(
        new Set([
          ...bulkFocusedUserRecords.flatMap((record) => [
            ...collectFocusedExactPlaceholderNames(debugConfig, record),
            ...collectFocusedSlotTokenPrefixes(debugConfig, record),
          ]),
          ...directMatchingUserRecords.flatMap((record) => [
            ...collectFocusedExactPlaceholderNames(debugConfig, record),
            ...collectFocusedSlotTokenPrefixes(debugConfig, record),
          ]),
          ...debugConfig.focusedPlaceholderNames.map((value) =>
            normalizePlaceholderNameForDebug(value)
          ),
        ].filter(Boolean))
      );
      const bulkHasFocusedEvidence =
        !!bulkCardRecord || bulkFocusedUserRecords.length > 0;
      const directHasFocusedEvidence =
        directMatchingCardRecords.length > 0 || directMatchingUserRecords.length > 0;
      const classification = bulkHasFocusedEvidence
        ? directHasFocusedEvidence
          ? 'foundInBulkAndDirect'
          : 'foundBulkOnly'
        : directHasFocusedEvidence
          ? 'foundDirectOnly'
          : 'notFoundAnywhere';

      focusedComparisonRecords.push({
        key:
          matchedFocusedSlotTokens[0]
            ? `${focusedCardNo} • ${matchedFocusedSlotTokens[0]}`
            : focusedCardNo,
        cardNo: focusedCardNo,
        slotTokens: matchedFocusedSlotTokens,
        classification,
        bulkCardFound: !!bulkCardRecord,
        directCardFound: directMatchingCardRecords.length > 0,
        bulkFocusedUserSeen: bulkFocusedUserRecords.length > 0,
        directProbeError: directCardProbeRecord.error,
        bulkEmployeeNo: bulkCardRecord?.employeeNo ?? bulkUserRecord?.employeeNo ?? null,
        directEmployeeNos: Array.from(
          new Set(
            directMatchingCardRecords
              .map((record) => record.employeeNo)
              .filter(Boolean)
          )
        ),
        bulkUserName: bulkUserRecord?.extractedName ?? null,
        directUserNames: Array.from(
          new Set(
            directMatchingUserRecords
              .map((record) => record.extractedName)
              .filter(Boolean)
          )
        ),
        bulkSlotToken: bulkUserRecord?.slotToken ?? null,
        directSlotTokens: Array.from(
          new Set(
            directMatchingUserRecords
              .map((record) => record.slotToken)
              .filter(Boolean)
          )
        ),
        bulkCard: bulkCardRecord
          ? {
              employeeNo: bulkCardRecord.employeeNo || null,
              canonicalEmployeeNo: bulkCardRecord.canonicalEmployeeNo || null,
              rawCardInfo: createCompactCardSnippet(bulkCardRecord.rawCardInfo),
            }
          : null,
        bulkUser: bulkUserRecord
          ? {
              employeeNo: bulkUserRecord.employeeNo || null,
              canonicalEmployeeNo: bulkUserRecord.canonicalEmployeeNo || null,
              extractedName: bulkUserRecord.extractedName || null,
              slotToken: bulkUserRecord.slotToken || null,
              rawUserInfo: createCompactUserSnippet(bulkUserRecord.rawUserInfo),
            }
          : null,
        bulkFocusedUsers: bulkFocusedUserRecords.map((record) => ({
          employeeNo: record.employeeNo || null,
          canonicalEmployeeNo: record.canonicalEmployeeNo || null,
          extractedName: record.extractedName || null,
          slotToken: record.slotToken || null,
          classification: record.classification,
          rawUserInfo: createCompactUserSnippet(record.rawUserInfo),
        })),
        directCards: directMatchingCardRecords.map((record) => ({
          employeeNo: record.employeeNo || null,
          canonicalEmployeeNo: record.canonicalEmployeeNo || null,
          rawCardInfo: createCompactCardSnippet(record.rawCardInfo),
        })),
        directUsers: directMatchingUserRecords.map((record) => ({
          employeeNo: record.employeeNo || null,
          canonicalEmployeeNo: record.canonicalEmployeeNo || null,
          extractedName: record.extractedName || null,
          slotToken: record.slotToken || null,
          classification: record.classification,
          rawUserInfo: createCompactUserSnippet(record.rawUserInfo),
        })),
      });
    }
  }

  console.info('[hik] listAvailableSlots diagnostics', diagnostics);

  if (availableSlotsDebugEnabled) {
    const cardBackedJoinEmployeeNos = new Set(cardsByEmployeeNo.keys());
    const focusedPlaceholderJoinEmployeeNos = new Set(
      userDebugRecords
        .filter((record) =>
          hasFocusedPlaceholderMatch(
            debugConfig,
            collectFocusedPlaceholderValues(record)
          )
        )
        .map((record) => record.canonicalEmployeeNo)
        .filter(Boolean)
    );
    const focusedCardJoinEmployeeNos = new Set(
      cardDebugRecords
        .filter((record) => isFocusedCardNoMatch(debugConfig, record.cardNo))
        .map((record) => record.canonicalEmployeeNo)
        .filter(Boolean)
    );
    const cardBackedNonSlotJoinEmployeeNos = new Set(
      cardBackedNonSlotRecords.map((record) => record.canonicalEmployeeNo).filter(Boolean)
    );

    const scannedUserRecordsReport = buildDebugReport({
      focusedPlaceholderNames: debugConfig.focusedPlaceholderNames,
      focusedCardNos: debugConfig.focusedCardNos,
      records: userDebugRecords
        .filter((record) => {
          const isCardBacked =
            !!record.canonicalEmployeeNo &&
            cardBackedJoinEmployeeNos.has(record.canonicalEmployeeNo);
          const hasPlaceholderEvidence =
            record.classification === 'validPlaceholder' ||
            record.classification === 'invalidValidity' ||
            record.classification === 'occupiedSlotName' ||
            record.matchingPlaceholderNames.length > 0 ||
            record.slotTokenCandidates.length > 0;
          const forceInclude =
            hasFocusedPlaceholderMatch(
              debugConfig,
              collectFocusedPlaceholderValues(record)
            ) ||
            (!!record.canonicalEmployeeNo &&
              focusedCardJoinEmployeeNos.has(record.canonicalEmployeeNo));

          return isCardBacked || hasPlaceholderEvidence || forceInclude;
        })
        .sort((left, right) => {
          const leftKey =
            left.slotToken ??
            left.placeholderNameHint ??
            left.extractedName ??
            left.employeeNo ??
            left.canonicalEmployeeNo;
          const rightKey =
            right.slotToken ??
            right.placeholderNameHint ??
            right.extractedName ??
            right.employeeNo ??
            right.canonicalEmployeeNo;

          return leftKey.localeCompare(rightKey);
        })
        .map((record) => {
          const isFocusedPlaceholder = hasFocusedPlaceholderMatch(
            debugConfig,
            collectFocusedPlaceholderValues(record)
          );
          const isFocusedCard =
            !!record.canonicalEmployeeNo &&
            focusedCardJoinEmployeeNos.has(record.canonicalEmployeeNo);
          const isCardBacked =
            !!record.canonicalEmployeeNo &&
            cardBackedJoinEmployeeNos.has(record.canonicalEmployeeNo);
          const debugMatchedBy = [];

          if (isFocusedPlaceholder) {
            debugMatchedBy.push('focusedPlaceholderName');
          }

          if (isFocusedCard) {
            debugMatchedBy.push('focusedCardNo');
          }

          if (isCardBacked) {
            debugMatchedBy.push('cardBackedEmployee');
          }

          if (record.matchingPlaceholderNames.length > 0) {
            debugMatchedBy.push('placeholderNameCandidate');
          }

          return {
            key:
              record.slotToken ??
              record.placeholderNameHint ??
              record.extractedName ??
              record.employeeNo ??
              '(missing employeeNo)',
            employeeNo: record.employeeNo || null,
            canonicalEmployeeNo: record.canonicalEmployeeNo || null,
            extractedName: record.extractedName || null,
            placeholderNameHint: record.placeholderNameHint,
            slotToken: record.slotToken,
            nameCandidates: record.nameCandidates,
            matchingPlaceholderNames: record.matchingPlaceholderNames,
            slotTokenCandidates: record.slotTokenCandidates,
            classification: record.classification,
            validityEvaluated: record.validityEvaluated,
            isCurrentlyValid: record.isCurrentlyValid,
            validityReason: record.validityReason,
            normalizedValidity: record.normalizedValidity,
            debugMatchedBy,
            rawUserInfo: record.rawUserInfo,
            forceInclude: isFocusedPlaceholder || isFocusedCard,
          };
        }),
    });
    const scannedCardRecordsReport = buildDebugReport({
      focusedPlaceholderNames: debugConfig.focusedPlaceholderNames,
      focusedCardNos: debugConfig.focusedCardNos,
      records: cardDebugRecords
        .filter((record) => {
          const isFocusedCard = isFocusedCardNoMatch(debugConfig, record.cardNo);
          const isFocusedPlaceholder =
            !!record.canonicalEmployeeNo &&
            focusedPlaceholderJoinEmployeeNos.has(record.canonicalEmployeeNo);
          const isCardBackedNonSlot =
            !!record.canonicalEmployeeNo &&
            cardBackedNonSlotJoinEmployeeNos.has(record.canonicalEmployeeNo);

          return isFocusedCard || isFocusedPlaceholder || isCardBackedNonSlot;
        })
        .sort((left, right) => left.cardNo.localeCompare(right.cardNo))
        .map((record) => {
          const isFocusedCard = isFocusedCardNoMatch(debugConfig, record.cardNo);
          const isFocusedPlaceholder =
            !!record.canonicalEmployeeNo &&
            focusedPlaceholderJoinEmployeeNos.has(record.canonicalEmployeeNo);
          const isCardBackedNonSlot =
            !!record.canonicalEmployeeNo &&
            cardBackedNonSlotJoinEmployeeNos.has(record.canonicalEmployeeNo);
          const debugMatchedBy = [];

          if (isFocusedCard) {
            debugMatchedBy.push('focusedCardNo');
          }

          if (isFocusedPlaceholder) {
            debugMatchedBy.push('focusedPlaceholderName');
          }

          if (isCardBackedNonSlot) {
            debugMatchedBy.push('cardBackedNonSlot');
          }

          return {
            key: record.cardNo,
            cardNo: record.cardNo,
            employeeNo: record.employeeNo || null,
            canonicalEmployeeNo: record.canonicalEmployeeNo || null,
            debugMatchedBy,
            rawCardInfo: record.rawCardInfo,
            forceInclude: isFocusedCard || isFocusedPlaceholder,
          };
        }),
    });
    const cardBackedNonSlotsReport = buildDebugReport({
      focusedPlaceholderNames: debugConfig.focusedPlaceholderNames,
      focusedCardNos: debugConfig.focusedCardNos,
      records: cardBackedNonSlotRecords,
    });

    logDebugJson(
      '[hik] listAvailableSlots scanned user records',
      scannedUserRecordsReport
    );
    logDebugJson(
      '[hik] listAvailableSlots scanned card records',
      scannedCardRecordsReport
    );
    logDebugJson(
      '[hik] listAvailableSlots card-backed non-slots',
      cardBackedNonSlotsReport
    );

    if (focusedDirectProbeEnabled) {
      logDebugJson('[hik] listAvailableSlots focused bulk page trace', {
        focusedPlaceholderNames: debugConfig.focusedPlaceholderNames,
        focusedCardNos: debugConfig.focusedCardNos,
        userPages: focusedBulkUserPageTraces,
        cardPages: focusedBulkCardPageTraces,
      });
      logDebugJson('[hik] listAvailableSlots focused direct card probes', {
        focusedPlaceholderNames: debugConfig.focusedPlaceholderNames,
        focusedCardNos: debugConfig.focusedCardNos,
        probes: focusedDirectProbeRecords,
      });
      logDebugJson('[hik] listAvailableSlots focused comparison report', {
        focusedPlaceholderNames: debugConfig.focusedPlaceholderNames,
        focusedCardNos: debugConfig.focusedCardNos,
        records: focusedComparisonRecords,
      });
    }
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
