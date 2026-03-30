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

test('addUser uses PUT UserInfo/Modify with the expected payload', async () => {
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

    assert.equal(request.method, 'PUT');
    assert.equal(request.route, '/ISAPI/AccessControl/UserInfo/Modify?format=json');
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

test('addCard uses PUT CardInfo/Modify to assign an existing card', async () => {
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

    assert.equal(request.method, 'PUT');
    assert.equal(request.route, '/ISAPI/AccessControl/CardInfo/Modify?format=json');
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
          nonPlaceholderName: 1,
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
      },
    });
  } finally {
    await device.close();
  }
});

test('listAvailableSlots records granular validity diagnostics and debug samples when enabled', async () => {
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
          nonPlaceholderName: 0,
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
      },
    });

    const debugCall = infoCalls.find(
      ([label]) => label === '[hik] listAvailableSlots dropped placeholder samples'
    );

    assert.ok(debugCall);
    assert.equal(debugCall[1].sampleLimit, 10);
    assert.equal(debugCall[1].sampledCount, 7);
    assert.equal(debugCall[1].omittedCount, 0);
    assert.deepEqual(
      debugCall[1].samples.map((sample) => ({
        reason: sample.reason,
        employeeNo: sample.employeeNo,
        name: sample.name,
      })),
      [
        { reason: 'missingValid', employeeNo: '00000700', name: 'P70' },
        { reason: 'disabled', employeeNo: '00000701', name: 'P71' },
        { reason: 'invalidBeginTime', employeeNo: '00000702', name: 'P72' },
        { reason: 'futureBeginTime', employeeNo: '00000703', name: 'P73' },
        { reason: 'missingEndTime', employeeNo: '00000704', name: 'P74' },
        { reason: 'invalidEndTime', employeeNo: '00000705', name: 'P75' },
        { reason: 'expiredEndTime', employeeNo: '00000706', name: 'P76' },
      ]
    );

    const missingValidSample = debugCall[1].samples[0];
    assert.equal(missingValidSample.rawValid, null);
    assert.equal(missingValidSample.normalizedValidity.hasValidObject, false);
    assert.equal(missingValidSample.normalizedValidity.enableRaw, null);
    assert.equal(missingValidSample.normalizedValidity.enable, false);

    const invalidEndTimeSample = debugCall[1].samples[5];
    assert.equal(invalidEndTimeSample.rawValid.endTime, 'not-a-date');
    assert.equal(invalidEndTimeSample.normalizedValidity.endTime, 'not-a-date');
    assert.equal(invalidEndTimeSample.normalizedValidity.endTimestamp, null);
    assert.equal(typeof invalidEndTimeSample.normalizedValidity.nowTimestamp, 'number');
  } finally {
    console.info = originalInfo;
    await device.close();
  }
});

test('listAvailableSlots suppresses dropped placeholder debug samples when debug flag is unset', async () => {
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
    assert.equal(
      infoCalls.some(
        ([label]) => label === '[hik] listAvailableSlots dropped placeholder samples'
      ),
      false
    );
    assert.equal(
      infoCalls.some(([label]) => label === '[hik] listAvailableSlots diagnostics'),
      true
    );
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

    assert.equal(request.method, 'PUT');
    assert.equal(request.route, '/ISAPI/AccessControl/UserInfo/Modify?format=json');
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
      /Device returned 400 for PUT \/ISAPI\/AccessControl\/UserInfo\/Modify\?format=json:/
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
