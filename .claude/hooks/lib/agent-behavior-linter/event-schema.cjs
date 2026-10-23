/**
 * event-schema.cjs - Redacted event contract for the agent behavior linter.
 *
 * PRIVACY INVARIANT, enforced by `__tests__/agent-behavior-linter-schema.test.cjs`:
 * a record produced here never carries file content, tool output text, prompt
 * text, or an absolute path outside the project root. Callers persist these
 * records, so anything this module keeps is something the store keeps.
 *
 * Concretely:
 *   - a path inside `cwd` is stored relative to `cwd`; a path outside it is
 *     stored as a truncated digest plus its extension;
 *   - a command is stored as a digest plus its executable class and an argument
 *     shape count, never as text;
 *   - output is stored as a byte length; a failure is stored as a digest of its
 *     first normalized stderr line.
 *
 * @module agent-behavior-linter/event-schema
 */

'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

// `scout-block` owns this project's vocabulary for "too broad", and this module
// borrows it rather than inventing a second one. The require is deliberately
// unguarded and at module scope: a swallowed resolution failure would make
// every search classify as narrow, which reads as a clean session instead of a
// broken classifier. `lib/scout-checker.cjs` reaches the same file by the same
// relative shape, so both resolve wherever the composed kit is installed.
const broadPatternDetector = require('../../scout-block/broad-pattern-detector.cjs');

const SCHEMA_VERSION = 1;
const DIGEST_CHARS = 16;
const MAX_CLASS_CHARS = 32;
const MAX_EXTENSION_CHARS = 12;

// Commands whose failure can legitimately differ between two identical runs, so
// a repeat is not evidence of a deterministic retry.
const NONDETERMINISTIC_COMMAND_CLASSES = new Set([
  'curl', 'wget', 'gh', 'git', 'ssh', 'scp', 'rsync', 'docker', 'podman',
  'kubectl', 'helm', 'terraform', 'npm', 'pnpm', 'yarn', 'bun', 'pip', 'uv',
  'cargo', 'go', 'brew', 'apt', 'apt-get', 'nc', 'ping', 'dig', 'aws', 'gcloud'
]);

// The mixed classes above are only nondeterministic for the subcommands that
// reach the network; `go test` or `npm run build` are as reproducible as any
// local command. Keeping this per class avoids conflating `gh run` (network)
// with `npm run` (local).
const NETWORK_SUBCOMMANDS_BY_CLASS = Object.freeze({
  git: new Set(['fetch', 'pull', 'push', 'clone', 'remote', 'submodule', 'ls-remote']),
  gh: null, // every `gh` subcommand is an API call
  go: new Set(['mod', 'get', 'download', 'install']),
  cargo: new Set(['fetch', 'publish', 'install', 'update', 'add']),
  npm: new Set(['install', 'i', 'ci', 'publish', 'audit', 'outdated', 'update', 'add', 'login']),
  pnpm: new Set(['install', 'i', 'add', 'update', 'publish', 'audit', 'outdated', 'fetch']),
  yarn: new Set(['install', 'add', 'upgrade', 'publish', 'audit']),
  bun: new Set(['install', 'add', 'update', 'publish']),
  pip: new Set(['install', 'download', 'uninstall']),
  uv: new Set(['pip', 'sync', 'add', 'lock']),
  docker: new Set(['pull', 'push', 'build', 'login']),
  podman: new Set(['pull', 'push', 'build', 'login']),
  brew: null,
  apt: null,
  'apt-get': null,
  aws: null,
  gcloud: null,
  kubectl: null,
  helm: null,
  terraform: null
});

const SEARCH_COMMAND_CLASSES = new Set(['grep', 'rg', 'ripgrep', 'find', 'fd', 'fdfind', 'ag', 'ack']);

const SEARCH_TOOL_NAMES = new Set(['Grep', 'Glob']);
const READ_TOOL_NAMES = new Set(['Read', 'NotebookRead']);
const MUTATION_TOOL_NAMES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// Verification that sweeps the whole repository rather than the changed scope.
const FULL_SUITE_PATTERNS = [
  /\bgo\s+test\s+\.\/\.\.\./,
  /\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test\s*$/,
  /\bturbo\s+run\s+test\s*$/,
  /\bvitest\s+run\s*$/,
  /\bPREFLIGHT_DEPTH=ci\b/,
  /\bpreflight\.sh\s*$/
];

// Paths whose mutation is documentation or planning output rather than code.
const DOCUMENTATION_PATH_PATTERN = /^(?:docs|plans)\//;
const DOCUMENTATION_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst']);

function digest(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, DIGEST_CHARS);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Strip environment assignments and one level of command wrappers, matching the
 * semantics already used by `lib/scout-checker.cjs` so both surfaces agree on
 * what "the same command" means.
 */
function stripCommandPrefix(command) {
  if (!isNonEmptyString(command)) return '';
  let stripped = command.trim();
  stripped = stripped.replace(/^(\w+=\S+\s+)+/, '');
  stripped = stripped.replace(/^(sudo|env|nice|nohup|time|timeout)\s+/, '');
  stripped = stripped.replace(/^(\w+=\S+\s+)+/, '');
  return stripped.trim();
}

/**
 * Reduce a path to something safe to persist.
 *
 * @returns {{path: string, inside: boolean}|null}
 */
function relativizeProjectPath(target, cwd) {
  if (!isNonEmptyString(target)) return null;
  if (!isNonEmptyString(cwd)) return null;

  let absolute;
  try {
    absolute = path.isAbsolute(target) ? path.normalize(target) : path.resolve(cwd, target);
  } catch {
    return null;
  }

  const root = path.normalize(cwd);
  const relative = path.relative(root, absolute);
  // `path.relative` returns '' for the project root itself, which is inside.
  const inside = !relative.startsWith('..') && !path.isAbsolute(relative);

  if (inside) {
    return { path: relative === '' ? '.' : relative.split(path.sep).join('/'), inside: true };
  }

  const extension = path.extname(absolute).slice(0, MAX_EXTENSION_CHARS);
  return { path: `external:${digest(absolute)}${extension}`, inside: false };
}

/**
 * Reduce a shell command to a digest plus a coarse shape. No command text
 * survives this function.
 *
 * @returns {{hash: string, class: string, argShape: {flags: number, positionals: number}}|null}
 */
function commandFingerprint(command) {
  const stripped = stripCommandPrefix(command);
  if (stripped === '') return null;

  const tokens = stripped.split(/\s+/).filter(Boolean);
  const executable = path.basename(tokens[0] || '').replace(/\.(?:exe|cmd|sh)$/i, '');
  let flags = 0;
  let positionals = 0;
  for (const token of tokens.slice(1)) {
    if (token.startsWith('-')) flags += 1;
    else positionals += 1;
  }

  return {
    hash: digest(stripped),
    class: executable.slice(0, MAX_CLASS_CHARS),
    argShape: { flags, positionals }
  };
}

/**
 * Collapse a failure message to a digest of its first meaningful line, with
 * volatile numbers normalized so the same deterministic failure hashes
 * identically across attempts.
 */
function errorSignature(text) {
  if (!isNonEmptyString(text)) return null;
  const firstLine = text.split(/\r?\n/).map(line => line.trim()).find(line => line !== '');
  if (!firstLine) return null;
  const normalized = firstLine
    .replace(/0x[0-9a-f]+/gi, '0xN')
    .replace(/\b\d+(?:\.\d+)?(?:ms|s|m)?\b/g, 'N')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  return digest(normalized);
}

/**
 * Whether a failed command could plausibly succeed on an identical rerun.
 */
function isNondeterministicCommand(fingerprint, command) {
  if (!fingerprint) return true;
  if (!NONDETERMINISTIC_COMMAND_CLASSES.has(fingerprint.class)) return false;

  // For the mixed classes, only the network subcommands are nondeterministic.
  const networkSubcommands = NETWORK_SUBCOMMANDS_BY_CLASS[fingerprint.class];
  if (networkSubcommands === null || networkSubcommands === undefined) {
    // The whole class reaches the network, or it is listed without a breakdown.
    return true;
  }
  const tokens = stripCommandPrefix(command).split(/\s+/).filter(Boolean);
  const subcommand = (tokens[1] || '').toLowerCase();
  if (subcommand === '' || subcommand.startsWith('-')) {
    // A bare `npm`/`git` invocation carries no subcommand to judge; stay safe.
    return true;
  }
  return networkSubcommands.has(subcommand);
}

function isFullSuiteCommand(command) {
  const stripped = stripCommandPrefix(command);
  if (stripped === '') return false;
  return FULL_SUITE_PATTERNS.some(pattern => pattern.test(stripped));
}

function isDocumentationPath(relativePath) {
  if (!isNonEmptyString(relativePath)) return false;
  if (relativePath.startsWith('external:')) return false;
  if (DOCUMENTATION_PATH_PATTERN.test(relativePath)) return true;
  return DOCUMENTATION_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

/**
 * Extract the search pattern and root from a shell search command, shaped for
 * `scout-block/broad-pattern-detector.cjs` so both surfaces classify breadth
 * with one vocabulary.
 *
 * @returns {{pattern: string, path: string}|null}
 */
function searchInputFromCommand(command) {
  const stripped = stripCommandPrefix(command);
  if (stripped === '') return null;
  const tokens = stripped.split(/\s+/).filter(Boolean);
  const executable = path.basename(tokens[0] || '');
  if (!SEARCH_COMMAND_CLASSES.has(executable)) return null;

  const operands = [];
  let explicitRecursive = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.startsWith('-')) {
      if (/^-(?:r|R|-recursive|-dereference-recursive)$/.test(token)) explicitRecursive = true;
      // Combined short flags such as `-rn` still request recursion.
      else if (/^-[a-zA-Z]+$/.test(token) && /[rR]/.test(token.slice(1))) explicitRecursive = true;
      // `-e pattern`, `--include=x`, `-name x`: skip a detached value too.
      if (/^-(?:e|-regexp|-include|-exclude|-glob|-type|-name|-path)$/.test(token)) index += 1;
      continue;
    }
    operands.push(token.replace(/^['"]|['"]$/g, ''));
  }
  if (operands.length === 0) return null;

  // `find <root> -name <pattern>` puts the root first; the greps put it last.
  const isFind = executable === 'find' || executable === 'fd' || executable === 'fdfind';
  const pattern = isFind ? operands[operands.length - 1] : operands[0];
  const searchPath = isFind
    ? operands[0]
    : (operands.length > 1 ? operands[operands.length - 1] : '.');

  if (!isNonEmptyString(pattern)) return null;
  // `grep` walks a tree only when asked; the others do it by default.
  const recursive = executable === 'grep' ? explicitRecursive : true;
  return { searchInput: { pattern, path: searchPath }, recursive };
}

/**
 * Classify one search as tree-wide or narrow, while the raw pattern is still in
 * hand. Only the verdict is stored: a search pattern is agent-authored text and
 * can itself contain a secret, so it must not outlive this function.
 *
 * `scout-block` already owns this project's vocabulary for "too broad", and the
 * two search shapes are judged by the part of it that covers them. A `Glob`
 * pattern carries its own breadth, which is what `detectBroadPatternIssue` was
 * written for. A recursive text search is broad because of where it was rooted,
 * which is what `isHighLevelPath` decides; its pattern says nothing about
 * breadth, so judging it by `detectBroadPatternIssue` would never fire.
 *
 * @returns {boolean}
 */
function classifySearchBreadth({ tool, searchInput, recursive }) {
  if (!searchInput || typeof searchInput !== 'object') return false;
  if (tool === 'Glob') {
    return broadPatternDetector.detectBroadPatternIssue(searchInput).blocked === true;
  }
  if (recursive !== true) return false;
  return broadPatternDetector.isHighLevelPath(searchInput.path) === true;
}

function readRange(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return 'full';
  const offset = Number.isFinite(toolInput.offset) ? toolInput.offset : null;
  const limit = Number.isFinite(toolInput.limit) ? toolInput.limit : null;
  if (offset === null && limit === null) return 'full';
  return `${offset === null ? 0 : offset}:${limit === null ? 0 : limit}`;
}

function responseText(toolResponse) {
  if (typeof toolResponse === 'string') return toolResponse;
  if (!toolResponse || typeof toolResponse !== 'object') return '';
  if (isNonEmptyString(toolResponse.content)) return toolResponse.content;
  if (isNonEmptyString(toolResponse.stdout) || isNonEmptyString(toolResponse.stderr)) {
    return `${toolResponse.stdout || ''}${toolResponse.stderr || ''}`;
  }
  if (isNonEmptyString(toolResponse.output)) return toolResponse.output;
  return '';
}

function responseFailed(toolResponse) {
  if (!toolResponse || typeof toolResponse !== 'object') return false;
  if (toolResponse.is_error === true || toolResponse.isError === true) return true;
  const code = toolResponse.exit_code ?? toolResponse.exitCode ?? toolResponse.code;
  return Number.isFinite(code) && code !== 0;
}

function failureText(toolResponse) {
  if (!toolResponse || typeof toolResponse !== 'object') return '';
  if (isNonEmptyString(toolResponse.stderr)) return toolResponse.stderr;
  return responseText(toolResponse);
}

/**
 * Turn a raw hook payload into a redacted event record.
 *
 * Returns `null` for payloads the linter has nothing to learn from, so callers
 * can skip the store write entirely on the hot path.
 *
 * @param {object} payload - Raw hook payload from stdin.
 * @param {object} [options]
 * @param {(target: string) => ({mtimeMs: number, size: number}|null)} [options.statPath]
 *   Injected stat reader; defaults to a guarded `fs.statSync`.
 * @returns {object|null}
 */
function normalizeEvent(payload, options = {}) {
  if (!payload || typeof payload !== 'object') return null;

  const event = isNonEmptyString(payload.hook_event_name) ? payload.hook_event_name : '';
  const cwd = isNonEmptyString(payload.cwd) ? payload.cwd : process.cwd();

  if (event === 'PreCompact') {
    return { version: SCHEMA_VERSION, kind: 'compaction', at: Date.now() };
  }
  if (event !== 'PostToolUse') return null;

  const toolName = isNonEmptyString(payload.tool_name) ? payload.tool_name : '';
  if (toolName === '') return null;

  const toolInput = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const toolResponse = payload.tool_response;
  const outputBytes = Buffer.byteLength(responseText(toolResponse), 'utf8');
  const at = Date.now();

  if (READ_TOOL_NAMES.has(toolName)) {
    const resolved = relativizeProjectPath(toolInput.file_path || toolInput.path || toolInput.notebook_path, cwd);
    if (!resolved) return null;
    const stat = resolved.inside ? readStat(resolved, cwd, toolInput, options) : null;
    return {
      version: SCHEMA_VERSION,
      kind: 'read',
      at,
      path: resolved.path,
      inside: resolved.inside,
      range: readRange(toolInput),
      mtimeMs: stat ? stat.mtimeMs : null,
      size: stat ? stat.size : null,
      outputBytes
    };
  }

  if (MUTATION_TOOL_NAMES.has(toolName)) {
    const resolved = relativizeProjectPath(toolInput.file_path || toolInput.path || toolInput.notebook_path, cwd);
    if (!resolved) return null;
    return {
      version: SCHEMA_VERSION,
      kind: 'mutation',
      at,
      path: resolved.path,
      inside: resolved.inside,
      documentation: isDocumentationPath(resolved.path),
      outputBytes: 0
    };
  }

  if (SEARCH_TOOL_NAMES.has(toolName)) {
    const searchRoot = relativizeProjectPath(toolInput.path || cwd, cwd);
    // `Grep` walks the tree under its path; `Glob` breadth is judged from the
    // pattern instead.
    const recursive = toolName === 'Grep';
    return {
      version: SCHEMA_VERSION,
      kind: 'search',
      at,
      tool: toolName,
      recursive,
      broad: classifySearchBreadth({
        tool: toolName,
        recursive,
        searchInput: {
          pattern: isNonEmptyString(toolInput.pattern) ? toolInput.pattern : '',
          path: isNonEmptyString(toolInput.path) ? toolInput.path : '.'
        }
      }),
      root: searchRoot ? searchRoot.path : '.',
      outputBytes
    };
  }

  if (toolName !== 'Bash') {
    return { version: SCHEMA_VERSION, kind: 'other', at, outputBytes };
  }

  const command = isNonEmptyString(toolInput.command) ? toolInput.command : '';
  const fingerprint = commandFingerprint(command);
  if (!fingerprint) return { version: SCHEMA_VERSION, kind: 'other', at, outputBytes };

  const failed = responseFailed(toolResponse);
  const search = searchInputFromCommand(command);

  if (search) {
    const searchRoot = relativizeProjectPath(search.searchInput.path, cwd);
    return {
      version: SCHEMA_VERSION,
      kind: 'search',
      at,
      tool: fingerprint.class,
      recursive: search.recursive,
      broad: classifySearchBreadth({ tool: fingerprint.class, ...search }),
      root: searchRoot ? searchRoot.path : '.',
      outputBytes
    };
  }

  return {
    version: SCHEMA_VERSION,
    kind: 'command',
    at,
    commandHash: fingerprint.hash,
    commandClass: fingerprint.class,
    argShape: fingerprint.argShape,
    failed,
    // No exit code is recorded. Only some runtimes put one in `tool_response`
    // (Pi's carries `content`/`details`/`is_error` and nothing else), so a
    // stored code would be a constant on those runtimes and would read as
    // evidence without being any. `is_error` plus the failure signature is what
    // every runtime can actually answer.
    errorSigHash: failed ? errorSignature(failureText(toolResponse)) : null,
    nondeterministic: isNondeterministicCommand(fingerprint, command),
    fullSuite: isFullSuiteCommand(command),
    outputBytes
  };
}

function readStat(resolved, cwd, toolInput, options) {
  const statPath = typeof options.statPath === 'function' ? options.statPath : defaultStatPath;
  const absolute = path.resolve(cwd, resolved.path);
  try {
    const stat = statPath(absolute);
    if (!stat || !Number.isFinite(stat.mtimeMs) || !Number.isFinite(stat.size)) return null;
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

function defaultStatPath(absolute) {
  // Required lazily: the hot path only needs `fs` when a project file was read.
  const fs = require('node:fs');
  try {
    const stat = fs.statSync(absolute);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

module.exports = {
  SCHEMA_VERSION,
  DOCUMENTATION_EXTENSIONS,
  NETWORK_SUBCOMMANDS_BY_CLASS,
  NONDETERMINISTIC_COMMAND_CLASSES,
  SEARCH_COMMAND_CLASSES,
  classifySearchBreadth,
  commandFingerprint,
  digest,
  errorSignature,
  isDocumentationPath,
  isFullSuiteCommand,
  isNondeterministicCommand,
  normalizeEvent,
  readRange,
  relativizeProjectPath,
  searchInputFromCommand,
  stripCommandPrefix
};
