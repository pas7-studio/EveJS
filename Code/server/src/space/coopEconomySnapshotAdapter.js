'use strict';

/**
 * CommonJS adapter that builds a read-only economy snapshot from a set of
 * reader sources. Each reader is { id, read }. A reader is VERIFIED only when
 * its `read` is a function and does not throw; otherwise it is UNVERIFIED and
 * contributes nothing (never a zero, never a default value).
 *
 * The adapter never writes, never mutates reader results, and never touches
 * process.env.
 */

function isPlainMap(value) {
  return value !== null && typeof value === 'object';
}

function addNumeric(acc, key, value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    acc[key] = (acc[key] || 0) + value;
  }
}

function mergeMap(acc, source) {
  if (!isPlainMap(source)) return acc;
  for (const key of Object.keys(source)) {
    addNumeric(acc, key, source[key]);
  }
  return acc;
}

function buildSnapshot({ readers = [], now, ttlMs } = {}) {
  const observedAt = typeof now === 'number' ? now : Date.now();
  const expiresAt = observedAt + (typeof ttlMs === 'number' ? ttlMs : 30000);

  const itemsByType = {};
  const incomingByType = {};
  const reservedByType = {};
  const sources = [];
  const unverifiedSources = [];

  for (const reader of readers) {
    if (!reader || typeof reader.read !== 'function') {
      if (reader && typeof reader.id === 'string') unverifiedSources.push(reader.id);
      continue;
    }

    let data;
    try {
      data = reader.read();
    } catch (err) {
      if (typeof reader.id === 'string') unverifiedSources.push(reader.id);
      continue;
    }

    if (typeof reader.id === 'string') sources.push(reader.id);

    if (isPlainMap(data)) {
      mergeMap(itemsByType, data.itemsByType);
      mergeMap(incomingByType, data.incomingByType);
      mergeMap(reservedByType, data.reservedByType);
    }
  }

  sources.sort();
  unverifiedSources.sort();

  return {
    version: 1,
    observedAt,
    expiresAt,
    sources,
    unverifiedSources,
    itemsByType,
    incomingByType,
    reservedByType,
    blockedReasons: unverifiedSources.length ? ['UNVERIFIED_SOURCE'] : []
  };
}

module.exports = { buildSnapshot };
