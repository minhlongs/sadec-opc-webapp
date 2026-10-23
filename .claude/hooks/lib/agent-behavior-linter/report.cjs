/**
 * report.cjs - Renders the linter's end-of-session summary.
 *
 * The summary is advisory text. It carries counters, then one block per
 * finding: what was observed, what to do instead, and where the principle is
 * written down. It never carries file content, command text, or output.
 *
 * @module agent-behavior-linter/report
 */

'use strict';

const HEADING = 'Agent behavior linter';

function formatKilobytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  return `${Math.round(bytes / 1024)} KB`;
}

function formatCounters(counters = {}) {
  const parts = [
    `${counters.reads || 0} reads`,
    `${counters.searches || 0} searches`,
    `${counters.commands || 0} commands`,
    `${counters.mutations || 0} edits`,
    `${formatKilobytes(counters.outputBytes)} of tool output`
  ];
  if (counters.compactions) parts.push(`${counters.compactions} compactions`);
  return parts.join(', ');
}

function formatEvidence(finding) {
  const evidence = finding.evidence || {};

  if (Array.isArray(evidence.files)) {
    return evidence.files
      .map(file => `${file.path} read ${file.reads}x unchanged (${file.unchangedSize} bytes, region ${file.region})`)
      .join('; ');
  }
  if (Array.isArray(evidence.commands)) {
    return evidence.commands
      .map(command => `${command.commandClass} failed ${command.attempts}x with an identical error`)
      .join('; ');
  }
  if (Number.isFinite(evidence.broadSearches)) {
    return `${evidence.broadSearches} tree-wide searches, ${evidence.repeatedRootSearches} of them rooted at "${evidence.repeatedRoot}"`;
  }
  if (Number.isFinite(evidence.outputKilobytes)) {
    return `${evidence.outputKilobytes} KB of output over ${evidence.reads} reads, ${evidence.searches} searches and ${evidence.commands} commands, with no file changed`;
  }
  if (Array.isArray(evidence.mutatedPaths)) {
    return `${evidence.verificationClass} ran a full suite while only ${evidence.mutatedPaths.join(', ')} changed`;
  }
  return '';
}

/**
 * Render the session summary, or an empty string when there is nothing worth
 * saying. Callers print the empty string nowhere.
 *
 * @param {object} state - Session state.
 * @param {Array<object>} findings - Findings from `runDetectors`.
 * @returns {string}
 */
function renderSummary(state, findings) {
  if (!state || typeof state !== 'object') return '';
  const list = Array.isArray(findings) ? findings : [];
  if (list.length === 0) return '';

  const lines = [
    `${HEADING}: ${list.length} observation${list.length === 1 ? '' : 's'} this session.`,
    `Session totals: ${formatCounters(state.counters)}.`,
    ''
  ];

  for (const finding of list) {
    lines.push(`- ${finding.id} (${finding.severity})`);
    const evidence = formatEvidence(finding);
    if (evidence) lines.push(`  Observed: ${evidence}`);
    lines.push(`  Instead: ${finding.alternative}`);
    lines.push(`  Principle: ${finding.principle}`);
    lines.push('');
  }

  lines.push('Observation only: nothing was blocked. Disable with `hooks.agent-behavior-linter: false`.');
  return lines.join('\n');
}

module.exports = { HEADING, formatCounters, formatEvidence, renderSummary };
