'use strict';

/**
 * policy.cjs - Turn blast-radius signals into a firewall verdict.
 *
 * The ladder is allow -> warn -> narrow -> block. Each rung is chosen from the
 * signals alone, so the same call always produces the same verdict.
 *
 * On narrowing: a rewrite is only offered when the narrowed call returns the
 * same results as the original. None of the operations this firewall inspects
 * has such a rewrite — bounding a read, a search, or a log dump necessarily
 * drops results the caller asked for — so `SAFE_REWRITES` is empty and every
 * risky call takes the explain/warn/block path instead. The table is the seam
 * where a provably equivalent rewrite would be added; it is deliberately not a
 * place for "probably fine" narrowing, because silently returning fewer results
 * than the agent asked for is a correctness bug, not a context saving.
 */

/**
 * Enumerated semantics-preserving rewrites, keyed by signal id.
 *
 * Each entry must be a function returning a `tool_input` that provably yields
 * the same results as the original call. Empty by design — see the module note.
 *
 * @type {Record<string, (facts: object, thresholds: object) => object>}
 */
const SAFE_REWRITES = Object.freeze({});

function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown size';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * The concrete, bounded alternative offered for each signal. Every block must
 * name one; a block with no better strategy is just an obstacle.
 */
function strategyFor(signal, facts) {
  switch (signal.id) {
    case 'read.unbounded':
      return {
        reason: `Reading all of ${facts.filePath} (${humanBytes(signal.bytes)}) would flood context.`,
        strategy:
          'Search the file for the part you need, then read that window: ' +
          'Grep with output_mode "content" and -n to get line numbers, then Read with offset and limit.'
      };
    case 'search.unbounded-content':
      return {
        reason: signal.broad
          ? `Pattern "${facts.pattern}" is broad and returns file content with no result bound.`
          : `This search returns file content with no result bound.`,
        strategy:
          'Bound the result set with head_limit, or scope the search with path/glob. ' +
          'Use output_mode "files_with_matches" first to find where to look, then read those files.'
      };
    case 'shell.file-dump':
      return {
        reason: `\`${signal.verb} ${signal.target}\` prints the whole file (${humanBytes(signal.bytes)}).`,
        strategy:
          `Extract only what you need: \`grep -n <pattern> ${signal.target}\`, ` +
          `\`tail -n 200 ${signal.target}\`, or \`sed -n '<start>,<end>p' ${signal.target}\`.`
      };
    case 'shell.log-stream':
      return {
        reason: `\`${signal.verb}\` streams the full log with no bound.`,
        strategy: `Bound it with \`${signal.boundFlag}\`, or filter with grep before reading.`
      };
    case 'shell.recursive-search':
      return {
        reason: `\`${signal.verb}\` searches recursively with no narrowing flag.`,
        strategy:
          'Narrow it with --include/--exclude-dir, cap hits with -m, or use -l to list files first ' +
          'and read only the ones that matter.'
      };
    case 'shell.verbose-history':
      return {
        reason: `\`${signal.verb}\` prints the full history or diff with no bound.`,
        strategy: `Bound it with -n, --oneline, --stat, or a path argument.`
      };
    case 'shell.recursive-walk':
      return {
        reason: `\`${signal.verb}\` walks the entire tree below its starting point.`,
        strategy:
          signal.verb === 'find'
            ? 'Add -maxdepth, scope the starting path, or pipe through head.'
            : 'Add -L to bound depth, or scope the starting path.'
      };
    default:
      return { reason: 'This call has a large blast radius.', strategy: 'Narrow it before retrying.' };
  }
}

/**
 * Pick the signal that drives the verdict: the most severe one, and among
 * equals the first computed, so ordering is stable.
 */
function dominantSignal(signals) {
  return signals.reduce((worst, candidate) => {
    if (!worst) return candidate;
    if (worst.severity === 'block') return worst;
    return candidate.severity === 'block' ? candidate : worst;
  }, null);
}

/**
 * Decide the firewall verdict for a set of signals.
 *
 * @param {object} args
 * @param {object[]} args.signals
 * @param {object} args.facts
 * @param {object} args.thresholds
 * @param {number} [args.repeatCount] how many times this exact operation has
 *   already been intervened on in this session
 * @returns {{action: 'allow'|'warn'|'narrow'|'block', reason?: string, strategy?: string, signalId?: string, updatedInput?: object}}
 */
function decide({ signals, facts, thresholds, repeatCount = 0 }) {
  if (!Array.isArray(signals) || signals.length === 0) return { action: 'allow' };

  const signal = dominantSignal(signals);
  if (!signal) return { action: 'allow' };

  const { reason, strategy } = strategyFor(signal, facts || {});

  const rewrite = SAFE_REWRITES[signal.id];
  if (rewrite) {
    const updatedInput = rewrite(facts || {}, thresholds);
    if (updatedInput) {
      return { action: 'narrow', reason, strategy, signalId: signal.id, updatedInput };
    }
  }

  // A warning the agent has already ignored this many times stops being a
  // warning: repeating the same flood is exactly what the firewall exists for.
  const escalated =
    signal.severity === 'block' || repeatCount + 1 >= thresholds.repeatBlockCount;

  return {
    action: escalated ? 'block' : 'warn',
    reason: escalated && signal.severity !== 'block'
      ? `${reason} This is attempt ${repeatCount + 1} of the same unbounded operation.`
      : reason,
    strategy,
    signalId: signal.id
  };
}

module.exports = { decide, strategyFor, dominantSignal, humanBytes, SAFE_REWRITES };
