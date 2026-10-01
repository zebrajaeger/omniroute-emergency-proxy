'use strict';

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { validateHeaderValue } = require('node:http');

const DEFAULT_UPSTREAM = 'http://192.168.178.2:20128';
const DEFAULT_CONFIG_PATH = join(__dirname, '..', 'config.json');

function validateApiKey(apiKey) {
  if (typeof apiKey !== 'string' || apiKey !== apiKey.trim()) {
    throw new Error('apiKey must be a string without surrounding whitespace');
  }
  try {
    validateHeaderValue('authorization', `Bearer ${apiKey}`);
  } catch {
    // Never include the secret or Node's detailed header error in the message.
    throw new Error('apiKey contains invalid HTTP header characters');
  }
  return apiKey;
}

function loadConfiguration({ env = process.env, configPath = env.PROXY_CONFIG_FILE || DEFAULT_CONFIG_PATH } = {}) {
  let text;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT' || env.PROXY_CONFIG_FILE) {
      throw new Error('Cannot read proxy configuration file');
    }
  }

  let config = {};
  if (text !== undefined) {
    try {
      // Windows editors may save UTF-8 files with a BOM.
      config = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
      throw new Error('Proxy configuration must contain valid JSON');
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('Proxy configuration must be a JSON object');
    }
  }

  if (config.upstreamBaseUrl !== undefined
    && (typeof config.upstreamBaseUrl !== 'string' || !config.upstreamBaseUrl.trim())) {
    throw new Error('upstreamBaseUrl must be a nonempty string');
  }

  return {
    upstreamBaseUrl: env.OMNIROUTE_BASE_URL || config.upstreamBaseUrl || DEFAULT_UPSTREAM,
    apiKey: validateApiKey(config.apiKey === undefined ? '' : config.apiKey),
  };
}

module.exports = { DEFAULT_UPSTREAM, loadConfiguration, validateApiKey };
