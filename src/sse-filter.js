'use strict';

const { Transform } = require('node:stream');
const { TextDecoder } = require('node:util');

const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;

function inspectFrame(frame) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(frame);
  } catch {
    return { created: false, invalid: false };
  }

  let hasEvent = false;
  let event;
  const data = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      hasEvent = true;
      event = value;
    } else if (field === 'data') {
      data.push(value);
    }
  }

  let payload;
  try {
    payload = JSON.parse(data.join('\n'));
  } catch {
    // An explicit created event is sufficient to stop initial filtering.
  }
  return {
    created: event === 'response.created' || payload?.type === 'response.created',
    invalid: !hasEvent && payload?.type === 'response.in_progress'
      && payload?.response?.id === null,
  };
}

class InitialResponseFilter extends Transform {
  constructor({ onStrip = () => {}, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES } = {}) {
    super();
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
      throw new RangeError('maxFrameBytes must be a positive integer');
    }
    this.onStrip = onStrip;
    this.maxFrameBytes = maxFrameBytes;
    this.filtering = true;
    this.parts = [];
    this.frameSize = 0;
    this.lineLength = 0;
    this.lastByte = -1;
  }

  _transform(chunk, encoding, callback) {
    if (!this.filtering) {
      this.push(chunk);
      callback();
      return;
    }

    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i];
      this.frameSize++;
      if (this.frameSize > this.maxFrameBytes) {
        // Fail open for oversized/unterminated frames, never buffer indefinitely.
        for (const part of this.parts) this.push(part);
        this.parts = [];
        this.filtering = false;
        this.push(chunk.subarray(start));
        callback();
        return;
      }

      if (byte === 10) {
        const blankLine = this.lineLength === 0
          || (this.lineLength === 1 && this.lastByte === 13);
        this.lineLength = 0;
        if (blankLine) {
          this.parts.push(chunk.subarray(start, i + 1));
          const frame = Buffer.concat(this.parts, this.frameSize);
          this.parts = [];
          this.frameSize = 0;
          start = i + 1;
          const { created, invalid } = inspectFrame(frame);
          if (created) this.filtering = false;
          if (invalid && !created) this.onStrip();
          else this.push(frame);

          if (!this.filtering) {
            if (start < chunk.length) this.push(chunk.subarray(start));
            callback();
            return;
          }
        }
      } else {
        this.lineLength++;
      }
      this.lastByte = byte;
    }

    if (start < chunk.length) this.parts.push(chunk.subarray(start));
    callback();
  }

  _flush(callback) {
    // No terminating blank line: do not guess whether this is a removable event.
    for (const part of this.parts) this.push(part);
    this.parts = [];
    callback();
  }
}

module.exports = { InitialResponseFilter };
