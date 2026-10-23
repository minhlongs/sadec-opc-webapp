#!/usr/bin/env node
/**
 * context-firewall.cjs - PreToolUse gate on tool-call blast radius.
 *
 * `scout-block` answers "is this path in a generated directory?". This hook
 * answers the other half: "how much context can this call return?". It sizes
 * the call from deterministic signals (file bytes, glob breadth, explicit
 * ranges, shell output shape) and responds on a ladder:
 *
 *   allow  -> nothing to say
 *   warn   -> exit 0, non-blocking guidance on stderr and additionalContext
 *   narrow -> exit 0 with a semantics-preserving updatedInput (see policy.cjs)
 *   block  -> exit 2 with a concrete bounded alternative
 *
 * It never duplicates the privacy or scout gates; those run in the same
 * PreToolUse chain and own their own decisions.
 *
 * Exit Codes:
 * - 0: allowed (possibly with a warning or a narrowed input)
 * - 2: blocked
 *
 * Fails open on every unexpected condition.
 */

try {
  const fs = require('fs');

  const { loadConfig, createSessionStateContext } = require('./lib/ck-config-utils.cjs');

  const { computeSignals } = require('./lib/context-firewall/signals.cjs');
  const { decide } = require('./lib/context-firewall/policy.cjs');
  const { resolveThresholds } = require('./lib/context-firewall/thresholds.cjs');
  const journal = require('./lib/context-firewall/journal.cjs');
  const { createHookTimer, logHookCrash } = require('./lib/hook-logger.cjs');

  try {
    const timer = createHookTimer('context-firewall', { event: 'PreToolUse' });
    const hookInput = fs.readFileSync(0, 'utf-8');

    if (!hookInput || hookInput.trim().length === 0) {
      timer.end({ status: 'warn', exit: 0, note: 'empty-input' });
      process.exit(0);
    }

    let data;
    try {
      data = JSON.parse(hookInput);
    } catch (parseError) {
      timer.end({ status: 'warn', exit: 0, note: 'json-parse-failed', error: parseError.message });
      process.exit(0);
    }

    if (!data.tool_input || typeof data.tool_input !== 'object') {
      timer.end({ status: 'warn', exit: 0, note: 'invalid-structure' });
      process.exit(0);
    }

    const toolName = data.tool_name || 'unknown';
    const toolInput = data.tool_input;
    const cwd = typeof data.cwd === 'string' && data.cwd.trim() ? data.cwd : process.cwd();

    // One resolve for both the on/off switch and the thresholds. isHookEnabled()
    // would repeat the same preference lookup under a different cwd, which costs
    // a second `ak` invocation on a path that runs before every Bash and Read.
    let config = {};
    try {
      config = loadConfig({ cwd, includeProject: false, includeAssertions: false, includeLocale: false }) || {};
    } catch { /* defaults are fine */ }

    if (config.hooks && config.hooks['context-firewall'] === false) {
      timer.end({ tool: toolName, status: 'ok', exit: 0, note: 'disabled' });
      process.exit(0);
    }

    const thresholds = resolveThresholds(config.contextFirewall);
    const { kind, signals, facts } = computeSignals({ toolName, toolInput, cwd, thresholds });

    if (signals.length === 0) {
      timer.end({ tool: toolName, status: 'ok', exit: 0 });
      process.exit(0);
    }

    // Session context is best-effort: without it the firewall still warns and
    // blocks, it just cannot count repeats or persist the record.
    let sessionContext = null;
    try {
      sessionContext = createSessionStateContext({ sessionId: data.session_id, cwd });
    } catch { /* unbound session */ }

    const target = facts.filePath || facts.pattern || facts.command || '';
    const id = journal.fingerprint({ kind, signalId: signals[0].id, target });
    const repeats = sessionContext ? journal.repeatCount(sessionContext, id) : 0;

    const verdict = decide({ signals, facts, thresholds, repeatCount: repeats });

    if (verdict.action === 'allow') {
      timer.end({ tool: toolName, status: 'ok', exit: 0 });
      process.exit(0);
    }

    const message = `Context firewall: ${verdict.reason}\n${verdict.strategy}`;

    if (sessionContext) {
      journal.record({
        context: sessionContext,
        id,
        entry: {
          action: verdict.action,
          signalId: verdict.signalId,
          reason: verdict.reason,
          original: target,
          effective: verdict.action === 'narrow' ? JSON.stringify(verdict.updatedInput) : verdict.action
        }
      });
    }

    if (verdict.action === 'block') {
      console.error(message);
      timer.end({ tool: toolName, status: 'block', exit: 2, target, note: verdict.signalId });
      process.exit(2);
    }

    // warn and narrow both let the call proceed; narrow additionally hands the
    // runtime a replacement tool_input.
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: message
      }
    };
    if (verdict.action === 'narrow') {
      output.hookSpecificOutput.updatedInput = verdict.updatedInput;
    }

    console.log(JSON.stringify(output));
    console.error(message);
    timer.end({ tool: toolName, status: verdict.action, exit: 0, target, note: verdict.signalId });
    process.exit(0);

  } catch (error) {
    console.error('WARN: Hook error, allowing operation -', error.message);
    logHookCrash('context-firewall', error, { event: 'PreToolUse' });
    process.exit(0);
  }
} catch (e) {
  try {
    const { logHookCrash } = require('./lib/hook-logger.cjs');
    logHookCrash('context-firewall', e, { event: 'PreToolUse' });
  } catch (_) {}
  process.exit(0); // fail-open
}
