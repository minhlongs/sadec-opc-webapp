/**
 * detectors.cjs - Anti-pattern detectors over the linter's session aggregates.
 *
 * Every detector is a pure function of stored state and returns either `null`
 * or a finding carrying three things: the evidence it saw, the alternative the
 * agent could have taken, and a pointer to the principle that makes it a
 * problem. The principle text itself lives in `ak:context-engineering` and is
 * referenced, never copied, so there is one place to change it.
 *
 * A detector that cannot prove its claim from stored evidence does not ship.
 * See the plan's non-goals for the one detector deliberately left out.
 *
 * @module agent-behavior-linter/detectors
 */

'use strict';

const SKILL_ROOT = 'ak:context-engineering (kits/engineer/skills/ak-context-engineering)';

const PRINCIPLES = Object.freeze({
  reuseVerifiedFacts: `${SKILL_ROOT} SKILL.md, "Proportional hygiene": reuse verified facts until the source, revision, environment or decision changes`,
  boundedRetry: `${SKILL_ROOT} SKILL.md, "Proportional hygiene": retry a transient failure within a bounded policy; for a deterministic error, change something first`,
  searchBeforeRead: `${SKILL_ROOT} SKILL.md, "Proportional hygiene": search before large reads`,
  boundOutput: `${SKILL_ROOT} SKILL.md, "Proportional hygiene": prefer native output limits or structured filters`,
  focusedChecksFirst: `${SKILL_ROOT} SKILL.md, "Proportional hygiene": run focused checks first; broaden when required by repository gates or risk`
});

const SEVERITY = Object.freeze({ low: 'low', medium: 'medium' });

// Thresholds are deliberately generous. A linter that cries wolf gets disabled,
// and a missed finding costs far less than a false one.
const DEFAULT_THRESHOLDS = Object.freeze({
  unchangedReads: 3,
  retryAttempts: 2,
  broadSearches: 4,
  sharedRootSearches: 2,
  outputBytes: 200 * 1024
});

/**
 * Whether one recorded search swept the tree instead of asking a narrow
 * question. The verdict was computed by `event-schema.classifySearchBreadth`
 * while the pattern was still in hand; only the verdict is stored.
 */
function isBroadSearch(entry) {
  return Boolean(entry && typeof entry === 'object' && entry.broad === true);
}

/**
 * D1 - the same unchanged file read over and over.
 *
 * The read counter resets whenever the file's `mtimeMs`/`size` change or an
 * edit lands on it, and a compaction clears the whole map, so a surviving count
 * means the content genuinely did not move between reads.
 */
function detectRepeatedUnchangedRead(state, thresholds = DEFAULT_THRESHOLDS) {
  const offenders = Object.entries(state.files || {})
    .filter(([, entry]) => entry
      && entry.reads >= thresholds.unchangedReads
      && entry.mutatedAt === null
      // More than one range means different regions were read, which is not a
      // repeat of the same question.
      && Array.isArray(entry.ranges) && entry.ranges.length === 1)
    .sort((left, right) => right[1].reads - left[1].reads)
    .slice(0, 5);

  if (offenders.length === 0) return null;

  return {
    id: 'repeated-unchanged-read',
    severity: SEVERITY.medium,
    evidence: {
      files: offenders.map(([file, entry]) => ({
        path: file,
        reads: entry.reads,
        unchangedSize: entry.lastSize,
        region: entry.ranges[0]
      }))
    },
    alternative: 'The file has not changed since the first read. Reuse that result, or read a different region if you need one.',
    principle: PRINCIPLES.reuseVerifiedFacts
  };
}

/**
 * D2 - the same command failing the same way, twice, with nothing changed.
 *
 * Nondeterministic classes are excluded, as are commands with an edit between
 * attempts, because in both cases the second run really could differ.
 */
function detectDeterministicRetry(state, thresholds = DEFAULT_THRESHOLDS) {
  const offenders = Object.entries(state.commands || {})
    .filter(([, entry]) => entry
      && entry.attempts >= thresholds.retryAttempts
      && entry.nondeterministic !== true
      && entry.mutatedSince !== true)
    .sort((left, right) => right[1].attempts - left[1].attempts)
    .slice(0, 5);

  if (offenders.length === 0) return null;

  return {
    id: 'deterministic-retry',
    severity: SEVERITY.medium,
    evidence: {
      commands: offenders.map(([hash, entry]) => ({
        commandHash: hash,
        commandClass: entry.class,
        attempts: entry.attempts,
        sameErrorSignature: entry.errorSigHash
      }))
    },
    alternative: 'Nothing changed between attempts and the failure signature is identical, so the rerun could not have succeeded. Read the error, change an input, then rerun.',
    principle: PRINCIPLES.boundedRetry
  };
}

/**
 * D3 - repeated tree-wide searching instead of narrowing.
 *
 * Breadth is classified by `scout-block/broad-pattern-detector.cjs` so this
 * agrees with what `scout-block` already blocks elsewhere.
 */
function detectBroadSearchWithoutNarrowing(state, thresholds = DEFAULT_THRESHOLDS) {
  const searches = state.searches || [];
  const broad = searches.filter(entry => isBroadSearch(entry));
  if (broad.length < thresholds.broadSearches) return null;
  // "Without narrowing" is meant literally. A repository-root search is the
  // ordinary way to start, and `isHighLevelPath` calls every one of them broad,
  // so counting them alone would fire on a healthy session. One search scoped
  // to a subdirectory is proof the agent did narrow, and ends the finding.
  if (searches.some(entry => entry && entry.broad === false)) return null;

  const rootCounts = broad.reduce((counts, entry) => {
    const root = entry.root || '.';
    counts[root] = (counts[root] || 0) + 1;
    return counts;
  }, {});
  const repeatedRoot = Object.entries(rootCounts)
    .find(([, count]) => count >= thresholds.sharedRootSearches);
  if (!repeatedRoot) return null;

  return {
    id: 'broad-search-without-narrowing',
    severity: SEVERITY.low,
    evidence: {
      broadSearches: broad.length,
      repeatedRoot: repeatedRoot[0],
      repeatedRootSearches: repeatedRoot[1]
    },
    alternative: `Narrow the search: name a directory under "${repeatedRoot[0]}" or add a file-type filter instead of sweeping the same root again.`,
    principle: PRINCIPLES.searchBeforeRead
  };
}

/**
 * D4 - a large amount of tool output that produced no change.
 *
 * A write anywhere counts as yield, including a plan or report, so a genuine
 * read-only investigation that writes up its result does not fire.
 */
function detectLowYieldToolOutput(state, thresholds = DEFAULT_THRESHOLDS) {
  // A missing count must read as zero rather than as `undefined`. The store
  // has no lock, so a torn write can leave `counters` present and carrying the
  // current schema version while a key inside it is gone, which `isUsableState`
  // does not catch. Left raw, `undefined <= budget` is false and `undefined > 0`
  // is false, so a lost counter would *fire* this finding and then print its
  // evidence as "NaN KB". Undercounting into silence is the failure this
  // detector is allowed; accusing a session on absent evidence is not.
  const count = value => Number(value) || 0;
  const counters = state.counters || {};
  const outputBytes = count(counters.outputBytes);
  const mutations = count(counters.mutations);
  if (outputBytes <= thresholds.outputBytes || mutations > 0) return null;

  return {
    id: 'low-yield-tool-output',
    severity: SEVERITY.low,
    evidence: {
      outputKilobytes: Math.round(outputBytes / 1024),
      budgetKilobytes: Math.round(thresholds.outputBytes / 1024),
      reads: count(counters.reads),
      searches: count(counters.searches),
      commands: count(counters.commands),
      filesMutated: 0
    },
    alternative: 'This much output changed nothing. Use the tool\'s own limit or a structured filter, and read only the region you need.',
    principle: PRINCIPLES.boundOutput
  };
}

/**
 * D5 - a repository-wide suite run for a documentation-only change.
 *
 * Deliberately not generalized to "small code change": for code the repository's
 * own rules require broadening when shared contracts move, so there is no honest
 * signal there.
 */
function detectOversizedVerificationForDocsOnlyChange(state) {
  const fullSuite = state.fullSuiteCommand;
  if (!fullSuite) return null;

  const mutated = Object.entries(state.files || {}).filter(([, entry]) => entry && entry.mutatedAt !== null);
  if (mutated.length === 0) return null;
  if (!mutated.every(([, entry]) => entry.documentation === true)) return null;

  return {
    id: 'oversized-verification-for-docs-only-change',
    severity: SEVERITY.low,
    evidence: {
      mutatedPaths: mutated.map(([file]) => file).slice(0, 10),
      verificationClass: fullSuite.class
    },
    alternative: 'Only documentation changed. Run the documentation or link checks first and broaden only if a repository gate demands it.',
    principle: PRINCIPLES.focusedChecksFirst
  };
}

const DETECTORS = Object.freeze([
  detectRepeatedUnchangedRead,
  detectDeterministicRetry,
  detectBroadSearchWithoutNarrowing,
  detectLowYieldToolOutput,
  detectOversizedVerificationForDocsOnlyChange
]);

/**
 * Run every detector. A detector that throws is skipped rather than allowed to
 * take the hook down with it.
 *
 * @returns {Array<object>} Findings, most severe first.
 */
function runDetectors(state, thresholds = DEFAULT_THRESHOLDS) {
  if (!state || typeof state !== 'object') return [];
  const findings = [];
  for (const detector of DETECTORS) {
    try {
      const finding = detector(state, thresholds);
      if (finding) findings.push(finding);
    } catch {
      // A broken detector must not cost the session its summary.
    }
  }
  const order = { [SEVERITY.medium]: 0, [SEVERITY.low]: 1 };
  return findings.sort((left, right) => (order[left.severity] ?? 9) - (order[right.severity] ?? 9));
}

module.exports = {
  DEFAULT_THRESHOLDS,
  DETECTORS,
  PRINCIPLES,
  SEVERITY,
  detectBroadSearchWithoutNarrowing,
  detectDeterministicRetry,
  detectLowYieldToolOutput,
  detectOversizedVerificationForDocsOnlyChange,
  detectRepeatedUnchangedRead,
  isBroadSearch,
  runDetectors
};
