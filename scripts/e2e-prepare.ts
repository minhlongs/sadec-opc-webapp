/**
 * Puts the local demo database into the known state the browser suite expects.
 *
 * Why this exists: the E2E specs book real units from real lots. Stock is
 * decremented in D1 by every run, so after a few runs "the first lot with enough
 * left" stops existing and a test fails for a reason that has nothing to do with
 * the code. The suite needs a known start, which is what CI gets for free from a
 * fresh sandbox.
 *
 * **The suite owns its state directory.** It works in `.wrangler/e2e-state`,
 * the same directory `playwright.config.ts` gives both suite servers, so the
 * database it resets on every run is not the one `pnpm dev` uses. An earlier
 * version reset the developer's own demo database, which meant running the
 * browser tests could delete work someone had been doing by hand.
 *
 * What it does, in order:
 *
 *   1. refuses if either suite port is in use, before anything is deleted;
 *   2. writes `.dev.vars` from `.env.example` when it is missing (template, no
 *      secret) and regenerates `.dev.vars.e2e-founder` via
 *      `scripts/e2e-founder-env.ts`;
 *   3. deletes the **demo** database file inside `.wrangler/e2e-state` only —
 *      identified by holding `ws-demo-a`, not by deleting the directory —
 *      together with its `-wal`/`-shm` companions;
 *   4. applies migrations and the demo seed to that directory, which is exactly
 *      what a new developer runs by hand, with `SADEC_D1_PERSIST` pointing at it.
 *
 * What it deliberately does not touch: `.wrangler/state` in any form, and the
 * `test`, `test_restore` and `pilot` databases.
 *
 * `SADEC_E2E_KEEP_DB=1` skips step 3 for someone who wants to keep the suite's
 * current database and accepts that stock-dependent specs may then fail.
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(import.meta.dirname, '..');

/**
 * The suite's own persistence directory, kept in step with `playwright.config.ts`.
 *
 * `SADEC_D1_PERSIST` is exported to the migrate and seed commands this script
 * runs, and to the dev servers Playwright starts, so one value decides where the
 * suite's data lives.
 */
const E2E_PERSIST_DIR = '.wrangler/e2e-state';
const D1_DIR = resolve(ROOT, E2E_PERSIST_DIR, 'v3', 'd1', 'miniflare-D1DatabaseObject');

/** The ports the browser suite owns, from `playwright.config.ts`. */
const SUITE_PORTS = [5173, 5174] as const;

/**
 * Whether something is already listening on a port.
 *
 * This runs **before** the database is deleted, because the order matters to a
 * person: discovering that a `pnpm dev` server holds the suite's port is a mild
 * annoyance, and discovering it after the local demo database was reset is a
 * lost afternoon. `playwright.config.ts` sets `reuseExistingServer: false`, so
 * Playwright would refuse the run anyway; this makes the refusal arrive before
 * anything is destroyed, and says what to do.
 */
function portIsBusy(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (busy: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      done(busy);
    };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function assertSuitePortsFree(): Promise<void> {
  const busy: number[] = [];
  for (const port of SUITE_PORTS) {
    if (await portIsBusy(port)) busy.push(port);
  }
  if (busy.length === 0) return;
  throw new Error(
    `Cổng ${busy.join(', ')} đang có tiến trình lắng nghe. Bộ kiểm thử trình duyệt sở hữu các cổng này ` +
      'và sẽ không dùng lại một máy chủ có sẵn (nó có thể chạy mã của bản sửa đổi cũ). ' +
      'Hãy dừng máy chủ đang chạy (ví dụ `pnpm dev`) rồi chạy lại `pnpm test:e2e`. ' +
      'Cơ sở dữ liệu demo chưa bị xoá.',
  );
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    // Every database command in this script targets the suite's directory.
    env: { ...process.env, SADEC_D1_PERSIST: E2E_PERSIST_DIR },
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`);
  }
}

/** True iff this SQLite file is the demo database (it holds the demo workspace). */
function isDemoDatabase(file: string): boolean {
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const row = db.prepare(`SELECT id FROM workspaces WHERE id = 'ws-demo-a'`).get();
      return row !== undefined;
    } finally {
      db.close();
    }
  } catch {
    // Not a database, or no schema yet: not ours to delete.
    return false;
  }
}

function resetDemoDatabase(): void {
  if (!existsSync(D1_DIR)) {
    console.log(`No ${E2E_PERSIST_DIR} D1 directory yet; migrations will create it.`);
    return;
  }
  const files = readdirSync(D1_DIR).filter((name) => name.endsWith('.sqlite'));
  const demos = files.filter((name) => isDemoDatabase(join(D1_DIR, name)));
  for (const name of demos) {
    for (const suffix of ['', '-wal', '-shm']) {
      const path = join(D1_DIR, `${name}${suffix}`);
      if (existsSync(path)) {
        console.log(`Deleting ${path} (${statSync(path).size} bytes)`);
        rmSync(path);
      }
    }
  }
  if (demos.length === 0) console.log('Demo database not found; migrations will create it.');
  console.log(`Reset scope: ${E2E_PERSIST_DIR} only. .wrangler/state was not touched.`);
}

function ensureDevVars(): void {
  const target = resolve(ROOT, '.dev.vars');
  if (existsSync(target)) return;
  // The template, not a secret: APP_ENV=local and every value empty.
  writeFileSync(target, readFileSync(resolve(ROOT, '.env.example'), 'utf8'), 'utf8');
  console.log('Wrote .dev.vars from .env.example');
}

async function main(): Promise<void> {
  // Before anything is deleted: is the database file ours to reset right now?
  await assertSuitePortsFree();

  ensureDevVars();
  run(process.execPath, ['scripts/e2e-founder-env.ts']);

  if (process.env.SADEC_E2E_KEEP_DB === '1') {
    console.log('SADEC_E2E_KEEP_DB=1 — keeping the current demo database.');
    return;
  }

  resetDemoDatabase();
  run('pnpm', ['db:migrate:local', '--', '--env', 'demo']);
  run('pnpm', ['db:seed:demo', '--', '--env', 'demo']);
  console.log('Demo database reset to the seed state for the browser suite.');
}

// A refusal is a message for a person, not a stack trace: a busy port is a
// normal thing to run into, and the fix is to stop the other server.
main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
