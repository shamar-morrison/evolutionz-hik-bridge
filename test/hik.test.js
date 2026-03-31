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

function createAuthorizedApiServer(handler) {
  const events = [];
  const seenKeys = new Set();

  const server = http.createServer(async (req, res) => {
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

    seenKeys.add(key);

    const body = await readRequestBody(req);
    events.push({
      type: 'authorized',
      key,
      route: req.url,
      method: req.method,
      body,
    });

    await handler({ req, res, body, events });
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
  };
}

async function loadHikModule(port, envOverrides = {}) {
  process.env.HIK_IP = '127.0.0.1';
  process.env.HIK_PORT = String(port);
  process.env.HIK_USERNAME = DIGEST_USER;
  process.env.HIK_PASSWORD = DIGEST_PASSWORD;
  process.env.HIK_DEBUG_AUTH = '0';
  process.env.HIK_DEBUG_AVAILABLE_SLOTS = '0';
  process.env.HIK_DEBUG_AVAILABLE_SLOTS_PLACEHOLDER_NAMES = '';
  process.env.HIK_DEBUG_AVAILABLE_SLOTS_CARD_NOS = '';
  process.env.HIK_USER_MODIFY_MODE = 'full_access';
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

function findJsonLog(infoCalls, label) {
  const entry = infoCalls.find(
    ([message]) => typeof message === 'string' && message.startsWith(`${label}\n`)
  );

  assert.ok(entry, `Expected log entry for "${label}"`);

  return JSON.parse(entry[0].slice(label.length + 1));
}

function hasJsonLog(infoCalls, label) {
  return infoCalls.some(
    ([message]) => typeof message === 'string' && message.startsWith(`${label}\n`)
  );
}

test('src/hik.js preserves the public Hik API surface after the module split', async () => {
  const hik = await loadHikModule(8080);

  assert.deepEqual(
    Object.keys(hik).sort(),
    [
      'addCard',
      'addUser',
      'deleteUser',
      'getCapabilities',
      'getCard',
      'getUser',
      'listAvailableCards',
      'listAvailableSlots',
      'resetSlot',
      'revokeCard',
      'unlockDoor',
    ].sort()
  );
});

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
      /Device returned 401 for GET \/ISAPI\/AccessControl\/capabilities: forced stale/
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
      /Device returned 401 for PUT \/ISAPI\/AccessControl\/RemoteControl\/door\/1 without a digest challenge/
    );
  } finally {
    await device.close();
  }
});

test('addUser uses POST UserInfo/SetUp with the expected payload', async () => {
  const device = createAuthorizedApiServer(({ res }) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const port = await device.start();
  const hik = await loadHikModule(port);

  try {
    const result = await hik.addUser({
      employeeNo: 'EVZ-20260330141516-ABC123',
      name: 'Jane Doe',
      beginTime: '2026-03-30T00:00:00',
      endTime: '2026-07-15T23:59:59',
    });

    assert.equal(result.ok, true);
    const request = device.events.find((event) => event.type === 'authorized');
    const payload = JSON.parse(request.body);

    assert.equal(request.method, 'POST');
    assert.equal(request.route, '/ISAPI/AccessControl/UserInfo/SetUp?format=json');
    assert.deepEqual(payload, {
      UserInfo: {
        employeeNo: 'EVZ-20260330141516-ABC123',
        name: 'Jane Doe',
        userType: 'normal',
        Valid: {
          enable: true,
          beginTime: '2026-03-30T00:00:00',
          endTime: '2026-07-15T23:59:59',
        },
        doorRight: '1',
        RightPlan: [{ doorNo: 1, planTemplateNo: '1' }],
      },
    });
  } finally {
    await device.close();
  }
});

test('addUser supports the valid_only user-modify payload mode', async () => {
  const device = createAuthorizedApiServer(({ res }) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const port = await device.start();
  const hik = await loadHikModule(port, { HIK_USER_MODIFY_MODE: 'valid_only' });

  try {
    const result = await hik.addUser({
      employeeNo: 'EVZ-20260330141516-ABC123',
      name: 'Jane Doe',
      beginTime: '2026-03-30T00:00:00',
      endTime: '2026-07-15T23:59:59',
    });

    assert.equal(result.ok, true);
    const request = device.events.find((event) => event.type === 'authorized');
    const payload = JSON.parse(request.body);

    assert.equal(request.method, 'POST');
    assert.equal(request.route, '/ISAPI/AccessControl/UserInfo/SetUp?format=json');
    assert.deepEqual(payload, {
      UserInfo: {
        employeeNo: 'EVZ-20260330141516-ABC123',
        name: 'Jane Doe',
        userType: 'normal',
        Valid: {
          enable: true,
          beginTime: '2026-03-30T00:00:00',
          endTime: '2026-07-15T23:59:59',
        },
      },
    });
  } finally {
    await device.close();
  }
});

test('addUser supports the minimal user-modify payload mode', async () => {
  const device = createAuthorizedApiServer(({ res }) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const port = await device.start();
  const hik = await loadHikModule(port, { HIK_USER_MODIFY_MODE: 'minimal' });

  try {
    const result = await hik.addUser({
      employeeNo: 'EVZ-20260330141516-ABC123',
      name: 'Jane Doe',
      beginTime: '2026-03-30T00:00:00',
      endTime: '2026-07-15T23:59:59',
    });

    assert.equal(result.ok, true);
    const request = device.events.find((event) => event.type === 'authorized');
    const payload = JSON.parse(request.body);

    assert.equal(request.method, 'POST');
    assert.equal(request.route, '/ISAPI/AccessControl/UserInfo/SetUp?format=json');
    assert.deepEqual(payload, {
      UserInfo: {
        employeeNo: 'EVZ-20260330141516-ABC123',
        name: 'Jane Doe',
        userType: 'normal',
      },
    });
  } finally {
    await device.close();
  }
});

test('addCard uses POST CardInfo/SetUp to assign an existing card', async () => {
  const device = createAuthorizedApiServer(({ res }) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const port = await device.start();
  const hik = await loadHikModule(port);

  try {
    const result = await hik.addCard('EVZ-20260330141516-ABC123', 'EF-009999');

    assert.equal(result.ok, true);
    const request = device.events.find((event) => event.type === 'authorized');
    const payload = JSON.parse(request.body);

    assert.equal(request.method, 'POST');
    assert.equal(request.route, '/ISAPI/AccessControl/CardInfo/SetUp?format=json');
    assert.deepEqual(payload, {
      CardInfo: {
        employeeNo: 'EVZ-20260330141516-ABC123',
        cardNo: 'EF-009999',
        cardType: 'normalCard',
      },
    });
  } finally {
    await device.close();
  }
});

test('listAvailableCards paginates card search and returns only unassigned cards', async () => {
  const device = createAuthorizedApiServer(({ res, body }) => {
    const payload = JSON.parse(body);
    const position = payload.CardInfoSearchCond.searchResultPosition;

    res.writeHead(200, { 'Content-Type': 'application/json' });

    if (position === 0) {
      res.end(JSON.stringify({
        CardInfoSearch: {
          responseStatusStrg: 'MORE',
          numOfMatches: 2,
          totalMatches: 4,
          CardInfo: [
            { cardNo: 'EF-0002', employeeNo: '' },
            { cardNo: 'EF-0001', employeeNo: 'EMP-1' },
          ],
        },
      }));
      return;
    }

    if (position === 2) {
      res.end(JSON.stringify({
        CardInfoSearch: {
          responseStatusStrg: 'OK',
          numOfMatches: 2,
          totalMatches: 4,
          CardInfo: [
            { cardNo: 'EF-0003' },
            { cardNo: 'EF-0002', employeeNo: '' },
          ],
        },
      }));
      return;
    }

    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`unexpected position ${position}`);
  });
  const port = await device.start();
  const hik = await loadHikModule(port);

  try {
    const result = await hik.listAvailableCards();
    const requests = device.events.filter((event) => event.type === 'authorized');
    const searchBodies = requests.map((event) => JSON.parse(event.body));

    assert.deepEqual(result, {
      cards: [
        { cardNo: 'EF-0002' },
        { cardNo: 'EF-0003' },
      ],
    });
    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests.map((event) => [event.method, event.route]),
      [
        ['POST', '/ISAPI/AccessControl/CardInfo/Search?format=json'],
        ['POST', '/ISAPI/AccessControl/CardInfo/Search?format=json'],
      ]
    );
    assert.deepEqual(
      searchBodies.map((payload) => payload.CardInfoSearchCond.searchResultPosition),
      [0, 2]
    );
    assert.equal(searchBodies[0].CardInfoSearchCond.EmployeeNoList, undefined);
    assert.equal(searchBodies[0].CardInfoSearchCond.CardNoList, undefined);
  } finally {
    await device.close();
  }
});

test('listAvailableSlots paginates fully, canonicalizes employee numbers, and filters to reusable Hik slots', async () => {
  const device = createAuthorizedApiServer(({ req, res, body }) => {
    const payload = JSON.parse(body);

    if (req.url === '/ISAPI/AccessControl/UserInfo/Search?format=json') {
      const position = payload.UserInfoSearchCond.searchResultPosition;

      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (position === 0) {
        res.end(JSON.stringify({
          UserInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 2,
            totalMatches: 6,
            UserInfo: [
              {
                employeeNo: '33',
                name: 'B13',
                Valid: {
                  enable: true,
                  beginTime: '2020-01-01T00:00:00',
                  endTime: '2030-12-31T23:59:59',
                },
              },
              {
                employeeNo: '00000624',
                name: 'P55',
                Valid: {
                  enable: true,
                  beginTime: '2020-01-01T00:00:00',
                  endTime: '2030-12-31T23:59:59',
                },
              },
            ],
          },
        }));
        return;
      }

      if (position === 2) {
        res.end(JSON.stringify({
          UserInfoSearch: {
            responseStatusStrg: 'MORE',
            numOfMatches: 2,
            totalMatches: 6,
            UserInfo: [
              {
                employeeNo: '00000625',
                name: 'P56',
                Valid: {
                  enable: true,
                  beginTime: '2020-01-01T00:00:00',
                  endTime: '2030-12-31T23:59:59',
                },
              },
              {
                employeeNo: '00000608',
                name: 'P39 Shanelle Ragbar',
                Valid: {
                  enable: true,
                  beginTime: '2020-01-01T00:00:00',
                  endTime: '2030-12-31T23:59:59',
                },
              },
            ],
          },
        }));
        return;
      }

      if (position === 4) {
        res.end(JSON.stringify({
          UserInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 2,
            totalMatches: 6,
            UserInfo: [
              {
                employeeNo: '00000626',
                name: 'P57',
                Valid: {
                  enable: false,
                  beginTime: '2020-01-01T00:00:00',
                  endTime: '2030-12-31T23:59:59',
                },
              },
              {
                employeeNo: '00000627',
                name: 'P58',
                Valid: {
                  enable: true,
                  beginTime: '2030-01-01T00:00:00',
                  endTime: '2031-12-31T23:59:59',
                },
              },
            ],
          },
        }));
        return;
      }
    }

    if (req.url === '/ISAPI/AccessControl/CardInfo/Search?format=json') {
      const position = payload.CardInfoSearchCond.searchResultPosition;

      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (position === 0) {
        res.end(JSON.stringify({
          CardInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 2,
            totalMatches: 4,
            CardInfo: [
              { employeeNo: '00033', cardNo: '3581684316' },
              { employeeNo: '624', cardNo: '0105451261' },
            ],
          },
        }));
        return;
      }

      if (position === 2) {
        res.end(JSON.stringify({
          CardInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 2,
            totalMatches: 4,
            CardInfo: [
              { employeeNo: '625', cardNo: '0105747453' },
              { employeeNo: '608', cardNo: '0104615005' },
            ],
          },
        }));
        return;
      }
    }

    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`unexpected route ${req.url}`);
  });
  const port = await device.start();
  const hik = await loadHikModule(port);

  try {
    const result = await hik.listAvailableSlots({
      now: new Date('2026-03-30T14:15:16'),
    });

    assert.deepEqual(result, {
      slots: [
        {
          employeeNo: '33',
          cardNo: '3581684316',
          placeholderName: 'B13',
        },
        {
          employeeNo: '00000624',
          cardNo: '0105451261',
          placeholderName: 'P55',
        },
        {
          employeeNo: '00000625',
          cardNo: '0105747453',
          placeholderName: 'P56',
        },
      ],
      diagnostics: {
        userPages: 3,
        cardPages: 2,
        totalUsersScanned: 6,
        totalCardsScanned: 4,
        matchedPlaceholderUsers: 3,
        matchedJoinedSlots: 3,
        droppedUsers: {
          missingEmployeeNo: 0,
          missingPlaceholderName: 0,
          occupiedSlotName: 1,
          otherNonPlaceholderName: 0,
          invalidValidity: {
            total: 2,
            missingValid: 0,
            disabled: 1,
            invalidBeginTime: 0,
            futureBeginTime: 1,
            missingEndTime: 0,
            invalidEndTime: 0,
            expiredEndTime: 0,
          },
        },
        droppedCards: {
          missingEmployeeNo: 0,
          missingCardNo: 0,
        },
        droppedSlots: {
          withoutCard: 0,
        },
        cardBackedNonSlots: {
          total: 1,
          missingUserRecord: 0,
          missingPlaceholderName: 0,
          occupiedSlotName: 1,
          otherNonPlaceholderName: 0,
          invalidValidity: {
            total: 0,
            missingValid: 0,
            disabled: 0,
            invalidBeginTime: 0,
            futureBeginTime: 0,
            missingEndTime: 0,
            invalidEndTime: 0,
            expiredEndTime: 0,
          },
        },
      },
    });
  } finally {
    await device.close();
  }
});

test('listAvailableSlots returns exact one-digit and two-digit slot labels but keeps occupied slot-prefixed names unavailable', async () => {
  const device = createAuthorizedApiServer(({ req, res, body }) => {
    const payload = JSON.parse(body);

    if (req.url === '/ISAPI/AccessControl/UserInfo/Search?format=json') {
      const position = payload.UserInfoSearchCond.searchResultPosition;

      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (position === 0) {
        res.end(JSON.stringify({
          UserInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 5,
            totalMatches: 5,
            UserInfo: [
              {
                employeeNo: '00000604',
                name: 'P4',
                Valid: {
                  enable: true,
                  beginTime: '2020-01-01T00:00:00',
                  endTime: '2030-12-31T23:59:59',
                },
              },
              {
                employeeNo: '00000655',
                name: 'P55',
                Valid: {
                  enable: true,
                  beginTime: '2020-01-01T00:00:00',
                  endTime: '2030-12-31T23:59:59',
                },
              },
              {
                employeeNo: '00000605',
                name: 'P4 Ackeem Planter',
                Valid: {
                  enable: true,
                  beginTime: '2020-01-01T00:00:00',
                  endTime: '2025-01-01T00:00:00',
                },
              },
              {
                employeeNo: '00000656',
                name: 'P55 Waxsley Stewart-Betty',
                Valid: {
                  enable: true,
                  beginTime: '2020-01-01T00:00:00',
                  endTime: '2025-01-01T00:00:00',
                },
              },
              {
                employeeNo: '00000657',
                name: 'Front Desk',
                Valid: {
                  enable: true,
                  beginTime: '2020-01-01T00:00:00',
                  endTime: '2030-12-31T23:59:59',
                },
              },
            ],
          },
        }));
        return;
      }
    }

    if (req.url === '/ISAPI/AccessControl/CardInfo/Search?format=json') {
      const position = payload.CardInfoSearchCond.searchResultPosition;

      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (position === 0) {
        res.end(JSON.stringify({
          CardInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 5,
            totalMatches: 5,
            CardInfo: [
              { employeeNo: '604', cardNo: '0104604004' },
              { employeeNo: '655', cardNo: '0105451261' },
              { employeeNo: '605', cardNo: '0104605005' },
              { employeeNo: '656', cardNo: '0105456565' },
              { employeeNo: '657', cardNo: '0105456575' },
            ],
          },
        }));
        return;
      }
    }

    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`unexpected route ${req.url}`);
  });
  const port = await device.start();
  const hik = await loadHikModule(port);

  try {
    const result = await hik.listAvailableSlots({
      now: new Date('2026-03-30T14:15:16'),
    });

    assert.deepEqual(result, {
      slots: [
        {
          employeeNo: '00000604',
          cardNo: '0104604004',
          placeholderName: 'P4',
        },
        {
          employeeNo: '00000655',
          cardNo: '0105451261',
          placeholderName: 'P55',
        },
      ],
      diagnostics: {
        userPages: 1,
        cardPages: 1,
        totalUsersScanned: 5,
        totalCardsScanned: 5,
        matchedPlaceholderUsers: 2,
        matchedJoinedSlots: 2,
        droppedUsers: {
          missingEmployeeNo: 0,
          missingPlaceholderName: 0,
          occupiedSlotName: 2,
          otherNonPlaceholderName: 1,
          invalidValidity: {
            total: 0,
            missingValid: 0,
            disabled: 0,
            invalidBeginTime: 0,
            futureBeginTime: 0,
            missingEndTime: 0,
            invalidEndTime: 0,
            expiredEndTime: 0,
          },
        },
        droppedCards: {
          missingEmployeeNo: 0,
          missingCardNo: 0,
        },
        droppedSlots: {
          withoutCard: 0,
        },
        cardBackedNonSlots: {
          total: 3,
          missingUserRecord: 0,
          missingPlaceholderName: 0,
          occupiedSlotName: 2,
          otherNonPlaceholderName: 1,
          invalidValidity: {
            total: 0,
            missingValid: 0,
            disabled: 0,
            invalidBeginTime: 0,
            futureBeginTime: 0,
            missingEndTime: 0,
            invalidEndTime: 0,
            expiredEndTime: 0,
          },
        },
      },
    });
  } finally {
    await device.close();
  }
});

test('listAvailableSlots records granular validity diagnostics and JSON debug reports when enabled', async () => {
  const device = createAuthorizedApiServer(({ req, res, body }) => {
    const payload = JSON.parse(body);

    if (req.url === '/ISAPI/AccessControl/UserInfo/Search?format=json') {
      const position = payload.UserInfoSearchCond.searchResultPosition;

      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (position === 0) {
        res.end(JSON.stringify({
          UserInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 8,
            totalMatches: 8,
            UserInfo: [
              {
                employeeNo: '00000700',
                name: 'P70',
              },
              {
                employeeNo: '00000701',
                name: 'P71',
                Valid: {
                  enable: false,
                  beginTime: '2020-01-01T00:00:00',
                  endTime: '2030-12-31T23:59:59',
                },
              },
              {
                employeeNo: '00000702',
                name: 'P72',
                Valid: {
                  enable: true,
                  beginTime: 'not-a-date',
                  endTime: '2030-12-31T23:59:59',
                },
              },
              {
                employeeNo: '00000703',
                name: 'P73',
                Valid: {
                  enable: true,
                  beginTime: '2030-01-01T00:00:00',
                  endTime: '2031-12-31T23:59:59',
                },
              },
              {
                employeeNo: '00000704',
                name: 'P74',
                Valid: {
                  enable: true,
                  beginTime: '2020-01-01T00:00:00',
                },
              },
              {
                employeeNo: '00000705',
                name: 'P75',
                Valid: {
                  enable: true,
                  beginTime: '2020-01-01T00:00:00',
                  endTime: 'not-a-date',
                },
              },
              {
                employeeNo: '00000706',
                name: 'P76',
                Valid: {
                  enable: true,
                  beginTime: '2020-01-01T00:00:00',
                  endTime: '2025-01-01T00:00:00',
                },
              },
              {
                employeeNo: '00000707',
                name: 'P77',
                Valid: {
                  enable: true,
                  beginTime: '2020-01-01T00:00:00',
                  endTime: '2030-12-31T23:59:59',
                },
              },
            ],
          },
        }));
        return;
      }
    }

    if (req.url === '/ISAPI/AccessControl/CardInfo/Search?format=json') {
      const position = payload.CardInfoSearchCond.searchResultPosition;

      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (position === 0) {
        res.end(JSON.stringify({
          CardInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 1,
            totalMatches: 1,
            CardInfo: [
              { employeeNo: '707', cardNo: '0107070707' },
            ],
          },
        }));
        return;
      }
    }

    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`unexpected route ${req.url}`);
  });
  const port = await device.start();
  const hik = await loadHikModule(port, {
    HIK_DEBUG_AVAILABLE_SLOTS: '1',
  });
  const originalInfo = console.info;
  const infoCalls = [];

  console.info = (...args) => {
    infoCalls.push(args);
  };

  try {
    const result = await hik.listAvailableSlots({
      now: new Date('2026-03-30T14:15:16'),
    });

    assert.deepEqual(result, {
      slots: [
        {
          employeeNo: '00000707',
          cardNo: '0107070707',
          placeholderName: 'P77',
        },
      ],
      diagnostics: {
        userPages: 1,
        cardPages: 1,
        totalUsersScanned: 8,
        totalCardsScanned: 1,
        matchedPlaceholderUsers: 1,
        matchedJoinedSlots: 1,
        droppedUsers: {
          missingEmployeeNo: 0,
          missingPlaceholderName: 0,
          occupiedSlotName: 0,
          otherNonPlaceholderName: 0,
          invalidValidity: {
            total: 7,
            missingValid: 1,
            disabled: 1,
            invalidBeginTime: 1,
            futureBeginTime: 1,
            missingEndTime: 1,
            invalidEndTime: 1,
            expiredEndTime: 1,
          },
        },
        droppedCards: {
          missingEmployeeNo: 0,
          missingCardNo: 0,
        },
        droppedSlots: {
          withoutCard: 0,
        },
        cardBackedNonSlots: {
          total: 0,
          missingUserRecord: 0,
          missingPlaceholderName: 0,
          occupiedSlotName: 0,
          otherNonPlaceholderName: 0,
          invalidValidity: {
            total: 0,
            missingValid: 0,
            disabled: 0,
            invalidBeginTime: 0,
            futureBeginTime: 0,
            missingEndTime: 0,
            invalidEndTime: 0,
            expiredEndTime: 0,
          },
        },
      },
    });
    const userReport = findJsonLog(
      infoCalls,
      '[hik] listAvailableSlots scanned user records'
    );
    const cardReport = findJsonLog(
      infoCalls,
      '[hik] listAvailableSlots scanned card records'
    );
    const nonSlotReport = findJsonLog(
      infoCalls,
      '[hik] listAvailableSlots card-backed non-slots'
    );

    assert.equal(userReport.sampleLimit, 10);
    assert.equal(userReport.totalRelevantRecords, 8);
    assert.equal(userReport.omittedCount, 0);
    assert.deepEqual(
      userReport.records.map((record) => ({
        extractedName: record.extractedName,
        classification: record.classification,
        validityReason: record.validityReason,
      })),
      [
        {
          extractedName: 'P70',
          classification: 'invalidValidity',
          validityReason: 'missingValid',
        },
        {
          extractedName: 'P71',
          classification: 'invalidValidity',
          validityReason: 'disabled',
        },
        {
          extractedName: 'P72',
          classification: 'invalidValidity',
          validityReason: 'invalidBeginTime',
        },
        {
          extractedName: 'P73',
          classification: 'invalidValidity',
          validityReason: 'futureBeginTime',
        },
        {
          extractedName: 'P74',
          classification: 'invalidValidity',
          validityReason: 'missingEndTime',
        },
        {
          extractedName: 'P75',
          classification: 'invalidValidity',
          validityReason: 'invalidEndTime',
        },
        {
          extractedName: 'P76',
          classification: 'invalidValidity',
          validityReason: 'expiredEndTime',
        },
        {
          extractedName: 'P77',
          classification: 'validPlaceholder',
          validityReason: null,
        },
      ]
    );

    const missingValidSample = userReport.records[0];
    assert.equal(missingValidSample.rawUserInfo.Valid, undefined);
    assert.equal(missingValidSample.normalizedValidity.hasValidObject, false);
    assert.equal(missingValidSample.normalizedValidity.enableRaw, null);
    assert.equal(missingValidSample.normalizedValidity.enable, false);

    const invalidEndTimeSample = userReport.records[5];
    assert.equal(invalidEndTimeSample.rawUserInfo.Valid.endTime, 'not-a-date');
    assert.equal(invalidEndTimeSample.normalizedValidity.endTime, 'not-a-date');
    assert.equal(invalidEndTimeSample.normalizedValidity.endTimestamp, null);
    assert.equal(typeof invalidEndTimeSample.normalizedValidity.nowTimestamp, 'number');

    assert.equal(cardReport.totalRelevantRecords, 0);
    assert.deepEqual(cardReport.records, []);
    assert.equal(nonSlotReport.totalRelevantRecords, 0);
    assert.deepEqual(nonSlotReport.records, []);
  } finally {
    console.info = originalInfo;
    await device.close();
  }
});

test('listAvailableSlots reports card-backed non-slots by card number and captures name-like fields', async () => {
  const device = createAuthorizedApiServer(({ req, res, body }) => {
    const payload = JSON.parse(body);

    if (req.url === '/ISAPI/AccessControl/UserInfo/Search?format=json') {
      const position = payload.UserInfoSearchCond.searchResultPosition;

      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (position === 0) {
        res.end(JSON.stringify({
          UserInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 1,
            totalMatches: 1,
            UserInfo: [
              {
                employeeNo: '00000624',
                name: 'Front Desk',
                displayName: 'P55',
                aliasName: 'P55',
              },
            ],
          },
        }));
        return;
      }
    }

    if (req.url === '/ISAPI/AccessControl/CardInfo/Search?format=json') {
      const position = payload.CardInfoSearchCond.searchResultPosition;

      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (position === 0) {
        res.end(JSON.stringify({
          CardInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 1,
            totalMatches: 1,
            CardInfo: [
              { employeeNo: '624', cardNo: '0105451261' },
            ],
          },
        }));
        return;
      }
    }

    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`unexpected route ${req.url}`);
  });
  const port = await device.start();
  const hik = await loadHikModule(port, {
    HIK_DEBUG_AVAILABLE_SLOTS: '1',
  });
  const originalInfo = console.info;
  const infoCalls = [];

  console.info = (...args) => {
    infoCalls.push(args);
  };

  try {
    const result = await hik.listAvailableSlots({
      now: new Date('2026-03-30T14:15:16'),
    });

    assert.deepEqual(result, {
      slots: [],
      diagnostics: {
        userPages: 1,
        cardPages: 1,
        totalUsersScanned: 1,
        totalCardsScanned: 1,
        matchedPlaceholderUsers: 0,
        matchedJoinedSlots: 0,
        droppedUsers: {
          missingEmployeeNo: 0,
          missingPlaceholderName: 0,
          occupiedSlotName: 0,
          otherNonPlaceholderName: 1,
          invalidValidity: {
            total: 0,
            missingValid: 0,
            disabled: 0,
            invalidBeginTime: 0,
            futureBeginTime: 0,
            missingEndTime: 0,
            invalidEndTime: 0,
            expiredEndTime: 0,
          },
        },
        droppedCards: {
          missingEmployeeNo: 0,
          missingCardNo: 0,
        },
        droppedSlots: {
          withoutCard: 0,
        },
        cardBackedNonSlots: {
          total: 1,
          missingUserRecord: 0,
          missingPlaceholderName: 0,
          occupiedSlotName: 0,
          otherNonPlaceholderName: 1,
          invalidValidity: {
            total: 0,
            missingValid: 0,
            disabled: 0,
            invalidBeginTime: 0,
            futureBeginTime: 0,
            missingEndTime: 0,
            invalidEndTime: 0,
            expiredEndTime: 0,
          },
        },
      },
    });

    const userReport = findJsonLog(
      infoCalls,
      '[hik] listAvailableSlots scanned user records'
    );
    const cardReport = findJsonLog(
      infoCalls,
      '[hik] listAvailableSlots scanned card records'
    );
    const nonSlotReport = findJsonLog(
      infoCalls,
      '[hik] listAvailableSlots card-backed non-slots'
    );

    assert.deepEqual(userReport.records[0].nameCandidates, {
      name: 'Front Desk',
      displayName: 'P55',
      aliasName: 'P55',
    });
    assert.deepEqual(userReport.records[0].matchingPlaceholderNames, [
      {
        key: 'displayName',
        value: 'P55',
      },
    ]);
    assert.equal(userReport.records[0].slotToken, null);
    assert.deepEqual(userReport.records[0].slotTokenCandidates, [
      {
        key: 'displayName',
        value: 'P55',
        slotToken: 'P55',
        exactMatch: true,
      },
      {
        key: 'aliasName',
        value: 'P55',
        slotToken: 'P55',
        exactMatch: true,
      },
    ]);
    assert.equal(userReport.records[0].classification, 'otherNonPlaceholderName');

    assert.deepEqual(cardReport.records, [
      {
        key: '0105451261',
        cardNo: '0105451261',
        employeeNo: '624',
        canonicalEmployeeNo: '624',
        debugMatchedBy: ['cardBackedNonSlot'],
        rawCardInfo: {
          employeeNo: '624',
          cardNo: '0105451261',
        },
      },
    ]);

    assert.deepEqual(nonSlotReport.records, [
      {
        key: '0105451261 • P55',
        cardNo: '0105451261',
        employeeNo: '624',
        canonicalEmployeeNo: '624',
        placeholderNameHint: 'P55',
        slotToken: null,
        extractedName: 'Front Desk',
        nameCandidates: {
          name: 'Front Desk',
          displayName: 'P55',
          aliasName: 'P55',
        },
        matchingPlaceholderNames: [
          {
            key: 'displayName',
            value: 'P55',
          },
        ],
        slotTokenCandidates: [
          {
            key: 'displayName',
            value: 'P55',
            slotToken: 'P55',
            exactMatch: true,
          },
          {
            key: 'aliasName',
            value: 'P55',
            slotToken: 'P55',
            exactMatch: true,
          },
        ],
        userRecordFound: true,
        userClassification: 'otherNonPlaceholderName',
        validityEvaluated: false,
        isCurrentlyValid: null,
        validityReason: null,
        normalizedValidity: null,
        debugMatchedBy: [],
        rawCardInfo: {
          employeeNo: '624',
          cardNo: '0105451261',
        },
        rawUserInfo: {
          employeeNo: '00000624',
          name: 'Front Desk',
          displayName: 'P55',
          aliasName: 'P55',
        },
      },
    ]);
  } finally {
    console.info = originalInfo;
    await device.close();
  }
});

test('listAvailableSlots reports missing user records for card-backed non-slots', async () => {
  const device = createAuthorizedApiServer(({ req, res, body }) => {
    const payload = JSON.parse(body);

    if (req.url === '/ISAPI/AccessControl/UserInfo/Search?format=json') {
      const position = payload.UserInfoSearchCond.searchResultPosition;

      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (position === 0) {
        res.end(JSON.stringify({
          UserInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 0,
            totalMatches: 0,
            UserInfo: [],
          },
        }));
        return;
      }
    }

    if (req.url === '/ISAPI/AccessControl/CardInfo/Search?format=json') {
      const position = payload.CardInfoSearchCond.searchResultPosition;

      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (position === 0) {
        res.end(JSON.stringify({
          CardInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 1,
            totalMatches: 1,
            CardInfo: [
              { employeeNo: '902', cardNo: '0109999999' },
            ],
          },
        }));
        return;
      }
    }

    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`unexpected route ${req.url}`);
  });
  const port = await device.start();
  const hik = await loadHikModule(port, {
    HIK_DEBUG_AVAILABLE_SLOTS: '1',
  });
  const originalInfo = console.info;
  const infoCalls = [];

  console.info = (...args) => {
    infoCalls.push(args);
  };

  try {
    const result = await hik.listAvailableSlots({
      now: new Date('2026-03-30T14:15:16'),
    });

    assert.equal(result.diagnostics.cardBackedNonSlots.total, 1);
    assert.equal(result.diagnostics.cardBackedNonSlots.missingUserRecord, 1);

    const nonSlotReport = findJsonLog(
      infoCalls,
      '[hik] listAvailableSlots card-backed non-slots'
    );

    assert.deepEqual(nonSlotReport.records, [
      {
        key: '0109999999',
        cardNo: '0109999999',
        employeeNo: '902',
        canonicalEmployeeNo: '902',
        placeholderNameHint: null,
        slotToken: null,
        extractedName: null,
        nameCandidates: {},
        matchingPlaceholderNames: [],
        slotTokenCandidates: [],
        userRecordFound: false,
        userClassification: 'missingUserRecord',
        validityEvaluated: false,
        isCurrentlyValid: null,
        validityReason: null,
        normalizedValidity: null,
        debugMatchedBy: [],
        rawCardInfo: {
          employeeNo: '902',
          cardNo: '0109999999',
        },
        rawUserInfo: null,
      },
    ]);
  } finally {
    console.info = originalInfo;
    await device.close();
  }
});

test('listAvailableSlots focused placeholder and card filters override generic debug sample limits', async () => {
  const userInfo = Array.from({ length: 12 }, (_, index) => {
    const employeeNo = `000009${String(index).padStart(2, '0')}`;

    if (index === 11) {
      return {
        employeeNo,
        name: 'P55 John Doe',
        displayName: 'Occupied member',
      };
    }

    return {
      employeeNo,
      name: `Member ${String(index).padStart(2, '0')}`,
      displayName: `Guest ${String(index).padStart(2, '0')}`,
    };
  });
  const cardInfo = Array.from({ length: 12 }, (_, index) => ({
    employeeNo: String(900 + index),
    cardNo:
      index === 11 ? '9999999999' : `01000000${String(index).padStart(2, '0')}`,
  }));
  const device = createAuthorizedApiServer(({ req, res, body }) => {
    if (req.url === '/ISAPI/AccessControl/capabilities') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        AccessControlCapabilities: {
          userLimit: 5000,
          cardLimit: 5000,
        },
      }));
      return;
    }

    if (req.url === '/ISAPI/AccessControl/UserInfo/Count?format=json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        UserInfoCount: {
          userNumber: 12,
        },
      }));
      return;
    }

    if (req.url === '/ISAPI/AccessControl/CardInfo/Count?format=json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        CardInfoCount: {
          cardNumber: 12,
        },
      }));
      return;
    }

    const payload = JSON.parse(body);

    if (req.url === '/ISAPI/AccessControl/UserInfo/Search?format=json') {
      const requestedEmployeeNos = (payload.UserInfoSearchCond.EmployeeNoList ?? []).map(
        (entry) => entry.employeeNo
      );
      const fuzzySearch = payload.UserInfoSearchCond.fuzzySearch ?? '';
      const position = payload.UserInfoSearchCond.searchResultPosition;

      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (requestedEmployeeNos.length > 0) {
        const requestedCanonicalEmployeeNos = requestedEmployeeNos.map((value) =>
          value.replace(/^0+/, '') || '0'
        );
        const matchingUsers = userInfo.filter((entry) =>
          requestedCanonicalEmployeeNos.includes(entry.employeeNo.replace(/^0+/, '') || '0')
        );

        res.end(JSON.stringify({
          UserInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: matchingUsers.length,
            totalMatches: matchingUsers.length,
            UserInfo: matchingUsers,
          },
        }));
        return;
      }

      if (fuzzySearch) {
        const matchingUsers = userInfo.filter((entry) =>
          [entry.name, entry.displayName]
            .filter(Boolean)
            .some((value) => value.includes(fuzzySearch))
        );

        res.end(JSON.stringify({
          UserInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: matchingUsers.length,
            totalMatches: matchingUsers.length,
            UserInfo: matchingUsers,
          },
        }));
        return;
      }

      if (position === 0) {
        res.end(JSON.stringify({
          UserInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 12,
            totalMatches: 12,
            UserInfo: userInfo,
          },
        }));
        return;
      }
    }

    if (req.url === '/ISAPI/AccessControl/CardInfo/Search?format=json') {
      const requestedCardNos = (payload.CardInfoSearchCond.CardNoList ?? []).map(
        (entry) => entry.cardNo
      );
      const position = payload.CardInfoSearchCond.searchResultPosition;

      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (requestedCardNos.length > 0) {
        const matchingCards = cardInfo.filter((entry) =>
          requestedCardNos.includes(entry.cardNo)
        );

        res.end(JSON.stringify({
          CardInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: matchingCards.length,
            totalMatches: matchingCards.length,
            CardInfo: matchingCards,
          },
        }));
        return;
      }

      if (position === 0) {
        res.end(JSON.stringify({
          CardInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 12,
            totalMatches: 12,
            CardInfo: cardInfo,
          },
        }));
        return;
      }
    }

    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`unexpected route ${req.url}`);
  });
  const port = await device.start();
  const hik = await loadHikModule(port, {
    HIK_DEBUG_AVAILABLE_SLOTS: '1',
    HIK_DEBUG_AVAILABLE_SLOTS_PLACEHOLDER_NAMES: 'P55',
    HIK_DEBUG_AVAILABLE_SLOTS_CARD_NOS: '9999999999',
  });
  const originalInfo = console.info;
  const infoCalls = [];

  console.info = (...args) => {
    infoCalls.push(args);
  };

  try {
    await hik.listAvailableSlots({
      now: new Date('2026-03-30T14:15:16'),
    });

    const cardReport = findJsonLog(
      infoCalls,
      '[hik] listAvailableSlots scanned card records'
    );
    const nonSlotReport = findJsonLog(
      infoCalls,
      '[hik] listAvailableSlots card-backed non-slots'
    );
    const focusedPageTraceReport = findJsonLog(
      infoCalls,
      '[hik] listAvailableSlots focused bulk page trace'
    );
    const focusedUserFuzzyProbeReport = findJsonLog(
      infoCalls,
      '[hik] listAvailableSlots focused direct user fuzzy probes'
    );
    const focusedComparisonReport = findJsonLog(
      infoCalls,
      '[hik] listAvailableSlots focused comparison report'
    );

    assert.equal(cardReport.sampleLimit, 10);
    assert.equal(cardReport.totalRelevantRecords, 12);
    assert.equal(cardReport.omittedCount, 1);
    assert.equal(
      cardReport.records.some((record) => record.cardNo === '9999999999'),
      true
    );

    assert.equal(nonSlotReport.sampleLimit, 10);
    assert.equal(nonSlotReport.totalRelevantRecords, 12);
    assert.equal(nonSlotReport.omittedCount, 1);
    assert.deepEqual(
      nonSlotReport.records.find((record) => record.cardNo === '9999999999'),
      {
        key: '9999999999 • P55',
        cardNo: '9999999999',
        employeeNo: '911',
        canonicalEmployeeNo: '911',
        placeholderNameHint: null,
        slotToken: 'P55',
        extractedName: 'P55 John Doe',
        nameCandidates: {
          name: 'P55 John Doe',
          displayName: 'Occupied member',
        },
        matchingPlaceholderNames: [],
        slotTokenCandidates: [
          {
            key: 'name',
            value: 'P55 John Doe',
            slotToken: 'P55',
            exactMatch: false,
          },
        ],
        userRecordFound: true,
        userClassification: 'occupiedSlotName',
        validityEvaluated: false,
        isCurrentlyValid: null,
        validityReason: null,
        normalizedValidity: null,
        debugMatchedBy: ['focusedPlaceholderName', 'focusedCardNo'],
        rawCardInfo: {
          employeeNo: '911',
          cardNo: '9999999999',
        },
        rawUserInfo: {
          employeeNo: '00000911',
          name: 'P55 John Doe',
          displayName: 'Occupied member',
        },
      }
    );

    assert.equal(focusedPageTraceReport.userPages[0].containsFocusedSlotTokenPrefix, true);
    assert.deepEqual(
      focusedPageTraceReport.userPages[0].matchingFocusedSlotTokenPrefixes,
      ['P55']
    );
    assert.equal(focusedPageTraceReport.cardPages[0].containsFocusedCardNo, true);
    assert.deepEqual(
      focusedComparisonReport.records,
      [
        {
          key: '9999999999 • P55',
          cardNo: '9999999999',
          slotTokens: ['P55'],
          classification: 'foundInBulkAndDirect',
          bulkCardFound: true,
          bulkFocusedUserSeen: true,
          directCardProbeStatus: 'found',
          directCardProbeError: null,
          directUserFuzzyHit: true,
          bulkEmployeeNo: '911',
          directEmployeeNos: ['911'],
          bulkUserName: 'P55 John Doe',
          directUserNames: ['P55 John Doe'],
          bulkSlotToken: 'P55',
          directSlotTokens: ['P55'],
          bulkCard: {
            employeeNo: '911',
            canonicalEmployeeNo: '911',
            rawCardInfo: {
              employeeNo: '911',
              cardNo: '9999999999',
              cardType: null,
            },
          },
          bulkUser: {
            employeeNo: '00000911',
            canonicalEmployeeNo: '911',
            extractedName: 'P55 John Doe',
            slotToken: 'P55',
            rawUserInfo: {
              employeeNo: '00000911',
              name: 'P55 John Doe',
              Valid: null,
            },
          },
          bulkFocusedUsers: [
            {
              employeeNo: '00000911',
              canonicalEmployeeNo: '911',
              extractedName: 'P55 John Doe',
              slotToken: 'P55',
              classification: 'occupiedSlotName',
              rawUserInfo: {
                employeeNo: '00000911',
                name: 'P55 John Doe',
                Valid: null,
              },
            },
          ],
          directCards: [
            {
              employeeNo: '911',
              canonicalEmployeeNo: '911',
              rawCardInfo: {
                employeeNo: '911',
                cardNo: '9999999999',
                cardType: null,
              },
            },
          ],
          directUsers: [
            {
              employeeNo: '00000911',
              canonicalEmployeeNo: '911',
              extractedName: 'P55 John Doe',
              slotToken: 'P55',
              classification: 'occupiedSlotName',
              rawUserInfo: {
                employeeNo: '00000911',
                name: 'P55 John Doe',
                Valid: null,
              },
            },
          ],
          directUserFuzzyProbes: [
            {
              query: '9999999999',
              purpose: 'focusedCardNo',
              status: 'noMatch',
              returnedEmployeeNos: [],
              returnedNames: [],
              error: null,
            },
            {
              query: 'P55',
              purpose: 'focusedPlaceholderName',
              status: 'found',
              returnedEmployeeNos: ['00000911'],
              returnedNames: ['P55 John Doe'],
              error: null,
            },
          ],
        },
      ]
    );
    assert.deepEqual(
      focusedUserFuzzyProbeReport.probes.map((probe) => ({
        query: probe.query,
        purpose: probe.purpose,
        status: probe.status,
      })),
      [
        {
          query: '9999999999',
          purpose: 'focusedCardNo',
          status: 'noMatch',
        },
        {
          query: 'P55',
          purpose: 'focusedPlaceholderName',
          status: 'found',
        },
      ]
    );
  } finally {
    console.info = originalInfo;
    await device.close();
  }
});

test('listAvailableSlots focused comparison report marks focused cards found only by direct probe', async () => {
  const device = createAuthorizedApiServer(({ req, res, body }) => {
    if (req.url === '/ISAPI/AccessControl/capabilities') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        AccessControlCapabilities: {
          userLimit: 5000,
          cardLimit: 5000,
        },
      }));
      return;
    }

    if (req.url === '/ISAPI/AccessControl/UserInfo/Count?format=json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        UserInfoCount: {
          userNumber: 1,
        },
      }));
      return;
    }

    if (req.url === '/ISAPI/AccessControl/CardInfo/Count?format=json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        CardInfoCount: {
          cardNumber: 1,
        },
      }));
      return;
    }

    const payload = JSON.parse(body);

    if (req.url === '/ISAPI/AccessControl/UserInfo/Search?format=json') {
      const requestedEmployeeNos = (payload.UserInfoSearchCond.EmployeeNoList ?? []).map(
        (entry) => entry.employeeNo
      );
      const fuzzySearch = payload.UserInfoSearchCond.fuzzySearch ?? '';
      const position = payload.UserInfoSearchCond.searchResultPosition;

      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (requestedEmployeeNos.length > 0) {
        res.end(JSON.stringify({
          UserInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 1,
            totalMatches: 1,
            UserInfo: [
              {
                employeeNo: '00000955',
                name: 'P55',
                Valid: {
                  enable: true,
                  beginTime: '2020-01-01T00:00:00',
                  endTime: '2030-12-31T23:59:59',
                },
              },
            ],
          },
        }));
        return;
      }

      if (fuzzySearch) {
        const matchingUsers = fuzzySearch === 'P55'
          ? [
              {
                employeeNo: '00000955',
                name: 'P55',
                Valid: {
                  enable: true,
                  beginTime: '2020-01-01T00:00:00',
                  endTime: '2030-12-31T23:59:59',
                },
              },
            ]
          : [];

        res.end(JSON.stringify({
          UserInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: matchingUsers.length,
            totalMatches: matchingUsers.length,
            UserInfo: matchingUsers,
          },
        }));
        return;
      }

      if (position === 0) {
        res.end(JSON.stringify({
          UserInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 1,
            totalMatches: 1,
            UserInfo: [
              {
                employeeNo: '00000001',
                name: 'A1 Kimberly Connell',
                Valid: {
                  enable: true,
                  beginTime: '2020-01-01T00:00:00',
                  endTime: '2030-12-31T23:59:59',
                },
              },
            ],
          },
        }));
        return;
      }
    }

    if (req.url === '/ISAPI/AccessControl/CardInfo/Search?format=json') {
      const requestedCardNos = (payload.CardInfoSearchCond.CardNoList ?? []).map(
        (entry) => entry.cardNo
      );
      const position = payload.CardInfoSearchCond.searchResultPosition;

      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (requestedCardNos.length > 0) {
        res.end(JSON.stringify({
          CardInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 1,
            totalMatches: 1,
            CardInfo: [
              {
                employeeNo: '955',
                cardNo: '0105451261',
                cardType: 'normalCard',
              },
            ],
          },
        }));
        return;
      }

      if (position === 0) {
        res.end(JSON.stringify({
          CardInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 1,
            totalMatches: 1,
            CardInfo: [
              {
                employeeNo: '1',
                cardNo: '0100000001',
                cardType: 'normalCard',
              },
            ],
          },
        }));
        return;
      }
    }

    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`unexpected route ${req.url}`);
  });
  const port = await device.start();
  const hik = await loadHikModule(port, {
    HIK_DEBUG_AVAILABLE_SLOTS: '1',
    HIK_DEBUG_AVAILABLE_SLOTS_PLACEHOLDER_NAMES: 'P55',
    HIK_DEBUG_AVAILABLE_SLOTS_CARD_NOS: '0105451261',
  });
  const originalInfo = console.info;
  const infoCalls = [];

  console.info = (...args) => {
    infoCalls.push(args);
  };

  try {
    await hik.listAvailableSlots({
      now: new Date('2026-03-30T14:15:16'),
    });

    const directProbeReport = findJsonLog(
      infoCalls,
      '[hik] listAvailableSlots focused direct card probes'
    );
    const directUserFuzzyReport = findJsonLog(
      infoCalls,
      '[hik] listAvailableSlots focused direct user fuzzy probes'
    );
    const comparisonReport = findJsonLog(
      infoCalls,
      '[hik] listAvailableSlots focused comparison report'
    );

    assert.equal(directProbeReport.probes.length, 1);
    assert.deepEqual(directProbeReport.probes[0].request, {
      searchID: 'focused-card-probe-1',
      searchResultPosition: 0,
      maxResults: 30,
      cardNoList: ['0105451261'],
    });
    assert.equal(directProbeReport.probes[0].directCardProbeStatus, 'found');
    assert.equal(directProbeReport.probes[0].responseStatusStrg, 'OK');
    assert.equal(directProbeReport.probes[0].numOfMatches, 1);
    assert.equal(directProbeReport.probes[0].totalMatches, 1);
    assert.deepEqual(directProbeReport.probes[0].returnedEmployeeNos, ['955']);
    assert.deepEqual(directProbeReport.probes[0].rawCardInfo, [
      {
        employeeNo: '955',
        cardNo: '0105451261',
        cardType: 'normalCard',
      },
    ]);
    assert.equal(directProbeReport.probes[0].userProbes.length, 1);
    assert.deepEqual(directProbeReport.probes[0].userProbes[0].request, {
      searchID: 'focused-user-probe-1-1',
      searchResultPosition: 0,
      maxResults: 30,
      employeeNoList: ['955'],
    });
    assert.equal(directProbeReport.probes[0].userProbes[0].responseStatusStrg, 'OK');
    assert.deepEqual(directProbeReport.probes[0].userProbes[0].returnedNames, ['P55']);
    assert.equal(
      directProbeReport.probes[0].userProbes[0].userRecords[0].classification,
      'validPlaceholder'
    );
    assert.equal(
      directProbeReport.probes[0].userProbes[0].userRecords[0].slotToken,
      'P55'
    );
    assert.deepEqual(
      directUserFuzzyReport.probes.map((probe) => ({
        query: probe.query,
        purpose: probe.purpose,
        status: probe.status,
      })),
      [
        {
          query: '0105451261',
          purpose: 'focusedCardNo',
          status: 'noMatch',
        },
        {
          query: 'P55',
          purpose: 'focusedPlaceholderName',
          status: 'found',
        },
      ]
    );

    assert.deepEqual(comparisonReport.records, [
      {
        key: '0105451261 • P55',
        cardNo: '0105451261',
        slotTokens: ['P55'],
        classification: 'foundDirectOnly',
        bulkCardFound: false,
        bulkFocusedUserSeen: false,
        directCardProbeStatus: 'found',
        directCardProbeError: null,
        directUserFuzzyHit: true,
        bulkEmployeeNo: null,
        directEmployeeNos: ['955'],
        bulkUserName: null,
        directUserNames: ['P55'],
        bulkSlotToken: null,
        directSlotTokens: ['P55'],
        bulkCard: null,
        bulkUser: null,
        bulkFocusedUsers: [],
        directCards: [
          {
            employeeNo: '955',
            canonicalEmployeeNo: '955',
            rawCardInfo: {
              employeeNo: '955',
              cardNo: '0105451261',
              cardType: 'normalCard',
            },
          },
        ],
        directUsers: [
          {
            employeeNo: '00000955',
            canonicalEmployeeNo: '955',
            extractedName: 'P55',
            slotToken: 'P55',
            classification: 'validPlaceholder',
            rawUserInfo: {
              employeeNo: '00000955',
              name: 'P55',
              Valid: {
                enable: true,
                beginTime: '2020-01-01T00:00:00',
                endTime: '2030-12-31T23:59:59',
              },
            },
          },
        ],
        directUserFuzzyProbes: [
          {
            query: '0105451261',
            purpose: 'focusedCardNo',
            status: 'noMatch',
            returnedEmployeeNos: [],
            returnedNames: [],
            error: null,
          },
          {
            query: 'P55',
            purpose: 'focusedPlaceholderName',
            status: 'found',
            returnedEmployeeNos: ['00000955'],
            returnedNames: ['P55'],
            error: null,
          },
        ],
      },
    ]);
  } finally {
    console.info = originalInfo;
    await device.close();
  }
});

test('listAvailableSlots focused comparison report marks focused cards missing from both bulk and direct probes', async () => {
  const device = createAuthorizedApiServer(({ req, res, body }) => {
    if (req.url === '/ISAPI/AccessControl/capabilities') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        AccessControlCapabilities: {
          userLimit: 5000,
          cardLimit: 5000,
        },
      }));
      return;
    }

    if (req.url === '/ISAPI/AccessControl/UserInfo/Count?format=json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        UserInfoCount: {
          userNumber: 0,
        },
      }));
      return;
    }

    if (req.url === '/ISAPI/AccessControl/CardInfo/Count?format=json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        CardInfoCount: {
          cardNumber: 0,
        },
      }));
      return;
    }

    const payload = JSON.parse(body);

    if (req.url === '/ISAPI/AccessControl/UserInfo/Search?format=json') {
      const fuzzySearch = payload.UserInfoSearchCond.fuzzySearch ?? '';
      const position = payload.UserInfoSearchCond.searchResultPosition;

      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (fuzzySearch) {
        res.end(JSON.stringify({
          UserInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 0,
            totalMatches: 0,
            UserInfo: [],
          },
        }));
        return;
      }

      if (position === 0) {
        res.end(JSON.stringify({
          UserInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 0,
            totalMatches: 0,
            UserInfo: [],
          },
        }));
        return;
      }
    }

    if (req.url === '/ISAPI/AccessControl/CardInfo/Search?format=json') {
      const position = payload.CardInfoSearchCond.searchResultPosition;

      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (position === 0) {
        res.end(JSON.stringify({
          CardInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 0,
            totalMatches: 0,
            CardInfo: [],
          },
        }));
        return;
      }
    }

    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`unexpected route ${req.url}`);
  });
  const port = await device.start();
  const hik = await loadHikModule(port, {
    HIK_DEBUG_AVAILABLE_SLOTS: '1',
    HIK_DEBUG_AVAILABLE_SLOTS_PLACEHOLDER_NAMES: 'P55',
    HIK_DEBUG_AVAILABLE_SLOTS_CARD_NOS: '0105451261',
  });
  const originalInfo = console.info;
  const infoCalls = [];

  console.info = (...args) => {
    infoCalls.push(args);
  };

  try {
    await hik.listAvailableSlots({
      now: new Date('2026-03-30T14:15:16'),
    });

    const comparisonReport = findJsonLog(
      infoCalls,
      '[hik] listAvailableSlots focused comparison report'
    );

    assert.deepEqual(comparisonReport.records, [
      {
        key: '0105451261 • P55',
        cardNo: '0105451261',
        slotTokens: ['P55'],
        classification: 'notFoundAnywhere',
        bulkCardFound: false,
        bulkFocusedUserSeen: false,
        directCardProbeStatus: 'noMatch',
        directCardProbeError: null,
        directUserFuzzyHit: false,
        bulkEmployeeNo: null,
        directEmployeeNos: [],
        bulkUserName: null,
        directUserNames: [],
        bulkSlotToken: null,
        directSlotTokens: [],
        bulkCard: null,
        bulkUser: null,
        bulkFocusedUsers: [],
        directCards: [],
        directUsers: [],
        directUserFuzzyProbes: [
          {
            query: '0105451261',
            purpose: 'focusedCardNo',
            status: 'noMatch',
            returnedEmployeeNos: [],
            returnedNames: [],
            error: null,
          },
          {
            query: 'P55',
            purpose: 'focusedPlaceholderName',
            status: 'noMatch',
            returnedEmployeeNos: [],
            returnedNames: [],
            error: null,
          },
        ],
      },
    ]);
  } finally {
    console.info = originalInfo;
    await device.close();
  }
});

test('listAvailableSlots marks unsupported CardNoList probes as inconclusive instead of clean misses', async () => {
  const device = createAuthorizedApiServer(({ req, res, body }) => {
    if (req.url === '/ISAPI/AccessControl/capabilities') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        AccessControlCapabilities: {
          userLimit: 900,
          cardLimit: 870,
        },
      }));
      return;
    }

    if (req.url === '/ISAPI/AccessControl/UserInfo/Count?format=json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        UserInfoCount: {
          userNumber: 581,
        },
      }));
      return;
    }

    if (req.url === '/ISAPI/AccessControl/CardInfo/Count?format=json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        CardInfoCount: {
          cardNumber: 569,
        },
      }));
      return;
    }

    const payload = JSON.parse(body);

    if (req.url === '/ISAPI/AccessControl/UserInfo/Search?format=json') {
      const fuzzySearch = payload.UserInfoSearchCond.fuzzySearch ?? '';
      const position = payload.UserInfoSearchCond.searchResultPosition;

      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (fuzzySearch || position === 0) {
        res.end(JSON.stringify({
          UserInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 0,
            totalMatches: 0,
            UserInfo: [],
          },
        }));
        return;
      }
    }

    if (req.url === '/ISAPI/AccessControl/CardInfo/Search?format=json') {
      const requestedCardNos = (payload.CardInfoSearchCond.CardNoList ?? []).map(
        (entry) => entry.cardNo
      );
      const position = payload.CardInfoSearchCond.searchResultPosition;

      if (requestedCardNos.length > 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          statusCode: 6,
          statusString: 'Invalid Content',
          subStatusCode: 'badParameters',
          errorCode: 1610612737,
          errorMsg: '0x60000001',
        }));
        return;
      }

      if (position === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          CardInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 0,
            totalMatches: 0,
            CardInfo: [],
          },
        }));
        return;
      }
    }

    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`unexpected route ${req.url}`);
  });
  const port = await device.start();
  const hik = await loadHikModule(port, {
    HIK_DEBUG_AVAILABLE_SLOTS: '1',
    HIK_DEBUG_AVAILABLE_SLOTS_PLACEHOLDER_NAMES: 'P55',
    HIK_DEBUG_AVAILABLE_SLOTS_CARD_NOS: '0105451261',
  });
  const originalInfo = console.info;
  const infoCalls = [];

  console.info = (...args) => {
    infoCalls.push(args);
  };

  try {
    await hik.listAvailableSlots({
      now: new Date('2026-03-30T14:15:16'),
    });

    const directCardProbeReport = findJsonLog(
      infoCalls,
      '[hik] listAvailableSlots focused direct card probes'
    );
    const comparisonReport = findJsonLog(
      infoCalls,
      '[hik] listAvailableSlots focused comparison report'
    );

    assert.equal(directCardProbeReport.probes[0].directCardProbeStatus, 'unsupported');
    assert.match(directCardProbeReport.probes[0].error, /badParameters/);
    assert.match(comparisonReport.records[0].directCardProbeError, /badParameters/);
    assert.deepEqual([
      {
        ...comparisonReport.records[0],
        directCardProbeError: 'DIRECT_CARD_PROBE_ERROR',
      },
    ], [
      {
        key: '0105451261 • P55',
        cardNo: '0105451261',
        slotTokens: ['P55'],
        classification: 'inconclusive',
        bulkCardFound: false,
        bulkFocusedUserSeen: false,
        directCardProbeStatus: 'unsupported',
        directCardProbeError: 'DIRECT_CARD_PROBE_ERROR',
        directUserFuzzyHit: false,
        bulkEmployeeNo: null,
        directEmployeeNos: [],
        bulkUserName: null,
        directUserNames: [],
        bulkSlotToken: null,
        directSlotTokens: [],
        bulkCard: null,
        bulkUser: null,
        bulkFocusedUsers: [],
        directCards: [],
        directUsers: [],
        directUserFuzzyProbes: [
          {
            query: '0105451261',
            purpose: 'focusedCardNo',
            status: 'noMatch',
            returnedEmployeeNos: [],
            returnedNames: [],
            error: null,
          },
          {
            query: 'P55',
            purpose: 'focusedPlaceholderName',
            status: 'noMatch',
            returnedEmployeeNos: [],
            returnedNames: [],
            error: null,
          },
        ],
      },
    ]);
  } finally {
    console.info = originalInfo;
    await device.close();
  }
});

test('listAvailableSlots marks unsupported fuzzy user probes as inconclusive instead of clean misses', async () => {
  const device = createAuthorizedApiServer(({ req, res, body }) => {
    if (req.url === '/ISAPI/AccessControl/capabilities') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        AccessControlCapabilities: {
          userLimit: 900,
          cardLimit: 870,
        },
      }));
      return;
    }

    if (req.url === '/ISAPI/AccessControl/UserInfo/Count?format=json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        UserInfoCount: {
          userNumber: 581,
        },
      }));
      return;
    }

    if (req.url === '/ISAPI/AccessControl/CardInfo/Count?format=json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        CardInfoCount: {
          cardNumber: 569,
        },
      }));
      return;
    }

    const payload = JSON.parse(body);

    if (req.url === '/ISAPI/AccessControl/UserInfo/Search?format=json') {
      const fuzzySearch = payload.UserInfoSearchCond.fuzzySearch ?? '';
      const position = payload.UserInfoSearchCond.searchResultPosition;

      if (fuzzySearch) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          statusCode: 6,
          statusString: 'Invalid Content',
          subStatusCode: 'badParameters',
          errorCode: 1610612737,
          errorMsg: '0x60000001',
        }));
        return;
      }

      if (position === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          UserInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 0,
            totalMatches: 0,
            UserInfo: [],
          },
        }));
        return;
      }
    }

    if (req.url === '/ISAPI/AccessControl/CardInfo/Search?format=json') {
      const position = payload.CardInfoSearchCond.searchResultPosition;
      const requestedCardNos = (payload.CardInfoSearchCond.CardNoList ?? []).map(
        (entry) => entry.cardNo
      );

      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (requestedCardNos.length > 0 || position === 0) {
        res.end(JSON.stringify({
          CardInfoSearch: {
            responseStatusStrg: requestedCardNos.length > 0 ? 'NO MATCH' : 'OK',
            numOfMatches: 0,
            totalMatches: 0,
            CardInfo: [],
          },
        }));
        return;
      }
    }

    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`unexpected route ${req.url}`);
  });
  const port = await device.start();
  const hik = await loadHikModule(port, {
    HIK_DEBUG_AVAILABLE_SLOTS: '1',
    HIK_DEBUG_AVAILABLE_SLOTS_PLACEHOLDER_NAMES: 'P55',
    HIK_DEBUG_AVAILABLE_SLOTS_CARD_NOS: '0105451261',
  });
  const originalInfo = console.info;
  const infoCalls = [];

  console.info = (...args) => {
    infoCalls.push(args);
  };

  try {
    await hik.listAvailableSlots({
      now: new Date('2026-03-30T14:15:16'),
    });

    const directUserFuzzyReport = findJsonLog(
      infoCalls,
      '[hik] listAvailableSlots focused direct user fuzzy probes'
    );
    const comparisonReport = findJsonLog(
      infoCalls,
      '[hik] listAvailableSlots focused comparison report'
    );

    assert.deepEqual(
      directUserFuzzyReport.probes.map((probe) => probe.status),
      ['unsupported', 'unsupported']
    );
    assert.match(directUserFuzzyReport.probes[0].error, /badParameters/);
    assert.match(directUserFuzzyReport.probes[1].error, /badParameters/);
    assert.deepEqual([
      {
        ...comparisonReport.records[0],
        directUserFuzzyProbes: comparisonReport.records[0].directUserFuzzyProbes.map((probe) => ({
          ...probe,
          error: probe.error ? 'DIRECT_USER_FUZZY_PROBE_ERROR' : probe.error,
        })),
      },
    ], [
      {
        key: '0105451261 • P55',
        cardNo: '0105451261',
        slotTokens: ['P55'],
        classification: 'inconclusive',
        bulkCardFound: false,
        bulkFocusedUserSeen: false,
        directCardProbeStatus: 'noMatch',
        directCardProbeError: null,
        directUserFuzzyHit: false,
        bulkEmployeeNo: null,
        directEmployeeNos: [],
        bulkUserName: null,
        directUserNames: [],
        bulkSlotToken: null,
        directSlotTokens: [],
        bulkCard: null,
        bulkUser: null,
        bulkFocusedUsers: [],
        directCards: [],
        directUsers: [],
        directUserFuzzyProbes: [
          {
            query: '0105451261',
            purpose: 'focusedCardNo',
            status: 'unsupported',
            returnedEmployeeNos: [],
            returnedNames: [],
            error: 'DIRECT_USER_FUZZY_PROBE_ERROR',
          },
          {
            query: 'P55',
            purpose: 'focusedPlaceholderName',
            status: 'unsupported',
            returnedEmployeeNos: [],
            returnedNames: [],
            error: 'DIRECT_USER_FUZZY_PROBE_ERROR',
          },
        ],
      },
    ]);
  } finally {
    console.info = originalInfo;
    await device.close();
  }
});

test('listAvailableSlots flags bulk misses with focused placeholder fuzzy hits', async () => {
  const device = createAuthorizedApiServer(({ req, res, body }) => {
    if (req.url === '/ISAPI/AccessControl/capabilities') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        AccessControlCapabilities: {
          userLimit: 900,
          cardLimit: 870,
        },
      }));
      return;
    }

    if (req.url === '/ISAPI/AccessControl/UserInfo/Count?format=json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        UserInfoCount: {
          userNumber: 581,
        },
      }));
      return;
    }

    if (req.url === '/ISAPI/AccessControl/CardInfo/Count?format=json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        CardInfoCount: {
          cardNumber: 569,
        },
      }));
      return;
    }

    const payload = JSON.parse(body);

    if (req.url === '/ISAPI/AccessControl/UserInfo/Search?format=json') {
      const fuzzySearch = payload.UserInfoSearchCond.fuzzySearch ?? '';
      const position = payload.UserInfoSearchCond.searchResultPosition;

      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (fuzzySearch) {
        const matchingUsers = fuzzySearch === 'P55'
          ? [
              {
                employeeNo: '00000955',
                name: 'P55 John Doe',
                Valid: {
                  enable: true,
                  beginTime: '2020-01-01T00:00:00',
                  endTime: '2030-12-31T23:59:59',
                },
              },
            ]
          : [];

        res.end(JSON.stringify({
          UserInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: matchingUsers.length,
            totalMatches: matchingUsers.length,
            UserInfo: matchingUsers,
          },
        }));
        return;
      }

      if (position === 0) {
        res.end(JSON.stringify({
          UserInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 0,
            totalMatches: 0,
            UserInfo: [],
          },
        }));
        return;
      }
    }

    if (req.url === '/ISAPI/AccessControl/CardInfo/Search?format=json') {
      const position = payload.CardInfoSearchCond.searchResultPosition;

      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (position === 0) {
        res.end(JSON.stringify({
          CardInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 0,
            totalMatches: 0,
            CardInfo: [],
          },
        }));
        return;
      }
    }

    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`unexpected route ${req.url}`);
  });
  const port = await device.start();
  const hik = await loadHikModule(port, {
    HIK_DEBUG_AVAILABLE_SLOTS: '1',
    HIK_DEBUG_AVAILABLE_SLOTS_PLACEHOLDER_NAMES: 'P55',
    HIK_DEBUG_AVAILABLE_SLOTS_CARD_NOS: '0105451261',
  });
  const originalInfo = console.info;
  const infoCalls = [];

  console.info = (...args) => {
    infoCalls.push(args);
  };

  try {
    await hik.listAvailableSlots({
      now: new Date('2026-03-30T14:15:16'),
    });

    const comparisonReport = findJsonLog(
      infoCalls,
      '[hik] listAvailableSlots focused comparison report'
    );

    assert.deepEqual(comparisonReport.records[0], {
      key: '0105451261 • P55',
      cardNo: '0105451261',
      slotTokens: ['P55'],
      classification: 'bulkMissWithDirectUserFuzzyHit',
      bulkCardFound: false,
      bulkFocusedUserSeen: false,
      directCardProbeStatus: 'noMatch',
      directCardProbeError: null,
      directUserFuzzyHit: true,
      bulkEmployeeNo: null,
      directEmployeeNos: ['955'],
      bulkUserName: null,
      directUserNames: ['P55 John Doe'],
      bulkSlotToken: null,
      directSlotTokens: ['P55'],
      bulkCard: null,
      bulkUser: null,
      bulkFocusedUsers: [],
      directCards: [],
      directUsers: [
        {
          employeeNo: '00000955',
          canonicalEmployeeNo: '955',
          extractedName: 'P55 John Doe',
          slotToken: 'P55',
          classification: 'occupiedSlotName',
          rawUserInfo: {
            employeeNo: '00000955',
            name: 'P55 John Doe',
            Valid: {
              enable: true,
              beginTime: '2020-01-01T00:00:00',
              endTime: '2030-12-31T23:59:59',
            },
          },
        },
      ],
      directUserFuzzyProbes: [
        {
          query: '0105451261',
          purpose: 'focusedCardNo',
          status: 'noMatch',
          returnedEmployeeNos: [],
          returnedNames: [],
          error: null,
        },
        {
          query: 'P55',
          purpose: 'focusedPlaceholderName',
          status: 'found',
          returnedEmployeeNos: ['00000955'],
          returnedNames: ['P55 John Doe'],
          error: null,
        },
      ],
    });
  } finally {
    console.info = originalInfo;
    await device.close();
  }
});

test('listAvailableSlots surfaces focused card-number fuzzy user hits separately from card probe status', async () => {
  const device = createAuthorizedApiServer(({ req, res, body }) => {
    if (req.url === '/ISAPI/AccessControl/capabilities') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        AccessControlCapabilities: {
          userLimit: 900,
          cardLimit: 870,
        },
      }));
      return;
    }

    if (req.url === '/ISAPI/AccessControl/UserInfo/Count?format=json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        UserInfoCount: {
          userNumber: 581,
        },
      }));
      return;
    }

    if (req.url === '/ISAPI/AccessControl/CardInfo/Count?format=json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        CardInfoCount: {
          cardNumber: 569,
        },
      }));
      return;
    }

    const payload = JSON.parse(body);

    if (req.url === '/ISAPI/AccessControl/UserInfo/Search?format=json') {
      const fuzzySearch = payload.UserInfoSearchCond.fuzzySearch ?? '';
      const position = payload.UserInfoSearchCond.searchResultPosition;

      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (fuzzySearch) {
        const matchingUsers = fuzzySearch === '0105451261'
          ? [
              {
                employeeNo: '00000955',
                name: 'P55 John Doe',
                Valid: {
                  enable: true,
                  beginTime: '2020-01-01T00:00:00',
                  endTime: '2030-12-31T23:59:59',
                },
              },
            ]
          : [];

        res.end(JSON.stringify({
          UserInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: matchingUsers.length,
            totalMatches: matchingUsers.length,
            UserInfo: matchingUsers,
          },
        }));
        return;
      }

      if (position === 0) {
        res.end(JSON.stringify({
          UserInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 0,
            totalMatches: 0,
            UserInfo: [],
          },
        }));
        return;
      }
    }

    if (req.url === '/ISAPI/AccessControl/CardInfo/Search?format=json') {
      const position = payload.CardInfoSearchCond.searchResultPosition;

      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (position === 0) {
        res.end(JSON.stringify({
          CardInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 0,
            totalMatches: 0,
            CardInfo: [],
          },
        }));
        return;
      }
    }

    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`unexpected route ${req.url}`);
  });
  const port = await device.start();
  const hik = await loadHikModule(port, {
    HIK_DEBUG_AVAILABLE_SLOTS: '1',
    HIK_DEBUG_AVAILABLE_SLOTS_PLACEHOLDER_NAMES: 'P55',
    HIK_DEBUG_AVAILABLE_SLOTS_CARD_NOS: '0105451261',
  });
  const originalInfo = console.info;
  const infoCalls = [];

  console.info = (...args) => {
    infoCalls.push(args);
  };

  try {
    await hik.listAvailableSlots({
      now: new Date('2026-03-30T14:15:16'),
    });

    const directUserFuzzyReport = findJsonLog(
      infoCalls,
      '[hik] listAvailableSlots focused direct user fuzzy probes'
    );
    const comparisonReport = findJsonLog(
      infoCalls,
      '[hik] listAvailableSlots focused comparison report'
    );

    assert.deepEqual(directUserFuzzyReport.probes, [
      {
        key: 'focusedCardNo:0105451261',
        query: '0105451261',
        purpose: 'focusedCardNo',
        request: {
          searchID: 'focused-fuzzy-user-probe-focusedCardNo-1',
          searchResultPosition: 0,
          maxResults: 30,
          fuzzySearch: '0105451261',
        },
        status: 'found',
        responseStatusStrg: 'OK',
        numOfMatches: 1,
        totalMatches: 1,
        returnedEmployeeNos: ['00000955'],
        returnedNames: ['P55 John Doe'],
        rawUserInfo: [
          {
            employeeNo: '00000955',
            name: 'P55 John Doe',
            Valid: {
              enable: true,
              beginTime: '2020-01-01T00:00:00',
              endTime: '2030-12-31T23:59:59',
            },
          },
        ],
        userRecords: [
          {
            employeeNo: '00000955',
            canonicalEmployeeNo: '955',
            extractedName: 'P55 John Doe',
            placeholderNameHint: null,
            slotToken: 'P55',
            nameCandidates: {
              name: 'P55 John Doe',
            },
            matchingPlaceholderNames: [],
            slotTokenCandidates: [
              {
                key: 'name',
                value: 'P55 John Doe',
                slotToken: 'P55',
                exactMatch: false,
              },
            ],
            classification: 'occupiedSlotName',
            validityEvaluated: false,
            isCurrentlyValid: null,
            validityReason: null,
            normalizedValidity: null,
            rawUserInfo: {
              employeeNo: '00000955',
              name: 'P55 John Doe',
              Valid: {
                enable: true,
                beginTime: '2020-01-01T00:00:00',
                endTime: '2030-12-31T23:59:59',
              },
            },
          },
        ],
        error: null,
      },
      {
        key: 'focusedPlaceholderName:P55',
        query: 'P55',
        purpose: 'focusedPlaceholderName',
        request: {
          searchID: 'focused-fuzzy-user-probe-focusedPlaceholderName-1',
          searchResultPosition: 0,
          maxResults: 30,
          fuzzySearch: 'P55',
        },
        status: 'noMatch',
        responseStatusStrg: 'OK',
        numOfMatches: 0,
        totalMatches: 0,
        returnedEmployeeNos: [],
        returnedNames: [],
        rawUserInfo: [],
        userRecords: [],
        error: null,
      },
    ]);
    assert.equal(
      comparisonReport.records[0].classification,
      'bulkMissWithDirectUserFuzzyHit'
    );
    assert.equal(comparisonReport.records[0].directCardProbeStatus, 'noMatch');
    assert.equal(comparisonReport.records[0].directUserFuzzyHit, true);
  } finally {
    console.info = originalInfo;
    await device.close();
  }
});

test('listAvailableSlots focused device evidence reports counts, capabilities, and bulk totals', async () => {
  const device = createAuthorizedApiServer(({ req, res, body }) => {
    if (req.url === '/ISAPI/AccessControl/capabilities') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        AccessControlCapabilities: {
          userLimit: 900,
          cardLimit: 870,
        },
      }));
      return;
    }

    if (req.url === '/ISAPI/AccessControl/UserInfo/Count?format=json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        UserInfoCount: {
          userNumber: 581,
        },
      }));
      return;
    }

    if (req.url === '/ISAPI/AccessControl/CardInfo/Count?format=json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        CardInfoCount: {
          cardNumber: 569,
        },
      }));
      return;
    }

    const payload = JSON.parse(body);

    if (req.url === '/ISAPI/AccessControl/UserInfo/Search?format=json') {
      const fuzzySearch = payload.UserInfoSearchCond.fuzzySearch ?? '';
      const position = payload.UserInfoSearchCond.searchResultPosition;

      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (fuzzySearch || position === 0) {
        res.end(JSON.stringify({
          UserInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 0,
            totalMatches: 0,
            UserInfo: [],
          },
        }));
        return;
      }
    }

    if (req.url === '/ISAPI/AccessControl/CardInfo/Search?format=json') {
      const position = payload.CardInfoSearchCond.searchResultPosition;

      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (position === 0) {
        res.end(JSON.stringify({
          CardInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 0,
            totalMatches: 0,
            CardInfo: [],
          },
        }));
        return;
      }
    }

    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`unexpected route ${req.url}`);
  });
  const port = await device.start();
  const hik = await loadHikModule(port, {
    HIK_DEBUG_AVAILABLE_SLOTS: '1',
    HIK_DEBUG_AVAILABLE_SLOTS_PLACEHOLDER_NAMES: 'P55',
    HIK_DEBUG_AVAILABLE_SLOTS_CARD_NOS: '0105451261',
  });
  const originalInfo = console.info;
  const infoCalls = [];

  console.info = (...args) => {
    infoCalls.push(args);
  };

  try {
    await hik.listAvailableSlots({
      now: new Date('2026-03-30T14:15:16'),
    });

    const evidenceReport = findJsonLog(
      infoCalls,
      '[hik] listAvailableSlots focused device evidence'
    );

    assert.deepEqual(evidenceReport, {
      focusedPlaceholderNames: ['P55'],
      focusedCardNos: ['0105451261'],
      bulkTotals: {
        userPages: 1,
        cardPages: 1,
        totalUsersScanned: 0,
        totalCardsScanned: 0,
      },
      bulkCoverage: {
        lastUserResultKey: null,
        lastCardResultKey: null,
      },
      counts: {
        users: {
          status: 'ok',
          count: 581,
          error: null,
          rawResponse: {
            UserInfoCount: {
              userNumber: 581,
            },
          },
        },
        cards: {
          status: 'ok',
          count: 569,
          error: null,
          rawResponse: {
            CardInfoCount: {
              cardNumber: 569,
            },
          },
        },
      },
      capabilities: {
        status: 'ok',
        error: null,
        rawResponse: {
          AccessControlCapabilities: {
            userLimit: 900,
            cardLimit: 870,
          },
        },
      },
    });
  } finally {
    console.info = originalInfo;
    await device.close();
  }
});

test('listAvailableSlots suppresses JSON debug reports when debug flag is unset', async () => {
  const device = createAuthorizedApiServer(({ req, res, body }) => {
    const payload = JSON.parse(body);

    if (req.url === '/ISAPI/AccessControl/UserInfo/Search?format=json') {
      const position = payload.UserInfoSearchCond.searchResultPosition;

      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (position === 0) {
        res.end(JSON.stringify({
          UserInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 2,
            totalMatches: 2,
            UserInfo: [
              {
                employeeNo: '00000800',
                name: 'P80',
                Valid: {
                  enable: false,
                  beginTime: '2020-01-01T00:00:00',
                  endTime: '2030-12-31T23:59:59',
                },
              },
              {
                employeeNo: '00000801',
                name: 'P81',
                Valid: {
                  enable: true,
                  beginTime: '2020-01-01T00:00:00',
                  endTime: '2030-12-31T23:59:59',
                },
              },
            ],
          },
        }));
        return;
      }
    }

    if (req.url === '/ISAPI/AccessControl/CardInfo/Search?format=json') {
      const position = payload.CardInfoSearchCond.searchResultPosition;

      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (position === 0) {
        res.end(JSON.stringify({
          CardInfoSearch: {
            responseStatusStrg: 'OK',
            numOfMatches: 1,
            totalMatches: 1,
            CardInfo: [
              { employeeNo: '801', cardNo: '0108080808' },
            ],
          },
        }));
        return;
      }
    }

    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`unexpected route ${req.url}`);
  });
  const port = await device.start();
  const hik = await loadHikModule(port, {
    HIK_DEBUG_AVAILABLE_SLOTS: undefined,
  });
  const originalInfo = console.info;
  const infoCalls = [];

  console.info = (...args) => {
    infoCalls.push(args);
  };

  try {
    const result = await hik.listAvailableSlots({
      now: new Date('2026-03-30T14:15:16'),
    });

    assert.deepEqual(result.slots, [
      {
        employeeNo: '00000801',
        cardNo: '0108080808',
        placeholderName: 'P81',
      },
    ]);
    assert.equal(hasJsonLog(infoCalls, '[hik] listAvailableSlots scanned user records'), false);
    assert.equal(hasJsonLog(infoCalls, '[hik] listAvailableSlots scanned card records'), false);
    assert.equal(hasJsonLog(infoCalls, '[hik] listAvailableSlots card-backed non-slots'), false);
    assert.equal(infoCalls.some(([label]) => label === '[hik] listAvailableSlots diagnostics'), true);
  } finally {
    console.info = originalInfo;
    await device.close();
  }
});

test('resetSlot restores the placeholder name with the configured far-future expiry', async () => {
  const device = createAuthorizedApiServer(({ res }) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const port = await device.start();
  const hik = await loadHikModule(port);

  try {
    const result = await hik.resetSlot({
      employeeNo: '00000611',
      placeholderName: 'P42',
      now: new Date('2026-03-30T14:15:16'),
    });

    assert.equal(result.ok, true);
    const request = device.events.find((event) => event.type === 'authorized');
    const payload = JSON.parse(request.body);

    assert.equal(request.method, 'POST');
    assert.equal(request.route, '/ISAPI/AccessControl/UserInfo/SetUp?format=json');
    assert.deepEqual(payload, {
      UserInfo: {
        employeeNo: '00000611',
        name: 'P42',
        userType: 'normal',
        Valid: {
          enable: true,
          beginTime: '2026-03-30T00:00:00',
          endTime: '2037-12-31T23:59:59',
        },
        doorRight: '1',
        RightPlan: [{ doorNo: 1, planTemplateNo: '1' }],
      },
    });
  } finally {
    await device.close();
  }
});

test('resetSlot honors the configured valid_only user-modify payload mode', async () => {
  const device = createAuthorizedApiServer(({ res }) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const port = await device.start();
  const hik = await loadHikModule(port, { HIK_USER_MODIFY_MODE: 'valid_only' });

  try {
    const result = await hik.resetSlot({
      employeeNo: '00000611',
      placeholderName: 'P42',
      now: new Date('2026-03-30T14:15:16'),
    });

    assert.equal(result.ok, true);
    const request = device.events.find((event) => event.type === 'authorized');
    const payload = JSON.parse(request.body);

    assert.equal(request.method, 'POST');
    assert.equal(request.route, '/ISAPI/AccessControl/UserInfo/SetUp?format=json');
    assert.deepEqual(payload, {
      UserInfo: {
        employeeNo: '00000611',
        name: 'P42',
        userType: 'normal',
        Valid: {
          enable: true,
          beginTime: '2026-03-30T00:00:00',
          endTime: '2037-12-31T23:59:59',
        },
      },
    });
  } finally {
    await device.close();
  }
});

test('non-2xx Hik responses include method and endpoint details', async () => {
  const device = createAuthorizedApiServer(({ res }) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      statusCode: 4,
      statusString: 'Invalid Operation',
      subStatusCode: 'methodNotAllowed',
    }));
  });
  const port = await device.start();
  const hik = await loadHikModule(port);

  try {
    await assert.rejects(
      () => hik.addUser({
        employeeNo: 'EVZ-20260330141516-ABC123',
        name: 'Jane Doe',
        beginTime: '2026-03-30T00:00:00',
        endTime: '2026-07-15T23:59:59',
      }),
      /Device returned 400 for POST \/ISAPI\/AccessControl\/UserInfo\/SetUp\?format=json:/
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
