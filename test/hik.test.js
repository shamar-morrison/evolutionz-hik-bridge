import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import DigestFetch from 'digest-fetch';

const DIGEST_USER = 'Admin';
const DIGEST_PASSWORD = 'bridge-test-password';
const DIGEST_REALM = 'testrealm';
const DIGEST_NONCE = 'abc123nonce';

function md5(value) {
  return crypto.createHash('md5').update(value).digest('hex');
}

function parseDigestHeader(header) {
  const output = {};
  const raw = header.replace(/^Digest\s+/i, '');

  for (const part of raw.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const [key, ...rest] = part.trim().split('=');
    output[key] = rest.join('=').replace(/^"|"$/g, '');
  }

  return output;
}

function createDigestServer({ forceStaleResponses = 0, route = '/ISAPI/AccessControl/capabilities' } = {}) {
  const events = [];
  const seenKeys = new Set();
  let remainingForcedStaleResponses = forceStaleResponses;

  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization;

    if (!auth) {
      events.push({ type: 'challenge', route: req.url });
      res.writeHead(401, {
        'WWW-Authenticate': `Digest realm="${DIGEST_REALM}", nonce="${DIGEST_NONCE}", qop="auth", opaque="xyz"`,
      });
      res.end('challenge');
      return;
    }

    const digest = parseDigestHeader(auth);
    const key = `${digest.nonce}:${digest.cnonce}:${digest.nc}`;
    const ha1 = md5(`${DIGEST_USER}:${DIGEST_REALM}:${DIGEST_PASSWORD}`);
    const ha2 = md5(`${req.method}:${digest.uri}`);
    const expected = md5(
      `${ha1}:${digest.nonce}:${digest.nc}:${digest.cnonce}:${digest.qop}:${ha2}`
    );
    const invalid =
      digest.username !== DIGEST_USER ||
      digest.realm !== DIGEST_REALM ||
      digest.nonce !== DIGEST_NONCE ||
      digest.qop !== 'auth' ||
      digest.response !== expected ||
      seenKeys.has(key);

    if (invalid) {
      events.push({ type: 'reject', key, route: req.url });
      res.writeHead(401, {
        'WWW-Authenticate': `Digest realm="${DIGEST_REALM}", nonce="${DIGEST_NONCE}", qop="auth", opaque="xyz", stale=true`,
      });
      res.end(`rejected ${key}`);
      return;
    }

    if (remainingForcedStaleResponses > 0) {
      remainingForcedStaleResponses -= 1;
      events.push({ type: 'forced_stale', key, route: req.url });
      res.writeHead(401, {
        'WWW-Authenticate': `Digest realm="${DIGEST_REALM}", nonce="${DIGEST_NONCE}", qop="auth", opaque="xyz", stale=true`,
      });
      res.end(`forced stale ${key}`);
      return;
    }

    seenKeys.add(key);
    events.push({ type: 'accept', key, route: req.url });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, route: req.url }));
  });

  return {
    events,
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return server.address().port;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
    route,
  };
}

async function loadHikModule(port) {
  process.env.HIK_IP = '127.0.0.1';
  process.env.HIK_PORT = String(port);
  process.env.HIK_USERNAME = DIGEST_USER;
  process.env.HIK_PASSWORD = DIGEST_PASSWORD;
  process.env.HIK_DEBUG_AUTH = '0';

  const moduleUrl = new URL(
    `../src/hik.js?test=${Date.now()}-${Math.random()}`,
    import.meta.url
  );

  return import(moduleUrl.href);
}

test('digest-fetch reuses auth state on a shared client under overlapping requests', async () => {
  const device = createDigestServer({ route: '/auth' });
  const port = await device.start();
  const url = `http://127.0.0.1:${port}${device.route}`;

  try {
    const sharedClient = new DigestFetch(DIGEST_USER, DIGEST_PASSWORD);
    const initial = await sharedClient.fetch(url);
    await initial.text();

    const overlappingResponses = await Promise.all([
      sharedClient.fetch(url),
      sharedClient.fetch(url),
    ]);

    await Promise.all(overlappingResponses.map((res) => res.text()));

    assert.equal(device.events.filter((event) => event.type === 'reject').length, 1);
    assert.equal(device.events.filter((event) => event.type === 'accept').length, 3);
  } finally {
    await device.close();
  }
});

test('HiK wrapper creates a fresh digest client for each request', async () => {
  const device = createDigestServer();
  const port = await device.start();
  const hik = await loadHikModule(port);

  try {
    const [first, second] = await Promise.all([
      hik.getCapabilities(),
      hik.getCapabilities(),
    ]);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(device.events.filter((event) => event.type === 'challenge').length, 2);
    assert.equal(device.events.filter((event) => event.type === 'accept').length, 2);
    assert.equal(device.events.filter((event) => event.type === 'reject').length, 0);
  } finally {
    await device.close();
  }
});

test('HiK wrapper retries once with a fresh client after a final 401', async () => {
  const device = createDigestServer({ forceStaleResponses: 1 });
  const port = await device.start();
  const hik = await loadHikModule(port);

  try {
    const result = await hik.getCapabilities();

    assert.equal(result.ok, true);
    assert.equal(device.events.filter((event) => event.type === 'challenge').length, 2);
    assert.equal(device.events.filter((event) => event.type === 'forced_stale').length, 1);
    assert.equal(device.events.filter((event) => event.type === 'accept').length, 1);
  } finally {
    await device.close();
  }
});

test('HiK wrapper stops after one outer retry when final 401s continue', async () => {
  const device = createDigestServer({ forceStaleResponses: 2 });
  const port = await device.start();
  const hik = await loadHikModule(port);

  try {
    await assert.rejects(
      () => hik.getCapabilities(),
      /Device returned 401: forced stale/
    );

    assert.equal(device.events.filter((event) => event.type === 'challenge').length, 2);
    assert.equal(device.events.filter((event) => event.type === 'forced_stale').length, 2);
    assert.equal(device.events.filter((event) => event.type === 'accept').length, 0);
  } finally {
    await device.close();
  }
});
