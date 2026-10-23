'use strict';

/**
 * thresholds.cjs - Blast-radius limits for the context firewall.
 *
 * Every limit is a byte or item count so a verdict can be reproduced from the
 * same inputs. Values are deliberately generous: the firewall is meant to catch
 * context floods, not ordinary work.
 */

const DEFAULT_THRESHOLDS = {
  // Unbounded Read of a file this large warns; twice this blocks.
  readWarnBytes: 256 * 1024,
  readBlockBytes: 2 * 1024 * 1024,
  // `cat`-style whole-file dumps in a shell.
  shellDumpWarnBytes: 128 * 1024,
  shellDumpBlockBytes: 512 * 1024,
  // A search in content mode with no head_limit is bounded to this many hits
  // before it counts as unbounded.
  searchHeadLimit: 100,
  // Identical risky operations seen this many times in one session require
  // narrowing instead of another warning.
  repeatBlockCount: 3
};

/**
 * Merge user overrides onto the defaults, ignoring anything that is not a
 * positive finite number so a malformed config cannot disable a limit.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function resolveThresholds(overrides) {
  const resolved = { ...DEFAULT_THRESHOLDS };
  if (!overrides || typeof overrides !== 'object') return resolved;

  for (const key of Object.keys(DEFAULT_THRESHOLDS)) {
    const value = overrides[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      resolved[key] = value;
    }
  }
  return resolved;
}

module.exports = { DEFAULT_THRESHOLDS, resolveThresholds };
