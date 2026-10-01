'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { InitialResponseFilter } = require('../src/sse-filter');

const invalid = 'data: {"type":"response.in_progress","sequence_number":1,"response":{"id":null,"status":"in_progress"}}\n\n';
const created = 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"},"sequence_number":1}\n\n';
const progress = 'event: response.in_progress\ndata: {"type":"response.in_progress","response":{"id":"resp_1"},"sequence_number":2}\n\n';

async function filter(chunks, options) {
  const output = [];
  await pipeline(
    Readable.from(chunks.map((chunk) => Buffer.from(chunk))),
    new InitialResponseFilter(options),
    new Writable({ write(chunk, encoding, callback) { output.push(chunk); callback(); } }),
  );
  return Buffer.concat(output);
}

test('A: removes only the invalid initial frame including its separator', async () => {
  let stripped = 0;
  assert.deepEqual(await filter([invalid + created], { onStrip: () => stripped++ }), Buffer.from(created));
  assert.equal(stripped, 1);
});

test('B: preserves regular response.in_progress byte for byte', async () => {
  assert.deepEqual(await filter([created + progress]), Buffer.from(created + progress));
});

test('C: preserves unknown data-only frames', async () => {
  const input = 'data: {"type":"something_else","foo":"bar"}\n\n';
  assert.deepEqual(await filter([input]), Buffer.from(input));
});

test('D: preserves invalid JSON', async () => {
  const input = 'data: not-json\n\n';
  assert.deepEqual(await filter([input]), Buffer.from(input));
});

test('E: handles every possible two-chunk split and one-byte chunks', async () => {
  const input = Buffer.from(invalid + created + progress);
  const expected = Buffer.from(created + progress);
  for (let split = 1; split < input.length; split++) {
    assert.deepEqual(await filter([input.subarray(0, split), input.subarray(split)]), expected);
  }
  assert.deepEqual(await filter(Array.from(input, (byte) => Buffer.from([byte]))), expected);
});

test('F: preserves CRLF and handles split separators', async () => {
  const input = (invalid + created + progress).replaceAll('\n', '\r\n');
  const expected = (created + progress).replaceAll('\n', '\r\n');
  assert.deepEqual(await filter([...Buffer.from(input)].map((byte) => Buffer.from([byte]))), Buffer.from(expected));
});

test('G: never filters data-only frames after response.created', async () => {
  assert.deepEqual(await filter([created, invalid]), Buffer.from(created + invalid));
});

test('a data-only response.created also disables filtering', async () => {
  const dataCreated = 'data: {"type":"response.created"}\n\n';
  assert.deepEqual(await filter([dataCreated + invalid]), Buffer.from(dataCreated + invalid));
});

test('an explicit response.created disables filtering even without JSON', async () => {
  const eventCreated = 'event: response.created\ndata: not-json\n\n';
  assert.deepEqual(await filter([eventCreated + invalid]), Buffer.from(eventCreated + invalid));
});

test('any event field prevents removal, including empty and colonless fields', async () => {
  for (const field of ['event: response.in_progress', 'event:', 'event', 'event: custom']) {
    const input = field + '\n' + invalid;
    assert.deepEqual(await filter([input]), Buffer.from(input));
  }
});

test('non-null or absent ids, other types and JSON primitives remain untouched', async () => {
  for (const json of [
    '{"type":"response.in_progress","response":{"id":"resp_1"}}',
    '{"type":"response.in_progress","response":{}}',
    '{"type":"response.in_progress","response":null}',
    '{"type":"other","response":{"id":null}}',
    'null', '42', '[]', '"response.in_progress"',
  ]) {
    const input = `data: ${json}\n\n`;
    assert.deepEqual(await filter([input]), Buffer.from(input));
  }
});

test('parses multiline SSE data without changing preserved frames', async () => {
  const input = ': keepalive\nid: 1\ndata: {"type":"response.in_progress",\ndata: "response":{"id":null}}\n\n';
  assert.deepEqual(await filter([input + created]), Buffer.from(created));
  const unknown = ': comment\nid: 2\ndata: {"type":"other",\ndata: "text":"ä🙂"}\n\n';
  assert.deepEqual(await filter([...Buffer.from(unknown)].map((byte) => Buffer.from([byte]))), Buffer.from(unknown));
});

test('comments, whitespace and trailing incomplete frames remain byte-identical', async () => {
  const input = '\n: heartbeat\r\n\r\ndata: [DONE]\n\ndata: {"type":"response.in_progress","response":{"id":null}}';
  assert.deepEqual(await filter([input]), Buffer.from(input));
});

test('invalid UTF-8 is forwarded unchanged', async () => {
  const input = Buffer.concat([Buffer.from('data: {"type":"response.in_progress","response":{"id":null},"x":"'), Buffer.from([0xff]), Buffer.from('"}\n\n')]);
  assert.deepEqual(await filter([input]), input);
});

test('oversized frames fail open and permanently disable filtering', async () => {
  const input = ': ' + 'x'.repeat(100) + '\n\n' + invalid;
  assert.deepEqual(await filter([input.slice(0, 10), input.slice(10)], { maxFrameBytes: 32 }), Buffer.from(input));
});

test('filter limit must be a positive integer', () => {
  assert.throws(() => new InitialResponseFilter({ maxFrameBytes: 0 }), RangeError);
});
