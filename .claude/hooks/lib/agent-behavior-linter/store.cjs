/**
 * store.cjs - Bounded per-session state for the agent behavior linter.
 *
 * State lives in the private session store the kit already owns
 * (`lib/private-json-store.cjs`), so this adds no new operational data
 * surface: nothing is written inside the repository, inside `~/.agentkit`, or
 * anywhere a later session could read another session's record.
 *
 * Only aggregates are kept. There is no raw event log, and the tracked maps are
 * bounded with least-recently-used eviction so a long session cannot grow the
 * file without limit.
 *
 * @module agent-behavior-linter/store
 */

'use strict';

const path = require('node:path');

const { SCHEMA_VERSION } = require('./event-schema.cjs');

const STORE_FILENAME = 'agent-behavior-linter.json';
const MAX_TRACKED_FILES = 200;
const MAX_TRACKED_COMMANDS = 200;
const MAX_FINDINGS = 32;
const MAX_TRACKED_RANGES = 8;

function sessionStore() {
  return require('../private-json-store.cjs');
}

/**
 * Build the session identity this store is keyed by.
 *
 * @param {object} options - `{ sessionId, cwd, runtime?, storageRoot? }`.
 * @returns {object|null} Frozen session context, or null when identity is
 *   incomplete (an unknown runtime, an unusable cwd, a missing session id).
 */
function createContext(options = {}) {
  try {
    const { createSessionStateContext } = require('../ck-config-utils.cjs');
    return createSessionStateContext(options);
  } catch {
    return null;
  }
}

function storePath(context) {
  const directory = sessionStore().sessionDirectory(context);
  return directory ? path.join(directory, STORE_FILENAME) : null;
}

function emptyState() {
  return {
    version: SCHEMA_VERSION,
    startedAt: Date.now(),
    counters: { reads: 0, searches: 0, commands: 0, mutations: 0, outputBytes: 0, compactions: 0 },
    files: {},
    commands: {},
    searches: [],
    findings: []
  };
}

function isUsableState(value) {
  return Boolean(
    value && typeof value === 'object' &&
    value.version === SCHEMA_VERSION &&
    value.counters && typeof value.counters === 'object' &&
    value.files && typeof value.files === 'object' &&
    value.commands && typeof value.commands === 'object'
  );
}

/**
 * Read the session state, degrading to a fresh one whenever the stored file is
 * missing, unreadable, oversized, or written by an older schema.
 */
function readState(context) {
  const filePath = storePath(context);
  if (!filePath) return emptyState();
  try {
    const store = sessionStore();
    const value = store.readJsonFile(filePath, store.privateRoot(context));
    if (!isUsableState(value)) return emptyState();
    if (!Array.isArray(value.searches)) value.searches = [];
    if (!Array.isArray(value.findings)) value.findings = [];
    return value;
  } catch {
    return emptyState();
  }
}

function writeState(context, state) {
  const filePath = storePath(context);
  if (!filePath) return false;
  try {
    return sessionStore().writeJsonFile(context, filePath, state);
  } catch {
    return false;
  }
}

/**
 * Drop the least recently touched entries until `map` fits its bound.
 */
function evictLeastRecentlyUsed(map, limit) {
  const keys = Object.keys(map);
  if (keys.length <= limit) return;
  keys
    .sort((left, right) => (map[left]?.lastAt || 0) - (map[right]?.lastAt || 0))
    .slice(0, keys.length - limit)
    .forEach(key => { delete map[key]; });
}

/**
 * Fold one redacted event record into the session aggregates.
 *
 * @param {object} state - State from `readState`; mutated in place.
 * @param {object} record - Record from `normalizeEvent`.
 * @returns {object} The same state, for chaining.
 */
function applyEvent(state, record) {
  if (!isUsableState(state) || !record || typeof record !== 'object') return state;

  if (record.kind === 'compaction') {
    // Re-reading a file after compaction is correct behavior, not waste, so the
    // evidence that would accuse it is discarded rather than carried forward.
    state.counters.compactions += 1;
    state.files = {};
    state.commands = {};
    state.searches = [];
    return state;
  }

  state.counters.outputBytes += Number.isFinite(record.outputBytes) ? record.outputBytes : 0;

  if (record.kind === 'read') {
    state.counters.reads += 1;
    if (!record.inside) return state;
    const entry = state.files[record.path] || {
      reads: 0, lastMtimeMs: null, lastSize: null, ranges: [], mutatedAt: null, lastAt: 0
    };
    const unchanged = entry.lastMtimeMs === record.mtimeMs && entry.lastSize === record.size;
    entry.reads = unchanged ? entry.reads + 1 : 1;
    entry.lastMtimeMs = record.mtimeMs;
    entry.lastSize = record.size;
    entry.lastAt = record.at;
    if (!entry.ranges.includes(record.range)) {
      entry.ranges = entry.ranges.concat(record.range).slice(-MAX_TRACKED_RANGES);
    }
    state.files[record.path] = entry;
    evictLeastRecentlyUsed(state.files, MAX_TRACKED_FILES);
    return state;
  }

  if (record.kind === 'mutation') {
    state.counters.mutations += 1;
    if (!record.inside) return state;
    const entry = state.files[record.path] || {
      reads: 0, lastMtimeMs: null, lastSize: null, ranges: [], mutatedAt: null, lastAt: 0
    };
    // A mutation invalidates every read that came before it.
    entry.reads = 0;
    entry.lastMtimeMs = null;
    entry.lastSize = null;
    entry.mutatedAt = record.at;
    entry.documentation = record.documentation === true;
    entry.lastAt = record.at;
    state.files[record.path] = entry;
    // Any command that failed before this edit may now behave differently.
    for (const key of Object.keys(state.commands)) {
      state.commands[key].mutatedSince = true;
    }
    evictLeastRecentlyUsed(state.files, MAX_TRACKED_FILES);
    return state;
  }

  if (record.kind === 'search') {
    state.counters.searches += 1;
    state.searches = state.searches
      .concat({
        at: record.at,
        root: record.root,
        tool: record.tool,
        // The verdict only: the pattern that produced it is not retained.
        broad: record.broad === true
      })
      .slice(-MAX_TRACKED_COMMANDS);
    return state;
  }

  if (record.kind === 'command') {
    state.counters.commands += 1;
    if (record.fullSuite) {
      state.fullSuiteCommand = { class: record.commandClass, at: record.at, hash: record.commandHash };
    }
    if (!record.failed) {
      delete state.commands[record.commandHash];
      return state;
    }
    const previous = state.commands[record.commandHash];
    const sameFailure = Boolean(
      previous &&
      previous.errorSigHash === record.errorSigHash &&
      previous.mutatedSince !== true
    );
    state.commands[record.commandHash] = {
      class: record.commandClass,
      attempts: sameFailure ? previous.attempts + 1 : 1,
      errorSigHash: record.errorSigHash,
      nondeterministic: record.nondeterministic === true,
      mutatedSince: false,
      lastAt: record.at
    };
    evictLeastRecentlyUsed(state.commands, MAX_TRACKED_COMMANDS);
    return state;
  }

  return state;
}

function recordFindings(state, findings) {
  if (!isUsableState(state) || !Array.isArray(findings)) return state;
  state.findings = findings.slice(0, MAX_FINDINGS);
  return state;
}

module.exports = {
  MAX_FINDINGS,
  MAX_TRACKED_COMMANDS,
  MAX_TRACKED_FILES,
  STORE_FILENAME,
  applyEvent,
  createContext,
  emptyState,
  evictLeastRecentlyUsed,
  isUsableState,
  readState,
  recordFindings,
  storePath,
  writeState
};
