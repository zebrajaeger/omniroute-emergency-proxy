'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { gzipSync, brotliCompressSync, deflateSync } = require('node:zlib');
const { createProxyServer } = require('../src/index');

const invalid = 'data: {"type":"response.in_progress","sequence_number":1,"response":{"id":null,"status":"in_progress"}}\n\n';
const created = 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_test"},"sequence_number":1}\n\n';
const delta = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK","sequence_number":2}\n\n';
const completed = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_test"},"sequence_number":3}\n\n';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function cleanup(t, server) {
  // Includes half-finished uploads and active streaming sockets.
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

async function fixture(t, handler, options = {}) {
  const upstream = http.createServer(handler);
  cleanup(t, upstream);
  const upstreamUrl = await listen(upstream);
  const logs = [];
  const logger = { info: (line) => logs.push(line), error: (line) => logs.push(line) };
  const proxy = createProxyServer({ upstreamBaseUrl: upstreamUrl + (options.prefix || ''), logger });
  cleanup(t, proxy);
  const url = await listen(proxy);
  return { url, logs };
}

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('forwards arbitrary routes, exact request bodies, credentials and custom headers', { timeout: 10000 }, async (t) => {
  const cases = [
    { method: 'GET', path: '/v1/models?source=a%2Fb', body: '' },
    { method: 'GET', path: '/health', body: '' },
    { method: 'POST', path: '/v1/chat/completions', body: ' { "messages": [], "model": "x" }\n' },
    { method: 'POST', path: '/v1/responses', body: '{ "model":"gpt-6.1-sol", "input":"ä🙂", "stream": false }\n' },
    { method: 'PATCH', path: '/arbitrary/%2Fpath?q=%20', body: 'raw\u0000body' },
  ];
  let index = 0;
  const observations = [];
  const { url, logs } = await fixture(t, async (req, res) => {
    observations.push({ method: req.method, url: req.url, headers: req.headers, body: await readBody(req) });
    const body = Buffer.from(` { "ok": true, "index": ${index++} }\n`);
    res.writeHead(200, {
      'content-type': 'application/json', 'content-length': body.length,
      'x-upstream': 'unchanged', 'access-control-allow-origin': '*',
      'set-cookie': ['one=1', 'two=2'], etag: '"original"',
      connection: 'x-private', 'x-private': 'must-not-pass',
    });
    res.end(body);
  });
  for (const [i, entry] of cases.entries()) {
    const body = Buffer.from(entry.body);
    const result = await request(url + entry.path, {
      method: entry.method, body,
      headers: {
        authorization: 'Bearer secret-token', 'x-api-key': 'secret-key',
        'anthropic-version': '2023-06-01', 'x-omniroute-test': 'custom',
        'x-custom': 'value', 'content-type': 'application/json', accept: 'application/json',
        'user-agent': 'proxy-test', 'accept-encoding': 'gzip',
        'content-length': body.length, connection: 'close, x-request-private',
        'x-request-private': 'must-not-pass',
      },
    });
    const observed = observations[i];
    assert.equal(observed.method, entry.method);
    assert.equal(observed.url, entry.path);
    assert.deepEqual(observed.body, body);
    for (const [name, value] of Object.entries({
      authorization: 'Bearer secret-token', 'x-api-key': 'secret-key',
      'anthropic-version': '2023-06-01', 'x-omniroute-test': 'custom',
      'x-custom': 'value', 'content-type': 'application/json', accept: 'application/json',
      'user-agent': 'proxy-test',
    })) assert.equal(observed.headers[name], value);
    assert.notEqual(observed.headers.host, new URL(url).host);
    assert.equal(observed.headers['x-request-private'], undefined);
    assert.equal(observed.headers['accept-encoding'], entry.path === '/v1/responses' ? 'identity' : 'gzip');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, Buffer.from(` { "ok": true, "index": ${i} }\n`));
    assert.equal(result.headers['content-length'], String(result.body.length));
    assert.equal(result.headers.etag, '"original"');
    assert.equal(result.headers['x-upstream'], 'unchanged');
    assert.equal(result.headers['access-control-allow-origin'], '*');
    assert.deepEqual(result.headers['set-cookie'], ['one=1', 'two=2']);
    assert.equal(result.headers['x-private'], undefined);
  }
  assert.deepEqual(logs, []);
});

test('preserves upstream HTTP errors including raw bodies and content type', { timeout: 10000 }, async (t) => {
  const { url } = await fixture(t, (req, res) => {
    const status = Number(req.url.slice(1));
    const body = Buffer.from(`upstream error ${status}\n`);
    res.writeHead(status, { 'content-type': 'text/plain', 'content-length': body.length, 'retry-after': '10' });
    res.end(body);
  });
  for (const status of [400, 401, 403, 429, 500, 502]) {
    const result = await request(`${url}/${status}`);
    assert.equal(result.status, status);
    assert.equal(result.headers['content-type'], 'text/plain');
    assert.equal(result.headers['retry-after'], '10');
    assert.equal(result.body.toString(), `upstream error ${status}\n`);
  }
});

test('streams the mock Responses events live, filters only the initial frame', { timeout: 10000 }, async (t) => {
  let finishStream;
  const { url, logs } = await fixture(t, (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'content-length': Buffer.byteLength(invalid + created + delta + completed),
      'cache-control': 'no-cache', etag: '"stale"',
    });
    res.write(invalid.slice(0, 23));
    res.write(invalid.slice(23) + created);
    // The test releases the rest only after the client receives response.created.
    finishStream = () => res.end(delta + completed);
  });
  const result = await new Promise((resolve, reject) => {
    const req = http.request(url + '/v1/responses?test=1', { method: 'POST', agent: false }, (res) => {
      const chunks = [];
      let released = false;
      res.on('data', (chunk) => {
        chunks.push(chunk);
        if (!released && Buffer.concat(chunks).toString().includes(created)) {
          released = true;
          finishStream();
        }
      });
      res.on('error', reject);
      res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks), released }));
    });
    req.on('error', reject);
    req.end('{"stream":true}');
  });
  assert.equal(result.released, true);
  assert.deepEqual(result.body, Buffer.from(created + delta + completed));
  assert.equal(result.headers['content-length'], undefined);
  assert.equal(result.headers.etag, undefined);
  assert.equal(result.headers['transfer-encoding'], 'chunked');
  assert.equal(result.headers['cache-control'], 'no-cache');
  assert.equal(logs.filter((line) => line.includes('stripped')).length, 1);
});

test('does not filter SSE on other routes or methods', { timeout: 10000 }, async (t) => {
  const { url } = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(invalid + created);
  });
  for (const [method, path] of [['POST', '/v1/chat/completions'], ['GET', '/v1/responses'], ['POST', '/v1/responses/']]) {
    const result = await request(url + path, { method });
    assert.deepEqual(result.body, Buffer.from(invalid + created));
  }
});

test('handles gzip/br/deflate if upstream ignores identity encoding', { timeout: 10000 }, async (t) => {
  let encoding;
  const compress = { gzip: gzipSync, br: brotliCompressSync, deflate: deflateSync };
  const { url } = await fixture(t, (req, res) => {
    assert.equal(req.headers['accept-encoding'], 'identity');
    const body = compress[encoding](Buffer.from(invalid + created + delta));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': encoding, 'content-length': body.length });
    res.end(body);
  });
  for (encoding of Object.keys(compress)) {
    const result = await request(url + '/v1/responses', { method: 'POST' });
    assert.deepEqual(result.body, Buffer.from(created + delta));
    assert.equal(result.headers['content-encoding'], undefined);
    assert.equal(result.headers['content-length'], undefined);
  }
});

test('unknown compression fails open without altering bytes or headers', { timeout: 10000 }, async (t) => {
  const bytes = Buffer.from([0, 255, 17, 42]);
  let encoding;
  const { url } = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': encoding, 'content-length': bytes.length });
    res.end(bytes);
  });
  for (encoding of ['custom', 'constructor', '__proto__', 'gzip, br']) {
    const result = await request(url + '/v1/responses', { method: 'POST' });
    assert.deepEqual(result.body, bytes);
    assert.equal(result.headers['content-encoding'], encoding);
    assert.equal(result.headers['content-length'], String(bytes.length));
  }
});

test('returns safe 502 JSON on unreachable upstream and never logs secrets', { timeout: 10000 }, async (t) => {
  const unused = http.createServer();
  const upstreamBaseUrl = await listen(unused);
  await new Promise((resolve) => unused.close(resolve));
  const logs = [];
  const proxy = createProxyServer({ upstreamBaseUrl, logger: { info: (line) => logs.push(line), error: (line) => logs.push(line) } });
  cleanup(t, proxy);
  const url = await listen(proxy);
  const result = await request(url + '/v1/responses', {
    method: 'POST', headers: { authorization: 'Bearer super-secret', 'x-api-key': 'key-secret' },
    body: '{"input":"private-prompt"}',
  });
  assert.equal(result.status, 502);
  assert.deepEqual(JSON.parse(result.body), { error: { message: 'OmniRoute upstream unavailable', type: 'proxy_error' } });
  assert.match(logs.join('\n'), /upstream network error/);
  assert.doesNotMatch(logs.join('\n'), /super-secret|key-secret|private-prompt|stack/i);
});

test('client abort closes the upstream streaming connection', { timeout: 10000 }, async (t) => {
  let upstreamClosed;
  const closed = new Promise((resolve) => { upstreamClosed = resolve; });
  const { url } = await fixture(t, (req, res) => {
    res.on('close', upstreamClosed);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(created);
    // Deliberately never finish: the client abort must close this response.
  });
  await new Promise((resolve, reject) => {
    const req = http.request(url + '/v1/responses', { method: 'POST', agent: false }, (res) => {
      res.once('data', () => { res.destroy(); resolve(); });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end('{"stream":true}');
  });
  await closed;
});

test('client abort during request upload also closes upstream', { timeout: 10000 }, async (t) => {
  let uploadStarted;
  let uploadClosed;
  const started = new Promise((resolve) => { uploadStarted = resolve; });
  const closed = new Promise((resolve) => { uploadClosed = resolve; });
  const { url } = await fixture(t, (req) => {
    req.on('error', () => {});
    req.on('close', uploadClosed);
    req.once('data', uploadStarted);
  });
  const req = http.request(url + '/upload', { method: 'POST', agent: false });
  req.on('error', () => {});
  req.write('partial request');
  await started;
  req.destroy();
  await closed;
});

test('slow clients receive large post-created streams without byte changes', { timeout: 10000 }, async (t) => {
  const payload = Buffer.concat([Buffer.from(created), Buffer.alloc(4 * 1024 * 1024, 120), Buffer.from(invalid)]);
  const { url } = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(payload);
  });
  const body = await new Promise((resolve, reject) => {
    const req = http.request(url + '/v1/responses', { method: 'POST', agent: false }, (res) => {
      const chunks = [];
      res.pause();
      setTimeout(() => res.resume(), 50);
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.end();
  });
  assert.deepEqual(body, payload);
});

test('preserves raw paths and query strings with an optional upstream base path', { timeout: 10000 }, async (t) => {
  let observed;
  const { url } = await fixture(t, (req, res) => {
    observed = req.url;
    res.end('OK');
  }, { prefix: '/gateway/' });
  await request(url + '/v1/models?a=%2f&b=%20');
  assert.equal(observed, '/gateway/v1/models?a=%2f&b=%20');
});

test('rejects unsupported and credential-bearing upstream configuration', () => {
  for (const upstreamBaseUrl of ['ftp://host', 'http://key:secret@host', 'http://host?secret=x', 'http://host/#secret']) {
    assert.throws(() => createProxyServer({ upstreamBaseUrl }));
  }
});
