#!/usr/bin/env node
/**
 * Agent Behavior Linter Hook
 *
 * Observes tool behavior during a session and, at `Stop`, reports the coding
 * anti-patterns it can prove from what it saw: re-reading an unchanged file,
 * re-running a deterministic failure, sweeping the tree instead of narrowing,
 * accumulating output that changed nothing, and verifying a documentation-only
 * change with a repository-wide suite.
 *
 * The governing principles live in `ak:context-engineering`; findings link to
 * them rather than restating them.
 *
 * This hook is deliberately never registered on `PreToolUse`, the only event
 * that can deny a tool call. Observation therefore cannot block anything as a
 * matter of structure, not of promise, and every exit path prints
 * `{"continue": true}`.
 */

'use strict';

const fs = require('node:fs');

const HOOK_NAME = 'agent-behavior-linter';

function readPayload() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf-8') || '{}');
  } catch {
    return {};
  }
}

// Stop output carries only `continue` and `systemMessage`: Claude Code accepts
// no `hookSpecificOutput` for Stop, and the Codex Stop wire rejects unknown
// fields, so any other shape turns a report into a hook error.
function emitContinue(summary) {
  const output = { continue: true };
  if (summary) output.systemMessage = summary;
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function runAgentBehaviorLinterHook() {
  const payload = readPayload();
  const event = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : '';
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();

  // Cheapest possible rejection first: this runs on every tool call.
  if (event !== 'PostToolUse' && event !== 'PreCompact' && event !== 'Stop') {
    emitContinue();
    return;
  }

  let isHookEnabled;
  try {
    ({ isHookEnabled } = require('./lib/ck-config-utils.cjs'));
  } catch {
    emitContinue();
    return;
  }
  if (!isHookEnabled(HOOK_NAME, { cwd })) {
    emitContinue();
    return;
  }

  const store = require('./lib/agent-behavior-linter/store.cjs');
  const context = store.createContext({
    sessionId: payload.session_id,
    cwd
  });
  if (!context) {
    // Without a resolvable session identity there is nowhere safe to record.
    emitContinue();
    return;
  }

  if (event === 'PostToolUse' || event === 'PreCompact') {
    const { normalizeEvent } = require('./lib/agent-behavior-linter/event-schema.cjs');
    const record = normalizeEvent(payload);
    if (!record) {
      emitContinue();
      return;
    }
    const state = store.readState(context);
    store.writeState(context, store.applyEvent(state, record));
    emitContinue();
    return;
  }

  const { runDetectors } = require('./lib/agent-behavior-linter/detectors.cjs');
  const { renderSummary } = require('./lib/agent-behavior-linter/report.cjs');
  const state = store.readState(context);
  const findings = runDetectors(state);
  store.writeState(context, store.recordFindings(state, findings));

  emitContinue(renderSummary(state, findings));
}

function main() {
  try {
    runAgentBehaviorLinterHook();
  } catch (error) {
    try {
      require('./lib/hook-logger.cjs').logHookCrash(HOOK_NAME, error);
    } catch {
      // Logging must never be the reason a session sees a failed hook.
    }
    emitContinue();
  }
}

if (require.main === module) {
  main();
}

module.exports = { HOOK_NAME, main, runAgentBehaviorLinterHook };
