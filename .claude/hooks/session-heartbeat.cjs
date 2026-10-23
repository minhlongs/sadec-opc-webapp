#!/usr/bin/env node
/**
 * Session heartbeat: tells the background auto-updater which projects have a
 * live agent session, and relays the last auto-update result once.
 *
 * Each session keeps one marker at
 *   <AGENTKIT_HOME>/state/session-heartbeats/<sha256(realpath cwd)[:16]>/<session>.json
 * holding {cwd, session_id, runtime, updated_at}. SessionStart, UserPromptSubmit
 * and Stop refresh it; SessionEnd removes it. The updater treats a fresh marker
 * as "in use" and skips that project, and markers a runtime never cleans up
 * expire by age on the reader side. SessionStart also removes stale markers
 * of other sessions in its own project directory, a bounded number per start,
 * so sessions that end without SessionEnd do not accumulate.
 *
 * Markers are written whatever the auto-update schedule, so a project opted
 * in later is already protected from being updated under a running session.
 * Directories are created one level at a time below an existing AgentKit
 * home, and a symlinked or non-directory component stops the write, so the
 * hook never creates anything outside that home.
 *
 * On SessionStart an unacknowledged result is acknowledged through the `ak`
 * binary (the only writer of the state file) and printed as a single line. If
 * the binary cannot confirm the acknowledgement, nothing is printed.
 *
 * The hook never blocks and never speaks on stderr: every failure exits 0.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_SCANNED_PROJECTS = 256;
const MAX_SESSION_ID_LENGTH = 128;
const MAX_RUNTIME_LENGTH = 64;
// Pruning mirrors the updater's liveness rule (HeartbeatTTL and
// heartbeatFutureSkew in apps/cli/internal/runtime/autoupdate/liveness.go).
const HEARTBEAT_TTL_MS = 6 * 60 * 60 * 1000;
const HEARTBEAT_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_PRUNED_ENTRIES = 256;
const MAX_MARKER_BYTES = 64 * 1024;

// Cursor spells its events in camelCase and names the prompt event differently.
const EVENTS = new Map([
  ['sessionstart', 'SessionStart'],
  ['userpromptsubmit', 'UserPromptSubmit'],
  ['beforesubmitprompt', 'UserPromptSubmit'],
  ['stop', 'Stop'],
  ['sessionend', 'SessionEnd']
]);

function readStdin() {
  const chunks = [];
  let total = 0;
  const buffer = Buffer.alloc(64 * 1024);
  for (;;) {
    let count;
    try {
      count = fs.readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      // Windows reports a closed pipe as EOF, and a stdin that is not ready
      // has nothing for a hook to wait on.
      if (error && (error.code === 'EOF' || error.code === 'EAGAIN')) break;
      throw error;
    }
    if (count === 0) break;
    total += count;
    if (total > MAX_STDIN_BYTES) return null;
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function readPayload() {
  const raw = readStdin();
  if (!raw || !raw.trim()) return null;
  const payload = JSON.parse(raw);
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
}

function firstString(...values) {
  return values.find(value => typeof value === 'string' && value.trim() !== '') || '';
}

function sessionIdFrom(payload) {
  const raw = firstString(payload.session_id, payload.conversation_id, payload.sessionId);
  return raw.replace(/[^A-Za-z0-9._-]/g, '').slice(0, MAX_SESSION_ID_LENGTH);
}

function sessionCwd(payload) {
  const roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : [];
  const candidate = firstString(payload.cwd, roots[0], process.env.CLAUDE_PROJECT_DIR) || process.cwd();
  try {
    return fs.realpathSync.native(candidate);
  } catch (error) {
    return path.resolve(candidate);
  }
}

function runtimeLabel(payload) {
  if (process.env.CLAUDE_PROJECT_DIR || process.env.CLAUDE_PLUGIN_ROOT) return 'claude-code';
  const runtime = firstString(payload.runtime);
  return runtime ? runtime.slice(0, MAX_RUNTIME_LENGTH) : 'unknown';
}

function projectKey(realCwd) {
  const normalized = process.platform === 'win32' ? realCwd.toLowerCase() : realCwd;
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

function isRealDirectory(target) {
  try {
    const info = fs.lstatSync(target);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    return false;
  }
}

// ensureRealDirectory makes one directory level, and reports whether target is
// now a real directory. A symlink or file in its place is left alone, so no
// write ever lands behind it.
function ensureRealDirectory(target) {
  try {
    fs.mkdirSync(target, { mode: 0o700 });
  } catch (error) {
    if (!error || error.code !== 'EEXIST') return false;
  }
  return isRealDirectory(target);
}

function isExistingDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch (error) {
    return false;
  }
}

function writeMarker(home, heartbeatsDir, payload, sessionId) {
  const cwd = sessionCwd(payload);
  const directory = path.join(heartbeatsDir, projectKey(cwd));
  // The home itself may be a symlink the user set up; everything below it is
  // AgentKit's and must be real directories.
  if (!isExistingDirectory(home)) return;
  for (const level of [path.dirname(heartbeatsDir), heartbeatsDir, directory]) {
    if (!ensureRealDirectory(level)) return;
  }

  const marker = {
    cwd,
    session_id: sessionId,
    runtime: runtimeLabel(payload),
    updated_at: new Date().toISOString()
  };
  const target = path.join(directory, `${sessionId}.json`);
  const temporary = path.join(
    directory,
    `.${sessionId}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  );
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(marker)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, target);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch (cleanupError) {
      // Nothing was left behind.
    }
    throw error;
  }
  return directory;
}

function markerIsStale(file, info, now) {
  let updatedAt = info.mtimeMs;
  if (info.size <= MAX_MARKER_BYTES) {
    try {
      const parsed = Date.parse(JSON.parse(fs.readFileSync(file, 'utf8')).updated_at);
      if (!Number.isNaN(parsed)) updatedAt = parsed;
    } catch (error) {
      // Unreadable content falls back to the file mtime, as the updater does.
    }
  }
  const age = now - updatedAt;
  return age > HEARTBEAT_TTL_MS || age < -HEARTBEAT_FUTURE_SKEW_MS;
}

// Removes stale markers of other sessions in this project's directory, so
// sessions that ended without SessionEnd do not accumulate. It examines at
// most MAX_PRUNED_ENTRIES entries per call and only regular *.json files:
// Dirent types and the lstat come from the entry itself, so a symlink is
// never read through, and unlink removes a name, never a link target.
function pruneStaleMarkers(directory, keep) {
  const now = Date.now();
  const entries = fs.readdirSync(directory, { withFileTypes: true }).slice(0, MAX_PRUNED_ENTRIES);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === keep) continue;
    const file = path.join(directory, entry.name);
    try {
      const info = fs.lstatSync(file);
      if (!info.isFile() || !markerIsStale(file, info, now)) continue;
      fs.unlinkSync(file);
    } catch (error) {
      // A marker removed or rewritten meanwhile is simply skipped.
    }
  }
}

// The session may have changed directory since its marker was written, so the
// marker is found by session id across project directories, not by cwd.
function removeMarkers(heartbeatsDir, sessionId) {
  if (!isRealDirectory(heartbeatsDir)) return;
  const entries = fs.readdirSync(heartbeatsDir, { withFileTypes: true });
  let scanned = 0;
  for (const entry of entries) {
    // Dirent types come from lstat, so a symlinked directory is skipped here.
    if (!entry.isDirectory()) continue;
    if (++scanned > MAX_SCANNED_PROJECTS) break;
    const directory = path.join(heartbeatsDir, entry.name);
    const marker = path.join(directory, `${sessionId}.json`);
    try {
      if (!fs.lstatSync(marker).isFile()) continue;
      fs.unlinkSync(marker);
    } catch (error) {
      continue;
    }
    try {
      fs.rmdirSync(directory);
    } catch (error) {
      // Another session of the same project still has a marker here.
    }
  }
}

function readState(statePath) {
  const descriptor = fs.openSync(statePath, 'r');
  try {
    if (fs.fstatSync(descriptor).size > MAX_STATE_BYTES) return null;
    const state = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    return state && typeof state === 'object' ? state : null;
  } finally {
    fs.closeSync(descriptor);
  }
}

function singleLine(text) {
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function relayNotice(statePath) {
  const state = readState(statePath);
  if (!state || state.acknowledged !== false) return;
  if (typeof state.summary !== 'string' || state.summary.trim() === '') return;

  // Loaded only here, so the per-prompt path never pays for it.
  const { acknowledgeAutoUpdate } = require('./lib/ak-prefs-client.cjs');
  const summary = acknowledgeAutoUpdate();
  if (!summary) return;
  const line = singleLine(summary);
  if (line) process.stdout.write(`[agentkit] ${line}\n`);
}

function main() {
  const payload = readPayload();
  if (!payload) return;
  const event = EVENTS.get(String(payload.hook_event_name || '').toLowerCase());
  if (!event) return;

  const home = path.resolve(process.env.AGENTKIT_HOME || path.join(os.homedir(), '.agentkit'));
  const stateDir = path.join(home, 'state');
  const heartbeatsDir = path.join(stateDir, 'session-heartbeats');
  const sessionId = sessionIdFrom(payload);

  if (event === 'SessionEnd') {
    if (sessionId) removeMarkers(heartbeatsDir, sessionId);
    return;
  }

  if (sessionId) {
    let directory;
    try {
      directory = writeMarker(home, heartbeatsDir, payload, sessionId);
    } catch (error) {
      // A marker that cannot be written only weakens the updater's guard.
    }
    if (directory && event === 'SessionStart') {
      try {
        pruneStaleMarkers(directory, `${sessionId}.json`);
      } catch (error) {
        // Stale markers left in place only cost the updater a longer scan.
      }
    }
  }
  if (event !== 'SessionStart') return;
  // Only an existing state file can hold a result to relay.
  const statePath = path.join(stateDir, 'auto-update.json');
  if (fs.existsSync(statePath)) relayNotice(statePath);
}

try {
  main();
} catch (error) {
  // Fail silent: a heartbeat must never disturb the session it describes.
}
process.exitCode = 0;
