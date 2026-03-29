// src/hik.js
// Wrapper for HiKVision ISAPI endpoints using Digest Authentication

import DigestFetch from 'digest-fetch';
import { parseStringPromise } from 'xml2js';

const BASE_URL = `http://${process.env.HIK_IP}:${process.env.HIK_PORT}`;

// DigestFetch handles the Digest Auth handshake automatically
const client = new DigestFetch(
  process.env.HIK_USERNAME,
  process.env.HIK_PASSWORD
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function parseResponse(res) {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Device returned ${res.status}: ${text}`);
  }
  // Try JSON first, fall back to XML
  try {
    return JSON.parse(text);
  } catch {
    return await parseStringPromise(text, { explicitArray: false });
  }
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
  const res = await client.fetch(
    `${BASE_URL}/ISAPI/AccessControl/RemoteControl/door/${doorNo}`,
    {
      method: 'PUT',
      headers: xmlHeaders(),
      body: `<?xml version="1.0" encoding="UTF-8"?><RemoteControlDoor><cmd>open</cmd></RemoteControlDoor>`,
    }
  );
  return await parseResponse(res);
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
  const res = await client.fetch(
    `${BASE_URL}/ISAPI/AccessControl/UserInfo/SetUp?format=json`,
    {
      method: 'POST',
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
    }
  );
  return await parseResponse(res);
}

/**
 * Delete a user from the device entirely
 * @param {string} employeeNo - Member's ID
 */
export async function deleteUser(employeeNo) {
  const res = await client.fetch(
    `${BASE_URL}/ISAPI/AccessControl/UserInfo/Delete?format=json`,
    {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify({
        UserInfoDelCond: {
          EmployeeNoList: [{ employeeNo: String(employeeNo) }],
        },
      }),
    }
  );
  return await parseResponse(res);
}

/**
 * Search for a user on the device
 * @param {string} employeeNo - Member's ID
 */
export async function getUser(employeeNo) {
  const res = await client.fetch(
    `${BASE_URL}/ISAPI/AccessControl/UserInfo/Search?format=json`,
    {
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
    }
  );
  return await parseResponse(res);
}

// ─── Card Management ─────────────────────────────────────────────────────────

/**
 * Issue a card to a user
 * @param {string} employeeNo - Member's ID
 * @param {string} cardNo     - The card number (printed on the physical card)
 */
export async function addCard(employeeNo, cardNo) {
  const res = await client.fetch(
    `${BASE_URL}/ISAPI/AccessControl/CardInfo/SetUp?format=json`,
    {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        CardInfo: {
          employeeNo: String(employeeNo),
          cardNo: String(cardNo),
          cardType: 'normalCard',
        },
      }),
    }
  );
  return await parseResponse(res);
}

/**
 * Revoke a card (removes it from the device — card will no longer grant access)
 * @param {string} employeeNo - Member's ID
 * @param {string} cardNo     - The card number to revoke
 */
export async function revokeCard(employeeNo, cardNo) {
  const res = await client.fetch(
    `${BASE_URL}/ISAPI/AccessControl/CardInfo/Delete?format=json`,
    {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify({
        CardInfoDelCond: {
          EmployeeNoList: [{ employeeNo: String(employeeNo) }],
        },
      }),
    }
  );
  return await parseResponse(res);
}

/**
 * Look up card info for a user
 * @param {string} employeeNo - Member's ID
 */
export async function getCard(employeeNo) {
  const res = await client.fetch(
    `${BASE_URL}/ISAPI/AccessControl/CardInfo/Search?format=json`,
    {
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
    }
  );
  return await parseResponse(res);
}

// ─── Device Info ─────────────────────────────────────────────────────────────

/**
 * Fetch device capabilities — useful for debugging what the device supports
 */
export async function getCapabilities() {
  const res = await client.fetch(
    `${BASE_URL}/ISAPI/AccessControl/capabilities`
  );
  return await parseResponse(res);
}
