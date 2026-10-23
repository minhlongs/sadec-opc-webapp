#!/usr/bin/env node
/**
 * secrets-inject.cjs - Replace ${secret:NAME} with a stored value, in memory.
 *
 * A model can write ${secret:STRIPE_KEY} into a tool call without ever seeing
 * the credential. This PreToolUse hook is what makes that work: it reads the
 * payload, asks the `ak` binary for each referenced value, substitutes in
 * memory, and hands the rewritten input back for the tool to run.
 *
 * What that buys, exactly: the model composed the call from the reference, so
 * the value is absent from the turn the model wrote, and this hook adds no
 * copy of its own — it writes nothing to disk, to a log, or to any channel
 * that reaches the model. It does not follow that the value stops here. The
 * rewritten input is what the harness runs, so the value reaches the tool's
 * process and its arguments, and from there whatever the harness does with an
 * executed call: its transcript, its display, and the `tool_input` it hands to
 * every PostToolUse hook. That is the harness's behavior, not this hook's, and
 * it differs per runtime and per version; treat a released value as present on
 * the host, and rotate it rather than assuming it was never written down.
 *
 * Three rules keep that narrow:
 *
 * - Only the fields in SUBSTITUTABLE_FIELDS are scanned. A blanket walk of the
 *   payload would substitute into file contents and prompts, which is how a
 *   credential ends up committed to a repository.
 * - The caller is never asked who it is. `ak secrets resolve` identifies the
 *   agent by walking the parent-process chain and hashing its binary, so this
 *   hook cannot assert a fingerprint, and a grant is what decides.
 * - Every failure blocks the tool call. Passing the literal reference through
 *   would send ${secret:NAME} to a remote API as if it were a credential, and
 *   the resulting failure would say nothing about why.
 */

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const { resolveAkBinary } = require('./lib/ak-prefs-client.cjs');

/**
 * The fields a reference may appear in, per tool. Anything not listed here is
 * left byte-for-byte alone, including the fields of tools that are not listed
 * at all.
 *
 * Bash.command and WebFetch.url are the two places a credential is actually
 * needed at call time. Both put the value on a command line or in a URL, which
 * the operator opted into by writing the reference; the hook's job is to keep
 * that to the fields they named, not to widen it.
 */
const SUBSTITUTABLE_FIELDS = Object.freeze({
  Bash: Object.freeze(['command']),
  WebFetch: Object.freeze(['url'])
});

/**
 * Fields that name a single network destination, so the hook can tell
 * `ak secrets resolve` where a released value is about to go. Bash.command
 * is not here even though it also reaches the network sometimes: a shell
 * command line has no one field that is "the destination", so there is
 * nothing safe to extract from it.
 */
const DESTINATION_FIELDS = Object.freeze({ WebFetch: Object.freeze(['url']) });

/**
 * Fields whose substituted text is handed to a shell. A value landing here is
 * not data, it is part of a command line, and the hook has no way to know the
 * quoting context the operator wrote around the reference.
 */
const SHELL_FIELDS = Object.freeze({ Bash: Object.freeze(['command']) });

/**
 * Characters that can end an argument and start something else, widen it into
 * several arguments, or get expanded by the shell, in at least one shell
 * quoting context (POSIX shells and cmd.exe both). A stored value is not
 * always the operator's own: a dotenv file pulled in by `ak secrets
 * import-env` can come from a repository, and a value carrying one of these
 * would turn a reference the model wrote into a command the operator never
 * did.
 *
 * Quoting the value instead would be worse than refusing it. The reference is
 * usually written inside quotes the operator chose -- `"Bearer ${secret:TOKEN}"`
 * -- so wrapping it again would put literal quote marks in the header and send a
 * credential that silently does not work.
 *
 * The invariant this pattern enforces: a value that passes it must reach the
 * shell as exactly one argument with no further expansion, on every quoting
 * context this hook can land in unquoted, single-quoted, or double-quoted.
 * That rules out five categories, not just the original punctuation set:
 * whitespace (`\s`, so a value cannot split into extra arguments or flags),
 * quote/escape/separator/redirection/substitution punctuation
 * (`` ` $ " ' \ ; & | < > ( ) ``), glob and brace expansion characters
 * (`* ? [ ] { }`), the remaining shell-special punctuation
 * (`~` home-directory expansion, `#` comment start, `!` history expansion,
 * `%` cmd.exe variable expansion, `^` the cmd.exe escape), and any other ASCII control character
 * (`\x00`-`\x1f`, `\x7f`), not just the newline and carriage return the
 * original set already refused.
 */
const SHELL_UNSAFE_PATTERN = /[\s`$"'\\;&|<>()*?[\]{}~#!%^\x00-\x1f\x7f]/;

/** Matches one complete reference. An unterminated one is left as written. */
const REF_PATTERN = /\$\{secret:([^{}\s]+)\}/g;

/**
 * A resolvable secret name. The name reaches `ak` as a positional argument, so
 * one that starts with a dash would be read as a flag and let a payload steer
 * the command line; a name with a slash or a space is not a valid ref anyway.
 */
const REF_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * How long to wait for one resolve. The ledger this call writes to waits up to
 * two seconds for its write lease, so a shorter timeout here would kill
 * resolves that were about to succeed.
 */
const RESOLVE_TIMEOUT_MS = 5000;

/** The envelope version this hook understands. */
const SUPPORTED_SCHEMA_VERSION = 1;

/**
 * List the secret names text references, each once, in first-seen order.
 * @param {string} text
 * @returns {string[]}
 */
function extractRefs(text) {
  if (typeof text !== 'string' || !text.includes('${secret:')) return [];
  const names = [];
  for (const match of text.matchAll(REF_PATTERN)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/**
 * The substitutable fields of one tool, or an empty list for a tool that has
 * none.
 * @param {string} toolName
 * @returns {string[]}
 */
function fieldsFor(toolName) {
  const fields = Object.prototype.hasOwnProperty.call(SUBSTITUTABLE_FIELDS, toolName)
    ? SUBSTITUTABLE_FIELDS[toolName]
    : null;
  return fields ? [...fields] : [];
}

/**
 * Whether a name may be passed to `ak secrets resolve` as a positional.
 * @param {string} name
 * @returns {boolean}
 */
function isResolvableRef(name) {
  return typeof name === 'string' && REF_NAME_PATTERN.test(name);
}

/**
 * Whether a substituted value would reach a shell as part of a command line.
 * @param {string} toolName
 * @param {string} field
 * @returns {boolean}
 */
function isShellField(toolName, field) {
  const fields = Object.prototype.hasOwnProperty.call(SHELL_FIELDS, toolName)
    ? SHELL_FIELDS[toolName]
    : null;
  return Boolean(fields && fields.includes(field));
}

/**
 * The destination host (and port, if the URL carries one) a field's raw,
 * pre-substitution value would send a released value to, or null when the
 * field names no single destination or the value cannot be parsed as a URL.
 *
 * This reads rawValue before any reference in it is substituted, which is
 * what keeps the host itself from ever depending on a resolved secret: the
 * one thing this hook sends to `ak secrets resolve` ahead of the value it is
 * asking for is computed without that value.
 *
 * @param {string} toolName
 * @param {string} field
 * @param {unknown} rawValue
 * @returns {string|null}
 */
function destinationHost(toolName, field, rawValue) {
  const fields = Object.prototype.hasOwnProperty.call(DESTINATION_FIELDS, toolName)
    ? DESTINATION_FIELDS[toolName]
    : null;
  if (!fields || !fields.includes(field) || typeof rawValue !== 'string') return null;
  try {
    const host = new URL(rawValue).host;
    return host || null;
  } catch {
    return null;
  }
}

/**
 * Whether value can be substituted into a shell command line without changing
 * its structure.
 * @param {string} value
 * @returns {boolean}
 */
function isShellSafeValue(value) {
  return typeof value === 'string' && !SHELL_UNSAFE_PATTERN.test(value);
}

/**
 * A neutral stand-in for every reference when probing whether a destination
 * field's raw value could let a resolved secret land inside the URL's
 * authority. It carries no URL syntax of its own (no `:`, `@`, `/`, `.`, or
 * percent-escapes), so if it turns up inside `hostname`, `port`, `username`,
 * or `password` after being substituted in place of every reference, a real
 * secret value sitting there could do the same -- steer the parsed
 * destination somewhere `--allow-host` was never asked to check, or leak the
 * value itself to a DNS resolver as part of a hostname label.
 */
const AUTHORITY_PROBE_PLACEHOLDER = 'agentkitsecretprobe';

/**
 * rawValue with every reference replaced by AUTHORITY_PROBE_PLACEHOLDER.
 * @param {string} rawValue
 * @returns {string}
 */
function withRefsReplacedByProbe(rawValue) {
  return rawValue.replace(REF_PATTERN, AUTHORITY_PROBE_PLACEHOLDER);
}

/**
 * Whether a destination field's raw, pre-substitution value names a
 * destination verifiable enough to check against a grant's `--allow-host`
 * list at all. A field with no reference in it is always verifiable here --
 * there is nothing this hook is about to release into it.
 *
 * Two things make it unverifiable:
 *
 * - The raw value (reference left as literal text) does not parse as a URL,
 *   or parses to no host. There is then no destination host to send `ak
 *   secrets resolve` at all, and a grant restricted with `--allow-host` must
 *   refuse a call it cannot check rather than release into one.
 * - Once every reference is replaced with a neutral placeholder, the
 *   placeholder turns up inside the parsed authority -- `hostname`, `port`,
 *   `username`, or `password`. A real resolved value sitting in that same
 *   spot could change what host the URL parses to, or become part of the
 *   hostname text itself and reach a DNS resolver -- either way, something
 *   `--allow-host` was never asked to check.
 *
 * @param {string} toolName
 * @param {string} field
 * @param {unknown} rawValue
 * @returns {boolean}
 */
function destinationIsVerifiable(toolName, field, rawValue) {
  const fields = Object.prototype.hasOwnProperty.call(DESTINATION_FIELDS, toolName)
    ? DESTINATION_FIELDS[toolName]
    : null;
  if (!fields || !fields.includes(field) || typeof rawValue !== 'string') return true;
  if (extractRefs(rawValue).length === 0) return true;

  let parsed;
  try {
    parsed = new URL(rawValue);
  } catch {
    return false;
  }
  if (!parsed.host) return false;

  let probed;
  try {
    probed = new URL(withRefsReplacedByProbe(rawValue));
  } catch {
    return false;
  }
  return (
    !probed.hostname.includes(AUTHORITY_PROBE_PLACEHOLDER) &&
    !probed.port.includes(AUTHORITY_PROBE_PLACEHOLDER) &&
    !probed.username.includes(AUTHORITY_PROBE_PLACEHOLDER) &&
    !probed.password.includes(AUTHORITY_PROBE_PLACEHOLDER)
  );
}

/**
 * Whether field's destination host, re-derived from its already-substituted
 * value, still matches beforeHost -- the host `ak secrets resolve` was told
 * to check the grant against. destinationIsVerifiable already refuses a
 * reference landing in the authority before any resolve runs; this is the
 * check that runs after, on the actual bytes about to reach the tool, so a
 * substitution path neither check anticipated cannot quietly release a value
 * whose destination was never the one the grant checked.
 *
 * @param {string} toolName
 * @param {string} field
 * @param {string|null} beforeHost
 * @param {Object} input
 * @returns {boolean}
 */
function destinationHostUnchanged(toolName, field, beforeHost, input) {
  return destinationHost(toolName, field, input[field]) === beforeHost;
}

/**
 * Substitute every reference in the named fields of toolInput.
 *
 * resolve is called at most once per distinct name, and its throw propagates:
 * a partially substituted input is worse than a blocked call, because half the
 * references would reach the remote end as literal text.
 *
 * @param {Object} toolInput
 * @param {string[]} fields
 * @param {(ref: string, field: string) => string} resolve
 * @returns {{input: Object, changed: boolean}}
 */
function substituteInput(toolInput, fields, resolve) {
  const input = { ...toolInput };
  const cache = new Map();
  let changed = false;

  for (const field of fields) {
    const value = input[field];
    const refs = extractRefs(value);
    if (refs.length === 0) continue;
    let substituted = value;
    for (const ref of refs) {
      if (!cache.has(ref)) cache.set(ref, resolve(ref, field));
      substituted = substituted.split('${secret:' + ref + '}').join(cache.get(ref));
    }
    input[field] = substituted;
    changed = true;
  }

  return { input, changed };
}

/**
 * Turn a failed resolve into a reason an operator can act on. The exit codes
 * are `ak secrets resolve`'s own; none of them carries a value, and neither
 * does anything built here.
 *
 * This text is read by the model, which has a shell. So it never carries a
 * line that would settle its own request: no `ak secrets grant`, and no
 * `ak secrets approve --state ...`. Bare `ak secrets approve` is named on
 * purpose — it decides nothing by itself, it opens a review a person answers
 * at a terminal, and `approve` refuses outright when an adapter sits above it
 * in the process tree. Naming it is how the human ever hears about the
 * request; naming the form that settles it would be handing over the answer.
 *
 * @param {string} ref
 * @param {number|null} status
 * @returns {string}
 */
function refusalReason(ref, status) {
  switch (status) {
    case 6:
      return `"${ref}" is refused for this agent: an operator blocked this scope, this process ` +
        "could not be identified as a trusted adapter, or the call's destination is not on the " +
        "grant's allowed hosts. All three are settled answers — a block is deliberate, an " +
        'unidentified caller has no scope to cover, and an allowed-hosts list is exact on purpose ' +
        '— so retrying will not change them. Report it and continue without the reference.';
    case 8:
      return `"${ref}" needs approval that nobody has given yet. The request is filed and waiting; ` +
        'a person has to answer it from their own terminal with `ak secrets approve` (or the ' +
        'AgentKit Desktop app). Approving it from inside this agent session is not supported — do ' +
        'not attempt it. Ask for it, and retry once they say they have approved it.';
    case 9:
      return `too many approval requests for "${ref}" have come from this agent, so the rest are ` +
        'refused until a cool-down passes. Do not retry: retrying is the thing the limit exists to ' +
        'stop, and each attempt is recorded. Say that the reference is unavailable and continue ' +
        'without it.';
    case 3:
      return `no secret named "${ref}" is stored. Run \`ak secrets set ${ref}\`, or remove the reference.`;
    case 2:
      return `the request for "${ref}" was malformed; the reference cannot be resolved.`;
    case 7:
      return `"${ref}" is in an encrypted-file vault that needs its passphrase typed on a terminal, ` +
        'and a hook has none, nor any way to inherit one unlocked elsewhere: the passphrase lives only ' +
        'in the memory of the process that asked for it. Set `secrets.backend` to the keychain on hosts ' +
        'where agents resolve secrets unattended, or run the command that needs this secret directly ' +
        'in a terminal instead of through a hook.';
    default:
      return `"${ref}" could not be resolved (ak exited ${status === null ? 'abnormally' : status}). ` +
        'Run `ak data status` to check the audit ledger.';
  }
}

/** Block the tool call, explaining why without naming any value. */
function block(reason) {
  process.stderr.write(`SECRETS BLOCK: ${reason}\n`);
  process.exit(2);
}

/**
 * The options execFileSync runs a resolve with, shared between the initial
 * attempt and the no-`--dest-host` retry below.
 * @param {string} cwd
 * @returns {Object}
 */
function resolveExecOptions(cwd) {
  return {
    encoding: 'utf8',
    timeout: RESOLVE_TIMEOUT_MS,
    cwd,
    // AGENTKIT_HOME and friends decide which vault, grant file, and ledger
    // the binary reads; stripping them would send it at another host's
    // state, including a test's.
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  };
}

/**
 * args with its trailing `--dest-host <value>` pair removed, or args itself
 * (the same reference) when it does not carry one.
 * @param {string[]} args
 * @returns {string[]}
 */
function withoutDestHostFlag(args) {
  const idx = args.indexOf('--dest-host');
  if (idx === -1) return args;
  return [...args.slice(0, idx), ...args.slice(idx + 2)];
}

/**
 * Whether a failed resolve failed because the `ak` binary predates the
 * --dest-host flag, rather than for any reason a retry would not fix.
 * Cobra's own wording for an unrecognized flag is stable across every
 * subcommand it generates, so matching it does not depend on this
 * particular command's help text.
 * @param {unknown} e
 * @returns {boolean}
 */
function isUnknownDestHostFlagError(e) {
  const stderr = e && typeof e.stderr === 'string' ? e.stderr : '';
  return /unknown flag:\s*--dest-host\b/.test(stderr);
}

/**
 * Build the resolver the substitution runs through: one `ak secrets resolve`
 * per distinct reference, in the session's own directory so the project half
 * of the grant scope is the one the operator granted against.
 *
 * @param {string} binary
 * @param {Object} payload
 * @param {Map<string, string|null>} verifiedHosts the destination host each
 *   destination field named before substitution, present only for a field
 *   whose destination destinationIsVerifiable accepted
 * @returns {(ref: string, field: string) => string}
 */
function makeResolver(binary, payload, verifiedHosts) {
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();

  return (ref, field) => {
    if (!isResolvableRef(ref)) {
      block(`"${ref}" is not a usable secret name; names are letters, digits, "_", "-", and ".".`);
    }

    const args = ['secrets', 'resolve', ref, '--json', '--context', `tool:${payload.tool_name}:${field}`];
    if (sessionId) args.push('--session', sessionId);
    // A field whose destination could not be verified before substitution
    // (destinationIsVerifiable said no, so it is absent from verifiedHosts)
    // sends no --dest-host at all -- the same as a field with no single
    // destination to name in the first place, like Bash.command.
    // `ak secrets resolve` is what turns that into a decision: it refuses an
    // empty destination outright for a grant --allow-host restricts, and
    // places no restriction at all for one that does not, which is what
    // keeps an unrestricted grant's call working exactly as it did before
    // --allow-host existed.
    const host = verifiedHosts.has(field) ? verifiedHosts.get(field) : null;
    if (host) args.push('--dest-host', host);

    let stdout;
    try {
      stdout = execFileSync(binary, args, resolveExecOptions(cwd));
    } catch (e) {
      if (args.includes('--dest-host') && isUnknownDestHostFlagError(e)) {
        // A newer kit hook can run against an older `ak` build that has no
        // --dest-host flag yet. Retrying once without it is safe rather than
        // a silent widening of any restricted grant: an old build cannot
        // load a v3 grants file at all (loadGrants refuses a schema newer
        // than it understands), so it can never hold a
        // --allow-host-restricted row for --dest-host to have enforced in
        // the first place -- dropping the flag here only affects a build
        // that could not have honored it anyway.
        try {
          stdout = execFileSync(binary, withoutDestHostFlag(args), resolveExecOptions(cwd));
        } catch (e2) {
          block(refusalReason(ref, e2 && typeof e2.status === 'number' ? e2.status : null));
        }
      } else {
        block(refusalReason(ref, e && typeof e.status === 'number' ? e.status : null));
      }
    }

    let envelope;
    try {
      envelope = JSON.parse(stdout);
    } catch (e) {
      block(`the answer for "${ref}" was unreadable; the reference cannot be resolved.`);
    }
    if (!envelope || envelope.schema_version !== SUPPORTED_SCHEMA_VERSION || typeof envelope.data?.value !== 'string') {
      block(`the answer for "${ref}" is in an unsupported format; update the ak CLI.`);
    }
    // The character is deliberately not named: it is one byte of a credential.
    if (isShellField(payload.tool_name, field) && !isShellSafeValue(envelope.data.value)) {
      block(`the stored value of "${ref}" contains a character that would change the structure of the ` +
        'shell command it was about to be placed in (whitespace; a quote, backslash, or redirection/' +
        'separator character; a glob or brace character; `~`, `#`, `!`, `%`, or `^`; or a control character). ' +
        'Pass it to the command through an environment variable instead, or store a value without it.');
    }
    return envelope.data.value;
  };
}

function main() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch (e) {
    // A payload this hook cannot read is not a payload it can find a
    // reference in either. Blocking here would stop every tool call on a
    // harness whose envelope changed shape.
    process.exit(0);
  }

  if (!payload || payload.hook_event_name !== 'PreToolUse') process.exit(0);

  const fields = fieldsFor(payload.tool_name);
  if (fields.length === 0) process.exit(0);

  const toolInput = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  if (!fields.some((field) => extractRefs(toolInput[field]).length > 0)) process.exit(0);

  const destFields = Object.prototype.hasOwnProperty.call(DESTINATION_FIELDS, payload.tool_name)
    ? DESTINATION_FIELDS[payload.tool_name]
    : [];
  // The destination host each destination field named before substitution,
  // present only for a field whose raw value destinationIsVerifiable could
  // check. A field absent here still gets resolved -- it is not blocked
  // pre-emptively -- but makeResolver sends no --dest-host for it, so `ak
  // secrets resolve` is what decides: it refuses an empty destination
  // outright for a grant --allow-host restricts (an unverifiable destination
  // cannot be waved through just because it could not be checked), and
  // places no restriction at all for a grant that carries none, which is
  // what keeps an unrestricted grant's call working exactly as it did before
  // --allow-host existed, including one with a reference in the URL's
  // userinfo, host, or port.
  const verifiedHosts = new Map();
  for (const field of destFields) {
    const rawValue = toolInput[field];
    if (destinationIsVerifiable(payload.tool_name, field, rawValue)) {
      verifiedHosts.set(field, destinationHost(payload.tool_name, field, rawValue));
    }
  }

  const binary = resolveAkBinary();
  if (!binary) {
    block('this tool call references a stored secret, but the ak CLI is not installed on this host.');
  }

  const { input, changed } = substituteInput(toolInput, fields, makeResolver(binary, payload, verifiedHosts));
  if (!changed) process.exit(0);

  // Only a field whose destination was known before substitution is
  // re-checked after: an unverifiable field never had a beforeHost to compare
  // against, and whatever restriction applies to it was already enforced by
  // the resolve call itself, above.
  for (const [field, beforeHost] of verifiedHosts) {
    if (!destinationHostUnchanged(payload.tool_name, field, beforeHost, input)) {
      block("this call's destination changed once its references were resolved, so it no longer " +
        'matches the destination the grant checked. Report it and continue without the reference.');
    }
  }

  // The rewritten input only takes effect with an explicit decision: a harness
  // ignores updatedInput when the decision is left out. "ask" keeps the
  // operator in the loop for every call that carries a released value, since
  // "allow" would also skip the permission prompt the call would otherwise
  // get. An operator who wants unattended runs opts in from their own
  // environment, never from a file a cloned repository could ship. Codex
  // rejects "allow" unless updatedInput comes with it, which it always does.
  const decision = process.env.AGENTKIT_SECRETS_INJECT_AUTO_ALLOW === '1' ? 'allow' : 'ask';
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      updatedInput: input
    }
  }) + '\n');
  process.exit(0);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    // Fail closed: this hook only ever runs when a reference is present, and
    // a crash that let the literal through would send "${secret:NAME}" to a
    // remote API as if it were a credential.
    block(`the secret injector failed (${error && error.message ? error.message : 'unknown error'}).`);
  }
}

module.exports = {
  SUBSTITUTABLE_FIELDS,
  SHELL_FIELDS,
  DESTINATION_FIELDS,
  RESOLVE_TIMEOUT_MS,
  extractRefs,
  fieldsFor,
  isResolvableRef,
  isShellField,
  isShellSafeValue,
  destinationHost,
  destinationIsVerifiable,
  destinationHostUnchanged,
  refusalReason,
  substituteInput
};
