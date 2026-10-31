/**
 * Writes `.dev.vars.e2e-founder`, the local identity file the founder browser
 * suite needs.
 *
 * The founder area answers only `founder_admin`. The main dev server runs the
 * default dev identity (an operator) so a developer cannot accidentally
 * exercise administrative writes on the normal port. The suite therefore needs
 * a second server whose `DEV_IDENTITY_SUBJECT` is the demo administrator, and
 * that server reads its variables from `.dev.vars.e2e-founder`.
 *
 * The file is generated from `.env.example` — the template in the repository —
 * with a development subject added, so it holds no secret and no real value.
 * It is gitignored like every `.dev.vars*` file, and it is *not* created for
 * any environment other than local: `APP_ENV=local` is what enables the dev
 * identity adapter at all.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const TEMPLATE = resolve(ROOT, '.env.example');
const TARGET = resolve(ROOT, '.dev.vars.e2e-founder');

const template = readFileSync(TEMPLATE, 'utf8');
const lines = template
  .split('\n')
  .filter((line) => !/^\s*DEV_IDENTITY_SUBJECT\s*=/.test(line));
const body = `${lines.join('\n').trimEnd()}\n\n# Chỉ cho bộ kiểm thử trình duyệt của phân hệ Sáng lập (cổng 5174).\nDEV_IDENTITY_SUBJECT=demo-admin\n`;

writeFileSync(TARGET, body, 'utf8');
console.log(
  `${existsSync(TARGET) ? 'Wrote' : 'Wrote'} ${TARGET} from .env.example (APP_ENV=local, dev identity demo-admin).`,
);
