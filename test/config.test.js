'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { once } = require('node:events');
const http = require('node:http');
const { loadConfiguration, DEFAULT_UPSTREAM } = require('../src/config');
const { createProxyServer } = require('../src/index');

function configFile(t, content) {
  const directory = mkdtempSync(join(tmpdir(), 'omniroute-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.json');
  if (content !== undefined) writeFileSync(path, content);
  return path;
}

test('loads upstream URL and API key from JSON', (t) => {
  const configPath = configFile(t, JSON.stringify({ upstreamBaseUrl: 'https://example.com/gateway', apiKey: 'test-secret' }));
  assert.deepEqual(loadConfiguration({ env: {}, configPath }), {
    upstreamBaseUrl: 'https://example.com/gateway', apiKey: 'test-secret',
  });
});

test('environment upstream overrides the file while preserving its API key', (t) => {
  const configPath = configFile(t, JSON.stringify({ upstreamBaseUrl: 'http://file-host', apiKey: 'file-key' }));
  assert.deepEqual(loadConfiguration({ env: { OMNIROUTE_BASE_URL: 'http://env-host' }, configPath }), {
    upstreamBaseUrl: 'http://env-host', apiKey: 'file-key',
  });
});

test('uses defaults without a configuration file or without optional properties', (t) => {
  for (const content of [undefined, '{}']) {
    assert.deepEqual(loadConfiguration({ env: {}, configPath: configFile(t, content) }), {
      upstreamBaseUrl: DEFAULT_UPSTREAM, apiKey: '',
    });
  }
});

test('supports PROXY_CONFIG_FILE and rejects a missing explicitly selected file', (t) => {
  const path = configFile(t, '{"apiKey":"selected-key"}');
  assert.equal(loadConfiguration({ env: { PROXY_CONFIG_FILE: path } }).apiKey, 'selected-key');
  assert.throws(() => loadConfiguration({ env: { PROXY_CONFIG_FILE: path + '.missing' } }), /Cannot read/);
});

test('accepts a UTF-8 BOM in configuration files', (t) => {
  const configPath = configFile(t, '\uFEFF{"apiKey":"test-key"}');
  assert.equal(loadConfiguration({ env: {}, configPath }).apiKey, 'test-key');
});

test('rejects invalid JSON and nonobject roots without revealing content', (t) => {
  for (const content of ['{"apiKey":"private-secret",', 'null', '[]', '42', '"private-secret"']) {
    const configPath = configFile(t, content);
    assert.throws(() => loadConfiguration({ env: {}, configPath }), (error) => {
      assert.doesNotMatch(error.message, /private-secret/);
      return true;
    });
  }
});

test('rejects invalid property types and unsafe API header values', (t) => {
  for (const config of [
    { upstreamBaseUrl: 42 }, { upstreamBaseUrl: '' }, { upstreamBaseUrl: null },
    { apiKey: 42 }, { apiKey: null }, { apiKey: ' private-secret' },
    { apiKey: 'private-secret\r\nx-injected: value' }, { apiKey: 'private-secret\u0000' },
  ]) {
    const configPath = configFile(t, JSON.stringify(config));
    assert.throws(() => loadConfiguration({ env: {}, configPath }), (error) => {
      assert.doesNotMatch(error.message, /private-secret/);
      return true;
    });
  }
});

test('rejects an unsafe direct API-key option before opening a server', () => {
  assert.throws(() => createProxyServer({ apiKey: 'secret\r\ninvalid' }), /invalid HTTP header/);
});

async function listen(t, server) {
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function get(url, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers, agent: false }, (res) => {
      res.resume();
      res.on('error', reject);
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
  });
}

test('file API key is a Bearer fallback and never overrides incoming credentials', { timeout: 10000 }, async (t) => {
  const observations = [];
  const upstream = http.createServer((req, res) => {
    observations.push(req.headers);
    res.end('OK');
  });
  const upstreamBaseUrl = await listen(t, upstream);
  const configPath = configFile(t, JSON.stringify({ upstreamBaseUrl, apiKey: 'file-secret' }));
  const logs = [];
  const logger = { info: (line) => logs.push(line), error: (line) => logs.push(line) };
  const proxy = createProxyServer({ ...loadConfiguration({ env: {}, configPath }), logger });
  const proxyUrl = await listen(t, proxy);

  for (const headers of [
    {}, { authorization: 'Bearer client-secret' }, { 'x-api-key': 'client-key' },
    { authorization: 'Basic client-credentials', 'x-api-key': 'client-key' },
    { authorization: '' }, { 'x-api-key': '' },
  ]) {
    assert.equal(await get(proxyUrl + '/v1/models', headers), 200);
    const forwarded = observations.at(-1);
    const hasAuth = headers.authorization !== undefined || headers['x-api-key'] !== undefined;
    assert.equal(forwarded.authorization, hasAuth ? headers.authorization : 'Bearer file-secret');
    assert.equal(forwarded['x-api-key'], headers['x-api-key']);
  }
  assert.doesNotMatch(logs.join('\n'), /file-secret|client-secret|client-key|client-credentials/);
});

test('empty configured key does not add an Authorization header', { timeout: 10000 }, async (t) => {
  let observed;
  const upstream = http.createServer((req, res) => {
    observed = req.headers;
    res.end('OK');
  });
  const upstreamBaseUrl = await listen(t, upstream);
  const configPath = configFile(t, JSON.stringify({ upstreamBaseUrl, apiKey: '' }));
  const proxy = createProxyServer(loadConfiguration({ env: {}, configPath }));
  const proxyUrl = await listen(t, proxy);
  assert.equal(await get(proxyUrl + '/health', {}), 200);
  assert.equal(observed.authorization, undefined);
});
