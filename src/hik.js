// src/hik.js
// Wrapper for HiKVision ISAPI endpoints using Digest Authentication

import DigestFetch from 'digest-fetch';
import { parseStringPromise } from 'xml2js';

const BASE_URL = `http://${process.env.HIK_IP}:${process.env.HIK_PORT}`;
const DIGEST_RETRY_ATTEMPTS = 2;
const AUTH_DEBUG_ENABLED = process.env.HIK_DEBUG_AUTH === '1';
const REMOTE_CONTROL_PASSWORD_PATTERN = /^\d{6}$/;
const CARD_SEARCH_PAGE_SIZE = 30;

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
  return await performIsapiRequest('/ISAPI/AccessControl/UserInfo/SetUp?format=json', {
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
  if (!cardInfo) {
    return [];
  }

  return Array.isArray(cardInfo) ? cardInfo : [cardInfo];
}

function getNumericField(value, fallback) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

async function searchCards({
  searchID,
  searchResultPosition,
  maxResults = CARD_SEARCH_PAGE_SIZE,
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

export async function listAvailableCards({ maxResults = CARD_SEARCH_PAGE_SIZE } = {}) {
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

// ─── Device Info ─────────────────────────────────────────────────────────────

/**
 * Fetch device capabilities — useful for debugging what the device supports
 */
export async function getCapabilities() {
  return await performIsapiRequest('/ISAPI/AccessControl/capabilities');
}
