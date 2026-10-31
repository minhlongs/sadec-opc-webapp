import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every command a script tells an operator to run must be a script that exists.
 *
 * A refusal message is the only help an operator gets at the exact moment they
 * are stuck, so naming a command that cannot resolve costs more than a wrong
 * assertion in a test: the pilot migration's confirmation guard once printed
 * `pnpm db:migrate:pilot`, while the package script was `db:migrate-pilot`. pnpm
 * reads a second colon as a scope separator, so the message handed back a command
 * that fails again and left an unconfirmed remote migration with no way forward.
 *
 * The guard's own key list already pins the names the scripts *use*; this test
 * covers the other half — the names they *publish*. Nothing read that prose, which
 * is why the defect above passed every gate.
 *
 * The scan reads the sources rather than a list, so a command added later is
 * covered without this file being updated to remember it.
 */
const SOURCE_DIRECTORIES = ['src', 'scripts'] as const;

/**
 * A pnpm script name as it appears in prose: `pnpm db:migrate-pilot -- --env pilot`.
 *
 * Hyphens are part of a name and colons separate a scope, so both are matched —
 * stopping a name at either character is how a reader invents a command that was
 * never written and then reports it missing.
 */
const PNPM_COMMAND = /\bpnpm ([a-z][a-zA-Z0-9-]*(?::[a-z][a-zA-Z0-9-]*)*)/g;

/**
 * pnpm's own subcommands, which are not package scripts.
 *
 * `pnpm exec wrangler ...` is a command an operator runs and a command this code
 * publishes, but `exec` is pnpm's verb rather than a script this package defines.
 * Without this the scan reports it as missing — a false positive that would
 * eventually be silenced by deleting the check. The list is pnpm's, not this
 * repository's, and a package script that shadows one of these names would still
 * be matched first: the filter only applies to names the package does not define.
 */
const PNPM_SUBCOMMANDS = new Set(['exec', 'dlx', 'add', 'install', 'run', 'test', 'publish']);

function scriptNames(): ReadonlySet<string> {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return new Set(Object.keys(pkg.scripts ?? {}));
}

/** Every `.ts` file under `directory`, sorted so a scan reads the tree deterministically. */
function filesUnder(directory: string): string[] {
  const walk = (relative: string): string[] => {
    const absolute = join(process.cwd(), directory, relative);
    const found: string[] = [];
    for (const name of readdirSync(absolute).sort()) {
      const entryRelative = relative === '' ? name : `${relative}/${name}`;
      if (statSync(join(absolute, name)).isDirectory()) found.push(...walk(entryRelative));
      else if (name.endsWith('.ts')) found.push(entryRelative);
    }
    return found;
  };
  return walk('');
}

/** Every `pnpm <script>` name written in a source file, with where it was found. */
function commandsPublishedInCode(): { command: string; file: string }[] {
  const published: { command: string; file: string }[] = [];
  for (const directory of SOURCE_DIRECTORIES) {
    for (const relative of filesUnder(directory)) {
      const file = `${directory}/${relative}`;
      const text = readFileSync(join(process.cwd(), file), 'utf8');
      for (const match of text.matchAll(PNPM_COMMAND)) {
        const command = match[1];
        if (command !== undefined) published.push({ command, file });
      }
    }
  }
  return published;
}

describe('commands named in source prose', () => {
  it('are all scripts this package actually defines', () => {
    const scripts = scriptNames();
    const published = commandsPublishedInCode();

    // An empty scan means the reader broke, not that the code is clean. Without
    // this the test would pass having checked nothing.
    expect(published.length).toBeGreaterThan(0);

    const missing = published.filter(
      ({ command }) => !scripts.has(command) && !PNPM_SUBCOMMANDS.has(command),
    );
    expect(missing.map(({ command, file }) => `${command} (in ${file})`)).toEqual([]);
  });

  it('names the pilot migration with one colon, the way pnpm resolves it', () => {
    // The specific defect this test exists for, written plainly so a reader does
    // not have to reconstruct it from the scan above.
    const scripts = scriptNames();
    expect(scripts.has('db:migrate-pilot')).toBe(true);
    for (const { command, file } of commandsPublishedInCode()) {
      expect(command, `${file} names ${command}`).not.toBe('db:migrate:pilot');
    }
  });
});
