import DigestFetch from 'digest-fetch';
import { parseStringPromise } from 'xml2js';

import { DIGEST_RETRY_ATTEMPTS } from './constants.js';
import { toNumberIfNumeric } from './shared.js';

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

  return `http://${process.env.HIK_IP}:${process.env.HIK_PORT}${path}`;
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
  if (process.env.HIK_DEBUG_AUTH !== '1') {
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

  try {
    return JSON.parse(text);
  } catch {
    const parsedXml = await parseStringPromise(text, { explicitArray: false });
    return normalizeResponseStatus(parsedXml) ?? parsedXml;
  }
}

export async function performIsapiRequest(path, init = {}) {
  const res = await requestIsapi(path, init);
  return await parseResponse(res, path, init);
}

export function jsonHeaders() {
  return { 'Content-Type': 'application/json;charset=UTF-8' };
}

export function xmlHeaders() {
  return { 'Content-Type': 'application/xml;charset=UTF-8' };
}
