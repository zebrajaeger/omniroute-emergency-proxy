'use strict';

const http = require('node:http');
const https = require('node:https');
const { pipeline } = require('node:stream');
const { createGunzip, createInflate, createBrotliDecompress } = require('node:zlib');
const { InitialResponseFilter } = require('./sse-filter');
const { DEFAULT_UPSTREAM, loadConfiguration, validateApiKey } = require('./config');

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer',
]);

function forwardHeaders(headers) {
  const excluded = new Set(HOP_BY_HOP);
  for (const token of String(headers.connection || '').split(',')) {
    excluded.add(token.trim().toLowerCase());
  }
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name.toLowerCase())));
}

function parseUpstream(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('OMNIROUTE_BASE_URL must be an HTTP(S) URL without credentials, query or fragment');
  }
  return url;
}

function createProxyServer({ upstreamBaseUrl = DEFAULT_UPSTREAM, apiKey = '', logger = console } = {}) {
  const upstream = parseUpstream(upstreamBaseUrl);
  validateApiKey(apiKey);
  const transport = upstream.protocol === 'https:' ? https : http;
  const prefix = upstream.pathname.replace(/\/+$/, '');

  const server = http.createServer((req, res) => {
    const isResponses = req.method === 'POST' && req.url.split('?')[0] === '/v1/responses';
    const headers = forwardHeaders(req.headers);
    headers.host = upstream.host;
    if (apiKey && headers.authorization === undefined && headers['x-api-key'] === undefined) {
      headers.authorization = `Bearer ${apiKey}`;
    }
    if (isResponses) headers['accept-encoding'] = 'identity';

    let upstreamResponse;
    let clientAborted = false;
    const outgoing = transport.request({
      protocol: upstream.protocol,
      hostname: upstream.hostname.startsWith('[') ? upstream.hostname.slice(1, -1) : upstream.hostname,
      port: upstream.port || undefined,
      method: req.method,
      path: prefix + req.url,
      headers,
    });

    const abort = () => {
      clientAborted = true;
      outgoing.destroy();
      upstreamResponse?.destroy();
    };
    req.on('aborted', abort);
    req.on('error', () => {
      abort();
      res.destroy();
    });
    res.on('close', () => {
      if (!res.writableFinished) abort();
    });

    outgoing.on('error', (error) => {
      if (clientAborted) return;
      // Log only the error code, never URLs, headers or request bodies.
      logger.error(`[proxy] upstream network error (${error.code || 'UNKNOWN'})`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        error: { message: 'OmniRoute upstream unavailable', type: 'proxy_error' },
      }));
      req.unpipe(outgoing);
      req.resume();
    });

    outgoing.on('response', (response) => {
      upstreamResponse = response;
      if (clientAborted) {
        response.destroy();
        return;
      }
      const responseHeaders = forwardHeaders(response.headers);
      const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      let filter = isResponses && contentType === 'text/event-stream';
      const stages = [response];
      const encoding = String(response.headers['content-encoding'] || 'identity').trim().toLowerCase();

      if (filter && encoding !== 'identity') {
        // Defensive fallback if the upstream ignores Accept-Encoding: identity.
        const decompressors = {
          gzip: createGunzip, 'x-gzip': createGunzip,
          deflate: createInflate, br: createBrotliDecompress,
        };
        const decompress = Object.hasOwn(decompressors, encoding) ? decompressors[encoding] : undefined;
        if (decompress) {
          stages.push(decompress());
          delete responseHeaders['content-encoding'];
        } else {
          filter = false; // Unknown encoding: preserve the response, never corrupt it.
          logger.error('[proxy] unsupported SSE content encoding; forwarding unchanged');
        }
      }

      if (filter) {
        delete responseHeaders['content-length'];
        // These validators/digests would describe the unfiltered representation.
        for (const name of ['etag', 'content-md5', 'digest', 'content-digest', 'repr-digest']) {
          delete responseHeaders[name];
        }
        stages.push(new InitialResponseFilter({
          onStrip: () => logger.info('[proxy] stripped invalid initial response.in_progress frame'),
        }));
      }

      res.writeHead(response.statusCode, response.statusMessage, responseHeaders);
      res.flushHeaders();
      pipeline(...stages, res, (error) => {
        if (error && !clientAborted) {
          logger.error(`[proxy] upstream stream error (${error.code || 'UNKNOWN'})`);
        }
      });
    });

    req.pipe(outgoing);
  });

  // LLM streams may be long-lived; do not impose body or socket deadlines.
  server.requestTimeout = 0;
  server.timeout = 0;
  return server;
}

function start() {
  const portText = process.env.PORT || '20129';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const { upstreamBaseUrl, apiKey } = loadConfiguration();
  const upstream = parseUpstream(upstreamBaseUrl);
  const server = createProxyServer({ upstreamBaseUrl, apiKey });
  server.on('error', (error) => {
    console.error(`[proxy] server error (${error.code || 'UNKNOWN'})`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.info(`[proxy] listening on http://127.0.0.1:${port}`);
    console.info(`[proxy] upstream: ${upstream.href}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      server.close();
      server.closeAllConnections();
    });
  }
  return server;
}

if (require.main === module) {
  try {
    start();
  } catch {
    console.error('[proxy] invalid configuration: check config.json/PROXY_CONFIG_FILE, apiKey, PORT and OMNIROUTE_BASE_URL (HTTP(S), no credentials/query/fragment)');
    process.exitCode = 1;
  }
}

module.exports = { createProxyServer, start };
