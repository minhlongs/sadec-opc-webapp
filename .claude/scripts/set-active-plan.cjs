#!/usr/bin/env node
/**
 * Update session state with new active plan
 *
 * Usage: node .claude/scripts/set-active-plan.cjs <plan-path>
 *
 * The runnable copy lives beside the emitted hook tree (`.claude/scripts/` for a
 * native project install, `~/.claude/scripts/` for a native global install, and
 * `<plugin>/scripts/` under an explicit plugin install) so the require below
 * resolves. The `.agentkit/scripts/` sidecar leaf is a forwarder to it.
 *
 * This script updates the session temp file with the new active plan path,
 * allowing subagents to receive the latest plan context via SubagentStart hook.
 *
 * The runtime-temporary session state is the source of truth for plan context
 * within a session. Environment variables are only the session-start snapshot.
 *
 * This is session-scoped and distinct from `ak plan use`'s worktree-scoped
 * current-plan pointer — see docs/system-architecture.md, decision ledger,
 * "Session-scoped plan activation is retained; it is not the worktree plan
 * pointer", for why both mechanisms exist.
 */

const fs = require('fs');
const path = require('path');
const {
  createSessionStateContext,
  updateSessionState,
  loadConfig,
  getReportsPath
} = require('../hooks/lib/ck-config-utils.cjs');

const sessionContext = createSessionStateContext({
  sessionId: process['env'].CK_SESSION_ID,
  cwd: process['env'].CK_PROJECT_ROOT || process.cwd(),
  requireBinding: true
});
const newPlan = process.argv[2];

if (!newPlan) {
  console.error('Error: Plan path required');
  console.log('Usage: node .claude/scripts/set-active-plan.cjs <plan-path>');
  console.log('Example: node .claude/scripts/set-active-plan.cjs plans/<timestamp>-feature-name');
  process.exit(1);
}

// Resolve relative paths from the immutable session launch directory, not the caller's
// current directory after an in-session `cd`.
const absolutePlan = path.resolve(sessionContext?.sessionLaunchRoot || process.cwd(), newPlan);

if (!sessionContext) {
  console.warn('Warning: CK_SESSION_ID not set - session state will not persist');
  console.log(`Would set active plan to: ${absolutePlan}`);
  process.exit(0);
}

const success = updateSessionState(sessionContext, current => ({
  ...current,
  activePlan: absolutePlan,
  timestamp: Date.now()
}));

if (!success) {
  console.error('Failed to update session state');
  process.exit(1);
}

console.log(`Active plan set to: ${absolutePlan}`);

// Activation is the moment the plan-scoped reports directory starts being
// advertised to every subagent, so create it here. A subagent that trusts the
// injected Reports path otherwise writes into a directory nothing made.
// A failure here does not undo a successful activation.
try {
  const config = loadConfig({ includeProject: false, includeAssertions: false });
  const reportsPath = getReportsPath(absolutePlan, 'session', config.plan, config.paths);
  fs.mkdirSync(reportsPath, { recursive: true });
} catch (e) {
  console.warn(`Warning: could not create the plan reports directory: ${e.message}`);
}
