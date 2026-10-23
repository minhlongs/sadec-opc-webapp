'use strict';

/**
 * journal.cjs - Bounded, redacted record of firewall interventions.
 *
 * Two jobs, one store:
 * 1. Record why each intervention happened, with the original and the effective
 *    operation, so a run can be audited afterwards.
 * 2. Count how often the same operation has already been intervened on, so the
 *    policy can escalate a repeatedly ignored warning into a block.
 *
 * The store lives in the same private per-session directory the other hooks
 * use, is capped at MAX_ENTRIES, and never holds raw secret material.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sessionStore = require('../private-json-store.cjs');
const { readJsonFile, writeJsonFile } = require('../bounded-json-file.cjs');
const { SECRET_KEYWORD_PATTERNS } = require('../secret-keywords.cjs');

const JOURNAL_FILE = 'context-firewall.json';
const MAX_ENTRIES = 50;
const MAX_FIELD_CHARS = 300;

// Assignments and headers whose value is credential material.
const SECRET_VALUE_PATTERNS = [
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY)[A-Z0-9_]*)=(\S+)/gi,
  /(--(?:token|password|secret|api-key|access-key)(?:=|\s+))(\S+)/gi,
  /\b(Bearer\s+)([A-Za-z0-9._\-]{8,})/gi,
  /\b(Authorization:\s*\S+\s+)(\S+)/gi
];

/**
 * Strip credential material from a string before it is written or printed.
 *
 * Replaces the *value* of a recognised secret assignment and collapses any
 * operand that merely mentions a secret keyword, so neither the value nor a
 * surprising path leaks into the journal.
 *
 * @param {string} value
 * @returns {string}
 */
function redact(value) {
  if (typeof value !== 'string' || !value) return '';

  let output = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    output = output.replace(pattern, (_match, prefix) => `${prefix}[redacted]`);
  }

  output = output
    .split(/(\s+)/)
    .map(token => (SECRET_KEYWORD_PATTERNS.some(pattern => pattern.test(token)) ? '[redacted]' : token))
    .join('');

  return output.length > MAX_FIELD_CHARS ? `${output.slice(0, MAX_FIELD_CHARS)}…` : output;
}

/**
 * Stable identity for "the same risky operation", used for repeat counting.
 *
 * Built from the signal and the operation's shape rather than its exact text,
 * so `cat big.log` and `cat  big.log` count as one operation.
 *
 * @param {object} args
 * @param {string} args.kind
 * @param {string} args.signalId
 * @param {string} args.target
 * @returns {string}
 */
function fingerprint({ kind, signalId, target }) {
  const normalized = `${kind || ''}|${signalId || ''}|${String(target || '').trim().replace(/\s+/g, ' ')}`;
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Resolve the journal file path for this session, or null when no private
 * session directory is available (unbound runtime, test harness, CI).
 */
function journalPath(context) {
  const directory = sessionStore.sessionDirectory(context);
  return directory ? path.join(directory, JOURNAL_FILE) : null;
}

function emptyJournal() {
  return { version: 1, entries: [], counts: {} };
}

/**
 * Load the journal, returning an empty one for any unreadable or malformed
 * store so a corrupt file can never block a tool call.
 */
function load(context) {
  const filePath = journalPath(context);
  if (!filePath) return { filePath: null, data: emptyJournal() };

  try {
    const root = sessionStore.privateRoot(context);
    const data = readJsonFile(filePath, root);
    if (data && typeof data === 'object' && Array.isArray(data.entries)) {
      return { filePath, data: { version: 1, entries: data.entries, counts: data.counts || {} } };
    }
  } catch { /* unreadable or malformed — start fresh */ }

  return { filePath, data: emptyJournal() };
}

/**
 * How many times this operation has already been intervened on this session.
 *
 * @param {object} context
 * @param {string} id fingerprint
 * @returns {number}
 */
function repeatCount(context, id) {
  const { data } = load(context);
  const count = data.counts[id];
  return Number.isFinite(count) && count > 0 ? count : 0;
}

/**
 * Append one intervention. Returns false when nothing was persisted, which is
 * a degraded-but-safe outcome rather than an error.
 *
 * @param {object} args
 * @param {object} args.context session state context
 * @param {string} args.id fingerprint
 * @param {object} args.entry {action, signalId, reason, original, effective}
 * @returns {boolean}
 */
function record({ context, id, entry }) {
  const { filePath, data } = load(context);
  if (!filePath) return false;

  data.counts[id] = (data.counts[id] || 0) + 1;
  data.entries.push({
    at: new Date().toISOString(),
    fingerprint: id,
    action: entry.action,
    signal: entry.signalId,
    reason: redact(entry.reason),
    original: redact(entry.original),
    effective: redact(entry.effective)
  });

  if (data.entries.length > MAX_ENTRIES) {
    data.entries = data.entries.slice(-MAX_ENTRIES);
  }

  try {
    const root = sessionStore.privateRoot(context);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    writeJsonFile({ root, filePath, value: data });
    return true;
  } catch {
    return false;
  }
}

module.exports = { redact, fingerprint, repeatCount, record, journalPath, MAX_ENTRIES };
