#!/usr/bin/env node
'use strict';

/**
 * PreCompact Hook - Capture orientation anchors before compaction
 *
 * Fires: Before the transcript is compacted (manual or auto).
 * Purpose: Persist the machine-derivable orientation (worktree, main project
 *   root, branch, HEAD, dirty count, active plan) into session state so the
 *   post-compaction SessionStart:compact reminder can present concrete anchors.
 *
 * Why a side-effect capture and not a printed reminder: PreCompact stdout is
 * NOT injected into the model's post-compaction context (unlike
 * SessionStart:compact, which is). The agent also does not get a turn between
 * "context full" and an auto-compact, so it cannot be prompted to journal at
 * that instant. This hook therefore records what it can derive deterministically;
 * session-init.cjs surfaces it and reminds the agent to re-establish the rest.
 *
 * Exit code: always 0 (non-blocking; never obstruct compaction). Fail-open is
 * not fail-silent: every path that does not persist anchors writes one hook-log
 * entry naming the reason, so a skipped capture is distinguishable from "no
 * compaction happened". Reasons are closed-vocabulary codes - never a session
 * id, a path, a branch name, or any payload content.
 */

const HOOK_NAME = 'precompact-capture';

// The runtimes name the compaction cause differently and the field is theirs,
// not ours: Claude Code sends manual/auto, the Pi bridge forwards its own
// event.reason verbatim. Map the known values and collapse everything else, the
// same way bridge.ts closes the SessionStart vocabulary, so the logged value is
// ours rather than whatever the payload happened to carry.
const TRIGGERS = Object.freeze({
  manual: 'manual',
  auto: 'auto',
  threshold: 'threshold'
});

try {
  const fs = require('fs');
  const { execFileSync } = require('child_process');
  const {
    describeSessionStateContext,
    updateSessionState,
    isHookEnabled
  } = require('./lib/ck-config-utils.cjs');
  const { createHookTimer } = require('./lib/hook-logger.cjs');

  const timer = createHookTimer(HOOK_NAME, { event: 'PreCompact' });

  if (!isHookEnabled(HOOK_NAME)) {
    timer.end({ status: 'skip', note: 'disabled' });
    process.exit(0);
  }

  function cleanGitEnvironment() {
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) {
      const normalized = key.toUpperCase();
      if (normalized === 'GIT_CONFIG_COUNT' || normalized.startsWith('GIT_')) delete environment[key];
    }
    return environment;
  }

  // First failure class seen by git(), so "capture ran and produced nulls" can
  // be told apart from "capture never ran" once it reaches the recovery block.
  let gitFailure = null;

  function classifyGitFailure(error) {
    if (error?.code === 'ENOENT') return 'git-not-found';
    if (error?.killed || error?.code === 'ETIMEDOUT') return 'git-timeout';
    // Git uses 128 for every fatal, not just a missing repository: dubious
    // ownership on a shared or cross-UID checkout lands here too. Name what is
    // observable - git ran and refused - instead of guessing which fatal it was.
    if (error?.status === 128) return 'git-rejected';
    return 'git-failed';
  }

  function git(args, cwd) {
    try {
      return execFileSync('git', args, {
        cwd,
        env: cleanGitEnvironment(),
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim() || null;
    } catch (error) {
      if (!gitFailure) gitFailure = classifyGitFailure(error);
      return null;
    }
  }

  function readBoundedStdin(maxBytes = 256 * 1024) {
    const chunks = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(8192, maxBytes + 1 - total));
      const count = fs.readSync(0, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) return null;
      chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks, total).toString('utf8').trim();
  }

  const stdin = readBoundedStdin();
  if (stdin === null) {
    timer.end({ status: 'skip', note: 'stdin-oversize' });
    process.exit(0);
  }

  let data;
  try {
    data = stdin ? JSON.parse(stdin) : {};
  } catch {
    // Distinguishable from a genuine crash: the payload arrived but was not
    // JSON. The parser's message quotes the offending source text, and this
    // entry is read back by `ak doctor`, the desktop System view, and the
    // dashboard handler, so the note alone identifies the path.
    timer.end({ status: 'warn', note: 'json-parse-failed' });
    process.exit(0);
  }

  const piRuntime = data.runtime === 'pi';
  const cwd = (piRuntime ? data.cwd : process.env.CK_PROJECT_ROOT || data.cwd) || process.cwd();
  // Logged, so it has to be one of ours: bounding an untrusted string is not
  // the same as closing it, and this field reaches the same diagnostics
  // surfaces as the note. The raw value still reaches session state below,
  // where nothing renders it.
  const trigger = typeof data.trigger !== 'string'
    ? ''
    : Object.prototype.hasOwnProperty.call(TRIGGERS, data.trigger)
      ? TRIGGERS[data.trigger]
      : 'other';
  const { context, reason } = describeSessionStateContext({
    sessionId: data.session_id,
    cwd,
    ...(piRuntime
      ? { runtime: 'pi', bindSession: true }
      : { requireBinding: true })
  });
  if (!context) {
    timer.end({ status: 'warn', note: reason || 'context-null', target: trigger });
    process.exit(0);
  }

  const worktree = git(['rev-parse', '--show-toplevel'], cwd);
  // For a linked worktree, --git-common-dir points at the main repo's .git;
  // its parent is the primary working tree (the "root project" directory).
  const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  const mainRoot = commonDir ? commonDir.replace(/[\\/]\.git\/?$/, '') : null;
  const dirty = git(['status', '--porcelain'], cwd);
  const branch = git(['branch', '--show-current'], cwd);
  const head = git(['rev-parse', '--short', 'HEAD'], cwd);

  const compactRecovery = {
    capturedAt: new Date().toISOString(),
    trigger: data.trigger || null,
    worktree,
    mainRoot: mainRoot && mainRoot !== worktree ? mainRoot : null,
    branch,
    head,
    dirtyCount: dirty ? dirty.split('\n').filter(Boolean).length : 0,
    // Non-null only when the capture ran but derived nothing, so the recovery
    // block can name the cause instead of silently printing generic prose.
    anchorsUnavailable: worktree || branch || head ? null : gitFailure || 'no-anchors'
  };

  const persisted = updateSessionState(context, (state) => ({
    ...state,
    compactRecovery: {
      ...compactRecovery,
      // Carry the active plan the checkpoint pipeline already tracks, if any.
      activePlan: typeof state?.activePlan === 'string' ? state.activePlan : null
    }
  }));

  if (!persisted) {
    timer.end({ status: 'warn', note: 'state-write-failed', target: trigger });
    process.exit(0);
  }

  timer.end({
    status: 'ok',
    note: compactRecovery.anchorsUnavailable ? 'anchors-unavailable' : 'captured',
    target: trigger
  });
  process.exit(0);
} catch (error) {
  try {
    const { logHookCrash } = require('./lib/hook-logger.cjs');
    logHookCrash(HOOK_NAME, error, { event: 'PreCompact' });
  } catch { /* logger unavailable: still never block compaction */ }
  process.exit(0);
}
