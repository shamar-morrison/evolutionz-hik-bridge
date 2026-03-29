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

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function createUnlockDoorServer({ expectedRemotePassword = '123456', finalBare401 = false } = {}) {
  const events = [];
  const seenKeys = new Set();
  const route = '/ISAPI/AccessControl/RemoteControl/door/1';

  const server = http.createServer(async (req, res) => {
    const auth = req.headers.authorization;

    if (!auth) {
      events.push({ type: 'challenge', route: req.url });
      res.writeHead(401, {
        'WWW-Authenticate': `Digest realm="${DIGEST_REALM}", nonce="${DIGEST_NONCE}", qop="auth", opaque="xyz"`,
        'Content-Type': 'application/xml',
      });
      res.end('');
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
        'Content-Type': 'application/xml',
      });
      res.end('');
      return;
    }

    seenKeys.add(key);

    if (finalBare401) {
      events.push({ type: 'bare_401', key, route: req.url });
      res.writeHead(401, { 'Content-Type': 'application/xml' });
      res.end('');
      return;
    }

    const body = await readRequestBody(req);
    events.push({ type: 'authorized', key, route: req.url, body });

    const isValidUnlockBody =
      body.includes('<RemoteControlDoor version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">') &&
      body.includes('<cmd>open</cmd>') &&
      body.includes(`<remotePassword>${expectedRemotePassword}</remotePassword>`);

    if (!isValidUnlockBody) {
      res.writeHead(400, { 'Content-Type': 'application/xml' });
      res.end('<?xml version="1.0" encoding="UTF-8"?><ResponseStatus><statusString>Invalid Format</statusString></ResponseStatus>');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, route: req.url }));
  });

  return {
    events,
    route,
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return server.address().port;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function createXmlResponseServer(xmlBody, route = '/xml') {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(xmlBody);
  });

  return {
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

async function loadHikModule(port, envOverrides = {}) {
  process.env.HIK_IP = '127.0.0.1';
  process.env.HIK_PORT = String(port);
  process.env.HIK_USERNAME = DIGEST_USER;
  process.env.HIK_PASSWORD = DIGEST_PASSWORD;
  process.env.HIK_DEBUG_AUTH = '0';
  process.env.HIK_REMOTE_PASSWORD = '123456';

  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }

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
      /Device returned 401 for \/ISAPI\/AccessControl\/capabilities: forced stale/
    );

    assert.equal(device.events.filter((event) => event.type === 'challenge').length, 2);
    assert.equal(device.events.filter((event) => event.type === 'forced_stale').length, 2);
    assert.equal(device.events.filter((event) => event.type === 'accept').length, 0);
  } finally {
    await device.close();
  }
});

test('unlockDoor requires HIK_REMOTE_PASSWORD to be configured as a 6-digit code', async () => {
  const hik = await loadHikModule(8080, { HIK_REMOTE_PASSWORD: undefined });

  await assert.rejects(
    () => hik.unlockDoor(),
    /HIK_REMOTE_PASSWORD must be set to a 6-digit code/
  );
});

test('unlockDoor sends the device-specific remotePassword payload', async () => {
  const device = createUnlockDoorServer();
  const port = await device.start();
  const hik = await loadHikModule(port, { HIK_REMOTE_PASSWORD: '123456' });

  try {
    const result = await hik.unlockDoor();

    assert.equal(result.ok, true);
    assert.equal(device.events.filter((event) => event.type === 'challenge').length, 1);
    assert.equal(device.events.filter((event) => event.type === 'authorized').length, 1);
    assert.match(
      device.events.find((event) => event.type === 'authorized').body,
      /<remotePassword>123456<\/remotePassword>/
    );
  } finally {
    await device.close();
  }
});

test('unlockDoor normalizes XML ResponseStatus success results', async () => {
  const responseXml = '<?xml version="1.0" encoding="UTF-8"?><ResponseStatus version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><requestURL>/ISAPI/AccessControl/RemoteControl/door/1</requestURL><statusCode>1</statusCode><statusString>OK</statusString><subStatusCode>ok</subStatusCode></ResponseStatus>';
  const device = createXmlResponseServer(responseXml, '/ISAPI/AccessControl/RemoteControl/door/1');
  const port = await device.start();
  const hik = await loadHikModule(port, { HIK_REMOTE_PASSWORD: '123456' });

  try {
    const result = await hik.unlockDoor();

    assert.deepEqual(result, {
      ok: true,
      type: 'ResponseStatus',
      requestURL: '/ISAPI/AccessControl/RemoteControl/door/1',
      statusCode: 1,
      statusString: 'OK',
      subStatusCode: 'ok',
    });
  } finally {
    await device.close();
  }
});

test('unlockDoor error mentions the endpoint when the final 401 has no digest challenge', async () => {
  const device = createUnlockDoorServer({ finalBare401: true });
  const port = await device.start();
  const hik = await loadHikModule(port, { HIK_REMOTE_PASSWORD: '123456' });

  try {
    await assert.rejects(
      () => hik.unlockDoor(),
      /Device returned 401 for \/ISAPI\/AccessControl\/RemoteControl\/door\/1 without a digest challenge/
    );
  } finally {
    await device.close();
  }
});

test('getCapabilities keeps non-ResponseStatus XML payloads unchanged', async () => {
  const responseXml = '<?xml version="1.0" encoding="UTF-8"?><AccessControl version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><isSupportRemoteControlDoor>true</isSupportRemoteControlDoor></AccessControl>';
  const device = createXmlResponseServer(responseXml, '/ISAPI/AccessControl/capabilities');
  const port = await device.start();
  const hik = await loadHikModule(port);

  try {
    const result = await hik.getCapabilities();

    assert.deepEqual(result, {
      AccessControl: {
        $: {
          version: '2.0',
          xmlns: 'http://www.isapi.org/ver20/XMLSchema',
        },
        isSupportRemoteControlDoor: 'true',
      },
    });
  } finally {
    await device.close();
  }
});
