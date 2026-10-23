#!/usr/bin/env node
/**
 * privacy-checker.cjs - Privacy pattern matching logic for sensitive file detection
 *
 * Extracted from privacy-block.cjs for reuse in both Claude hooks and OpenCode plugins.
 * Pure logic module - no stdin/stdout, no exit codes.
 *
 * @module privacy-checker
 */

const path = require('path');
const { resolvePrefs } = require('./ak-prefs-client.cjs');
const { splitCompoundCommand } = require('./scout-checker.cjs');

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const APPROVED_PREFIX = 'APPROVED:';
const DENO_EVAL_OPTIONS_WITH_VALUES = new Set([
  '-c',
  '-L',
  '--cert',
  '--config',
  '--env-file',
  '--ext',
  '--import-map',
  '--location',
  '--log-level',
  '--seed',
  '--v8-flags',
]);

// Safe file patterns - exempt from privacy checks (documentation/template files)
const SAFE_PATTERNS = [
  /\.example$/i,   // .env.example, config.example
  /\.sample$/i,    // .env.sample
  /\.template$/i,  // .env.template
];

// Privacy-sensitive patterns
const PRIVACY_PATTERNS = [
  /^\.env$/,              // .env
  /^\.env\./,             // .env.local, .env.production, etc.
  /\.env$/,               // path/to/.env
  /\/\.env\./,            // path/to/.env.local
  /credentials/i,         // credentials.json, etc.
  /secrets?\.ya?ml$/i,    // secrets.yaml, secret.yml
  /\.pem$/,               // Private keys
  /\.key$/,               // Private keys
  /id_rsa/,               // SSH keys
  /id_ed25519/,           // SSH keys
];

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if path is a safe file (example/sample/template)
 * @param {string} testPath - Path to check
 * @returns {boolean} true if file matches safe patterns
 */
function isSafeFile(testPath) {
  if (!testPath) return false;
  const basename = path.basename(testPath);
  return SAFE_PATTERNS.some(p => p.test(basename));
}

/**
 * Check if path has APPROVED: prefix
 * @param {string} testPath - Path to check
 * @returns {boolean} true if path starts with APPROVED:
 */
function hasApprovalPrefix(testPath) {
  return testPath && testPath.startsWith(APPROVED_PREFIX);
}

/**
 * Strip APPROVED: prefix from path
 * @param {string} testPath - Path to process
 * @returns {string} Path without APPROVED: prefix
 */
function stripApprovalPrefix(testPath) {
  if (hasApprovalPrefix(testPath)) {
    return testPath.slice(APPROVED_PREFIX.length);
  }
  return testPath;
}

/**
 * Check if stripped path is suspicious (path traversal or absolute)
 * @param {string} strippedPath - Path after stripping APPROVED: prefix
 * @returns {boolean} true if path looks suspicious
 */
function isSuspiciousPath(strippedPath) {
  return strippedPath.includes('..') || path.isAbsolute(strippedPath);
}

/**
 * Check if path matches privacy patterns
 * @param {string} testPath - Path to check
 * @returns {boolean} true if path matches privacy-sensitive patterns
 */
function isPrivacySensitive(testPath) {
  if (!testPath) return false;

  // Strip prefix for pattern matching
  const cleanPath = stripApprovalPrefix(testPath);
  let normalized = cleanPath.replace(/\\/g, '/');

  // Decode URI components to catch obfuscated paths (%2e = '.')
  try {
    normalized = decodeURIComponent(normalized);
  } catch (e) {
    // Invalid encoding, use as-is
  }

  // Check safe patterns first - exempt example/sample/template files
  if (isSafeFile(normalized)) {
    return false;
  }

  const basename = path.basename(normalized);

  for (const pattern of PRIVACY_PATTERNS) {
    if (pattern.test(basename) || pattern.test(normalized)) {
      return true;
    }
  }
  return false;
}

/**
 * Lex one shell command segment into quote-aware words with source spans.
 * Operators that attach file operands are delimiters, never part of a path.
 * @param {string} command - One executable command segment
 * @returns {Array<{value: string, start: number, end: number}>}
 */
function lexShellWords(command) {
  const words = [];
  let value = '';
  let start = -1;
  let quote = null;

  const flush = end => {
    if (start >= 0) words.push({ value, start, end });
    value = '';
    start = -1;
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote) {
      if (char === '\\' && quote === '"' && index + 1 < command.length) {
        value += command[++index];
      } else if (char === quote) {
        quote = null;
      } else {
        value += char;
      }
      continue;
    }
    if (/\s/.test(char) || '<>()'.includes(char)) {
      flush(index);
      continue;
    }
    if (char === '"' || char === "'") {
      if (start < 0) start = index;
      quote = char;
      continue;
    }
    if (char === '\\' && index + 1 < command.length) {
      if (start < 0) start = index;
      value += command[++index];
      continue;
    }
    if (start < 0) start = index;
    value += char;
  }
  flush(command.length);
  return words;
}

function findEnvSplitString(words) {
  let executableIndex = 0;
  while (words[executableIndex] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[executableIndex].value)) {
    executableIndex++;
  }
  const executable = path.basename((words[executableIndex]?.value || '').replace(/\\/g, '/'));
  if (executable !== 'env') return null;

  for (let index = executableIndex + 1; index < words.length; index++) {
    const option = words[index].value;
    const inline = option.match(/^(?:-S|--split-string=)(.+)$/);
    if (inline) return { index, value: inline[1] };
    if (/^(?:-S|--split-string)$/.test(option)) {
      return words[index + 1] ? { index: index + 1, value: words[index + 1].value } : null;
    }
    if (/^(?:-u|-C|--unset|--chdir)$/.test(option)) {
      index++;
      continue;
    }
    if (
      option.startsWith('-')
      || /^[A-Za-z_][A-Za-z0-9_]*=/.test(option)
    ) {
      continue;
    }
    break;
  }
  return null;
}

/**
 * Resolve only the exact source argument owned by a node/bun/deno evaluator.
 * @param {Array<{value: string}>} words - Lexed command words
 * @returns {{index: number, value: string}|null}
 */
function findEvaluatorSource(words) {
  const splitString = findEnvSplitString(words);
  if (splitString) return { index: splitString.index, value: '`' };
  let executableIndex = 0;
  while (words[executableIndex] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[executableIndex].value)) {
    executableIndex++;
  }
  if (path.basename((words[executableIndex]?.value || '').replace(/\\/g, '/')) === 'env') {
    executableIndex++;
    while (words[executableIndex]) {
      const option = words[executableIndex].value;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(option) || /^--(?:unset|chdir)=/.test(option)) {
        executableIndex++;
        continue;
      }
      if (/^(?:-u|-C|--unset|--chdir)$/.test(option)) {
        executableIndex += 2;
        continue;
      }
      if (option.startsWith('-')) {
        executableIndex++;
        continue;
      }
      break;
    }
  }

  const executable = path.basename((words[executableIndex]?.value || '').replace(/\\/g, '/'))
    .replace(/\.exe$/i, '');
  if (executable !== 'node' && executable !== 'bun' && executable !== 'deno') return null;
  if (executable === 'deno' && words[executableIndex + 1]?.value === 'eval') {
    let sourceIndex = executableIndex + 2;
    while (words[sourceIndex]?.value.startsWith('-')) {
      const option = words[sourceIndex].value;
      if (option === '--') {
        sourceIndex++;
        break;
      }
      sourceIndex += DENO_EVAL_OPTIONS_WITH_VALUES.has(option) ? 2 : 1;
    }
    return words[sourceIndex] ? { index: sourceIndex, value: words[sourceIndex].value } : null;
  }

  for (let index = executableIndex + 1; index < words.length; index++) {
    const flag = words[index].value;
    const inline = flag.match(/^--(?:eval|print)=(.*)$/);
    if (inline) return { index, value: inline[1] };
    if (/^(?:-[ep]|--(?:eval|print))$/.test(flag) && words[index + 1]) {
      return { index: index + 1, value: words[index + 1].value };
    }
  }
  return null;
}

function isRuntimeEnvironmentReference(value) {
  return /^\$?(?:(?:(?:globalThis|global)\.)?process(?:\.|\?\.)env|(?:Deno|Bun)(?:\.|\?\.)env|import\.meta(?:\.|\?\.)env)(?:(?:\.|\?\.)[A-Za-z_$][\w$]*)*$/.test(value);
}

/**
 * Common evaluator quoting is inspected, but legacy backticks are deliberately
 * opaque: partially parsing them alternates between false blocks and missed
 * nested shell reads.
 */
function extractEvaluatorTokens(source) {
  if (source.includes('`')) return [];
  return (source.match(/[^\s"'`|;&<>(){}\[\],]+/g) || [])
    .filter(value => !isRuntimeEnvironmentReference(value));
}
/**
 * Extract balanced command-substitution bodies while respecting shell quotes.
 * @param {string} command - Whole command string
 * @returns {string[]}
 */
function extractCommandSubstitutions(command) {
  const substitutions = [];
  let quote = null;

  for (let index = 0; index < command.length - 1; index++) {
    const char = command[index];
    if (char === '\\' && quote !== "'" && index + 1 < command.length) {
      index++;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = quote === char ? null : (quote || char);
      continue;
    }
    if (char !== '$' || command[index + 1] !== '(' || quote === "'") continue;

    const start = index + 2;
    let depth = 1;
    let innerQuote = null;
    for (let cursor = start; cursor < command.length; cursor++) {
      const inner = command[cursor];
      if (inner === '\\' && innerQuote !== "'" && cursor + 1 < command.length) {
        cursor++;
        continue;
      }
      if (inner === '"' || inner === "'") {
        innerQuote = innerQuote === inner ? null : (innerQuote || inner);
        continue;
      }
      if (innerQuote) continue;
      if (inner === '(') depth++;
      if (inner === ')' && --depth === 0) {
        substitutions.push(command.slice(start, cursor));
        index = cursor;
        break;
      }
    }
  }
  return substitutions;
}

/**
 * preserves newlines, while a shell treats an unquoted newline as a command
 * boundary. Balanced command substitutions are additional executable contexts.
 * @param {string} command - Whole command string
 * @returns {string[]}
 */
function splitPrivacyCommandSegments(command) {
  let normalized = '';
  let quote = null;

  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (char === '\\' && quote !== "'" && index + 1 < command.length) {
      normalized += char + command[++index];
      continue;
    }
    if (char === '"' || char === "'") {
      quote = quote === char ? null : (quote || char);
      normalized += char;
      continue;
    }
    normalized += char === '\n' && !quote ? ';' : char;
  }

  const segments = splitCompoundCommand(normalized);
  const substitutions = [];
  for (const segment of segments) {
    for (const substitution of extractCommandSubstitutions(segment)) {
      substitutions.push(...splitPrivacyCommandSegments(substitution));
    }
    const splitString = findEnvSplitString(lexShellWords(segment));
    if (splitString) {
      substitutions.push(...splitPrivacyCommandSegments(splitString.value));
    }
  }
  return [...segments, ...substitutions];
}

/**
 * Extract paths from tool input
 * @param {Object} toolInput - Tool input object with file_path, path, pattern, or command
 * @returns {Array<{value: string, field: string}>} Array of extracted paths with field names
 */
function extractPaths(toolInput) {
  const paths = [];
  if (!toolInput) return paths;

  if (toolInput.file_path) paths.push({ value: toolInput.file_path, field: 'file_path' });
  if (toolInput.path) paths.push({ value: toolInput.path, field: 'path' });
  if (toolInput.pattern) paths.push({ value: toolInput.pattern, field: 'pattern' });

  // Check command tokens rather than matching from every ".env" substring to
  // the next whitespace. Keeping each token intact prevents source expressions
  // such as process.env.API_KEY from becoming fabricated ".env.*" file paths,
  // while shell punctuation and quotes no longer contaminate real filenames.
  if (typeof toolInput.command === 'string') {
    for (const segment of splitPrivacyCommandSegments(toolInput.command)) {
      const words = lexShellWords(segment);
      const evaluatorSource = findEvaluatorSource(words);

      for (let index = 0; index < words.length; index++) {
        const rawValues = evaluatorSource?.index === index
          ? extractEvaluatorTokens(evaluatorSource.value)
          : [words[index].value];

        for (const rawValue of rawValues) {
          const assignment = rawValue.match(/^[A-Za-z_][A-Za-z0-9_]*=(.+)$/);
          const value = assignment && !hasApprovalPrefix(rawValue) ? assignment[1] : rawValue;
          if (!value) continue;

          // Command extraction historically covers dotenv paths plus explicitly
          // approved paths. Other sensitive filename classes remain direct-path
          // checks; do not silently broaden the Bash hook's scope here.
          const isDotenvCandidate = value.includes('.env')
            && (isPrivacySensitive(value) || isSafeFile(value));
          if (isDotenvCandidate || hasApprovalPrefix(value)) {
            paths.push({ value, field: 'command' });
          }
        }
      }
    }
  }

  return paths.filter(p => p.value);
}

/**
 * Check whether the user turned the privacy guard off in their AgentKit config.
 *
 * Only an explicit `privacyBlock: false` disables it. Anything else — no
 * setting, an unreadable config, no `ak` on the host — leaves the guard on:
 * this is the check that stands between the model and a `.env`, so the failure
 * direction has to be "keep blocking", never "assume they meant off".
 *
 * @param {object} [options]
 * @param {string} [options.cwd] - Project scope for the resolve.
 * @returns {boolean} true if privacy block should be skipped
 */
function isPrivacyBlockDisabled(options) {
  const prefs = resolvePrefs(options);
  return Boolean(prefs) && prefs.privacyBlock === false;
}

/**
 * Build prompt data for AskUserQuestion tool
 * @param {string} filePath - Blocked file path
 * @returns {Object} Prompt data object
 */
function buildPromptData(filePath) {
  const basename = path.basename(filePath);
  return {
    type: 'PRIVACY_PROMPT',
    file: filePath,
    basename: basename,
    question: {
      header: 'File Access',
      text: `I need to read "${basename}" which may contain sensitive data (API keys, passwords, tokens). Do you approve?`,
      options: [
        { label: 'Yes, approve access', description: `Allow reading ${basename} this time` },
        { label: 'No, skip this file', description: 'Continue without accessing this file' }
      ]
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if a tool call accesses privacy-sensitive files
 *
 * @param {Object} params
 * @param {string} params.toolName - Name of tool (Read, Write, Bash, etc.)
 * @param {Object} params.toolInput - Tool input with file_path, path, command, etc.
 * @param {Object} [params.options]
 * @param {boolean} [params.options.disabled] - Skip checks if true
 * @param {string} [params.options.cwd] - Project scope for the preference resolve
 * @param {boolean} [params.options.allowBash] - Allow Bash tool without blocking (default: true)
 * @returns {{
 *   blocked: boolean,
 *   filePath?: string,
 *   reason?: string,
 *   approved?: boolean,
 *   isBash?: boolean,
 *   suspicious?: boolean,
 *   promptData?: Object
 * }}
 */
function checkPrivacy({ toolName, toolInput, options = {} }) {
  const { disabled, cwd, allowBash = true } = options;

  // Check if disabled via options or config
  if (disabled || isPrivacyBlockDisabled({ cwd })) {
    return { blocked: false };
  }

  const isBashTool = toolName === 'Bash';
  const paths = extractPaths(toolInput);

  // Check each path
  for (const { value: testPath } of paths) {
    if (!isPrivacySensitive(testPath)) continue;

    // Check for approval prefix
    if (hasApprovalPrefix(testPath)) {
      const strippedPath = stripApprovalPrefix(testPath);
      return {
        blocked: false,
        approved: true,
        filePath: strippedPath,
        suspicious: isSuspiciousPath(strippedPath)
      };
    }

    // For Bash: warn but don't block (allows "Yes → bash cat" flow)
    if (isBashTool && allowBash) {
      return {
        blocked: false,
        isBash: true,
        filePath: testPath,
        reason: `Bash command accesses sensitive file: ${testPath}`
      };
    }

    // Block - sensitive file without approval
    return {
      blocked: true,
      filePath: testPath,
      reason: `Sensitive file access requires user approval`,
      promptData: buildPromptData(testPath)
    };
  }

  // No sensitive paths found
  return { blocked: false };
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  // Main entry point
  checkPrivacy,

  // Helper functions (for testing and direct use)
  isSafeFile,
  isPrivacySensitive,
  hasApprovalPrefix,
  stripApprovalPrefix,
  isSuspiciousPath,
  extractPaths,
  isPrivacyBlockDisabled,
  buildPromptData,

  // Constants
  APPROVED_PREFIX,
  SAFE_PATTERNS,
  PRIVACY_PATTERNS
};
