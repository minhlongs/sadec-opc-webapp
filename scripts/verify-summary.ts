/**
 * Reading a vitest summary back out of its terminal output.
 *
 * `scripts/verify.ts` treats "the test gate exited 0" as insufficient and reads
 * the counts vitest printed. That reading has to survive the output exactly as
 * a terminal produces it: when stdout is a TTY, or when `FORCE_COLOR` is set,
 * vitest wraps the numbers in ANSI colour codes, and a regex written against
 * the plain text (`Tests  220 passed (220)`) no longer matches. The gate then
 * reported `null`, which it correctly treats as a failure — a false failure on
 * a green suite. Stripping the escapes before matching makes the reading
 * independent of where the command ran.
 *
 * Kept free of side effects so a unit test can import it; `verify.ts` runs the
 * gates and is not importable without running them.
 */

/** Matches CSI escape sequences (colours, cursor moves) and nothing else. */
// eslint-disable-next-line no-control-regex
const ANSI_CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Removes terminal colour and cursor escapes from a captured output. */
export function stripAnsi(output: string): string {
  return output.replace(ANSI_CSI, '');
}

/** Turns "1,234" into 1234; anything else into null. */
function readCount(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const digits = raw.replace(/,/g, '');
  if (!/^\d+$/.test(digits)) return null;
  return Number(digits);
}

/**
 * Reads the number of tests a vitest run actually executed.
 *
 * Accepts the plain form `Tests  35 passed (35)` and the coloured form, where
 * escapes sit between the label, the count and the parenthesised total. When
 * the total in parentheses is present it wins, because it counts every test
 * vitest ran rather than only the passing ones.
 */
export function parseTestCount(output: string): number | null {
  const plain = stripAnsi(output);
  const summary = plain.match(/Tests\s+([\d,]+)\s+passed(?:[^\n(]*?\(([\d,]+)\))?/);
  if (!summary) return null;
  return readCount(summary[2]) ?? readCount(summary[1]);
}

/**
 * Reads the number of files a vitest run actually collected.
 */
export function parseFileCount(output: string): number | null {
  const plain = stripAnsi(output);
  const summary = plain.match(/Test Files\s+([\d,]+)\s+passed/);
  return summary ? readCount(summary[1]) : null;
}
