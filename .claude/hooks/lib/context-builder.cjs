#!/usr/bin/env node
/**
 * context-builder.cjs - Context/reminder building for session injection
 *
 * Extracted from dev-rules-reminder.cjs for reuse in both Claude hooks and OpenCode plugins.
 * Builds session context, rules, paths, and plan information.
 *
 * @module context-builder
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");
const { safeDisplayValue } = require("./session-state-renderer.cjs");

const RECENT_INJECTION_TTL_MS = 5 * 60 * 1000;
const PENDING_INJECTION_TTL_MS = 30 * 1000;
const WARN_THRESHOLD = 70;
const CRITICAL_THRESHOLD = 90;
const {
	loadConfig,
	resolvePlanPath,
	getReportsPath,
	resolveNamingPattern,
	normalizePath,
	toDisplayPath,
	getGitBranch,
	readSessionState,
	updateSessionState,
} = require("./ck-config-utils.cjs");

function getUsageCachePath() {
	return process["env"].CK_USAGE_CACHE_PATH || path.join(os.tmpdir(), "ck-usage-limits-cache.json");
}

function execSafe(cmd) {
	try {
		return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
	} catch {
		return null;
	}
}

/**
 * Resolve rules file path (local or global) with backward compat
 * @param {string} filename - Rules filename
 * @param {string} [configDirName='.claude'] - Config directory name
 * @returns {string|null} Resolved path or null
 */
function resolveRulesPath(filename, configDirName = ".claude") {
	// Try rules/ first (new location)
	const localRulesPath = path.join(process.cwd(), configDirName, "rules", filename);
	const globalRulesPath = path.join(os.homedir(), ".claude", "rules", filename);

	if (fs.existsSync(localRulesPath)) return `${configDirName}/rules/${filename}`;
	if (fs.existsSync(globalRulesPath)) return `~/.claude/rules/${filename}`;

	// Backward compat: try workflows/ (legacy location)
	const localWorkflowsPath = path.join(process.cwd(), configDirName, "workflows", filename);
	const globalWorkflowsPath = path.join(os.homedir(), ".claude", "workflows", filename);

	if (fs.existsSync(localWorkflowsPath)) return `${configDirName}/workflows/${filename}`;
	if (fs.existsSync(globalWorkflowsPath)) return `~/.claude/workflows/${filename}`;

	return null;
}

/**
 * Resolve script file path (local or global)
 * @param {string} filename - Script filename
 * @param {string} [configDirName='.claude'] - Config directory name
 * @returns {string|null} Resolved path or null
 */
function resolveScriptPath(filename, configDirName = ".claude") {
	const localPath = path.join(process.cwd(), configDirName, "scripts", filename);
	const globalPath = path.join(os.homedir(), ".claude", "scripts", filename);
	if (fs.existsSync(localPath)) return `${configDirName}/scripts/${filename}`;
	if (fs.existsSync(globalPath)) return `~/.claude/scripts/${filename}`;
	return null;
}

/**
 * Resolve skills venv Python path (local or global)
 * @param {string} [configDirName='.claude'] - Config directory name
 * @returns {string|null} Resolved venv Python path or null
 */
function resolveSkillsVenv(configDirName = ".claude") {
	const isWindows = process.platform === "win32";
	const venvBin = isWindows ? "Scripts" : "bin";
	const pythonExe = isWindows ? "python.exe" : "python3";

	const localVenv = path.join(process.cwd(), configDirName, "skills", ".venv", venvBin, pythonExe);
	const globalVenv = path.join(os.homedir(), ".claude", "skills", ".venv", venvBin, pythonExe);

	// Windows keeps its own layout (Scripts/python.exe) but not its separator:
	// this string is quoted into a command the model runs, and Windows resolves a
	// forward-slash path fine while bash would eat the backslashes.
	if (fs.existsSync(localVenv)) {
		return isWindows ? `${configDirName}/skills/.venv/Scripts/python.exe` : `${configDirName}/skills/.venv/bin/python3`;
	}
	if (fs.existsSync(globalVenv)) {
		return isWindows ? "~/.claude/skills/.venv/Scripts/python.exe" : "~/.claude/skills/.venv/bin/python3";
	}
	return null;
}

/**
 * Resolve a configured path against a base directory without doubling it.
 *
 * Both the plans/docs config values and the reports path derived from them may
 * already be absolute. path.join concatenates rather than resolves, so an
 * absolute input would come back as base + input.
 *
 * @param {string|null} baseDir - Base directory, or null to keep the input as-is
 * @param {string} targetPath - Configured or derived path
 * @returns {string} Display-normalized path
 */
function resolveAgainstBase(baseDir, targetPath) {
	if (!baseDir) return targetPath;
	// toDisplayPath after the join: path.join renders native separators, and
	// these land in the injected prompt for the model to read back.
	return toDisplayPath(path.isAbsolute(targetPath) ? targetPath : path.join(baseDir, targetPath));
}

/**
 * Build plan context from config and git info
 * @param {Object|null} sessionContext - Explicit session state context
 * @param {Object} config - Loaded config
 * @returns {Object} Plan context object
 */
function buildPlanContext(sessionContext, config) {
	const { plan, paths } = config;
	const gitBranch = getGitBranch();
	const resolved = resolvePlanPath(sessionContext, config);
	const reportsPath = getReportsPath(resolved.path, resolved.resolvedBy, plan, paths);

	// Compute naming pattern directly for reliable injection
	const namePattern = resolveNamingPattern(plan, gitBranch);

	const planLine =
		resolved.resolvedBy === "session"
			? `- Plan: ${safeDisplayValue(resolved.path)}`
			: resolved.resolvedBy === "branch"
				? `- Plan: none | Suggested: ${safeDisplayValue(resolved.path)}`
				: `- Plan: none`;

	// Validation config (injected so LLM can reference it)
	const validation = plan.validation || {};
	const validationMode = validation.mode || "prompt";
	const validationMin = validation.minQuestions || 3;
	const validationMax = validation.maxQuestions || 8;

	return { reportsPath, gitBranch, planLine, namePattern, validationMode, validationMin, validationMax };
}

/**
 * Build a scope key for reminder dedup so cwd-sensitive output can re-inject when needed.
 * @param {Object} params
 * @param {string} [params.baseDir] - Working directory for the hook invocation
 * @returns {string} Stable scope key
 */
function buildInjectionScopeKey({ baseDir } = {}) {
	const cwdKey = normalizePath(path.resolve(baseDir || process.cwd())) || process.cwd();
	return cwdKey;
}

function parseTimestamp(value) {
	if (typeof value === "number") return value;
	if (typeof value === "string") return Date.parse(value);
	return NaN;
}

function getReminderScopeState(reminderState, scopeKey) {
	const scopes = reminderState?.scopes;
	if (!scopes || typeof scopes !== "object") return null;
	const scopeState = scopes[scopeKey];
	return scopeState && typeof scopeState === "object" ? scopeState : null;
}

function hasRecentInjection(scopeState, now = Date.now()) {
	const injectedTs = parseTimestamp(scopeState?.lastInjectedAt);
	return Number.isFinite(injectedTs) && now - injectedTs < RECENT_INJECTION_TTL_MS;
}

function hasPendingInjection(scopeState, now = Date.now()) {
	const pendingTs = parseTimestamp(scopeState?.pendingAt);
	return Number.isFinite(pendingTs) && now - pendingTs < PENDING_INJECTION_TTL_MS;
}

function pruneReminderScopes(scopes, now = Date.now()) {
	const nextScopes = {};
	for (const [scopeKey, scopeState] of Object.entries(scopes || {})) {
		if (!scopeState || typeof scopeState !== "object") continue;
		if (hasRecentInjection(scopeState, now) || hasPendingInjection(scopeState, now)) {
			nextScopes[scopeKey] = scopeState;
		}
	}
	return nextScopes;
}

/**
 * Check if context was recently injected (prevent duplicate injection).
 * Uses only the explicitly owned namespaced session state.
 * @param {string|null} _transcriptPath - Ignored compatibility argument
 * @param {Object|null} [sessionContext] - Explicit session state context
 * @param {string|null} [scopeKey='session'] - Scope key for cwd/transcript-aware dedup
 * @returns {boolean} true if recently injected
 */
function wasRecentlyInjected(_transcriptPath, sessionContext = null, scopeKey = "session") {
	try {
		if (!sessionContext) return false;
		const reminderState = readSessionState(sessionContext)?.devRulesReminder;
		return hasRecentInjection(getReminderScopeState(reminderState, scopeKey));
	} catch {
		return false;
	}
}

/**
 * Reserve an injection slot atomically so concurrent hooks do not double-inject.
 * @param {Object|null} sessionContext - Explicit session state context
 * @param {string|null} [scopeKey='session'] - Scope key for cwd/transcript-aware dedup
 * @param {string|null} [_transcriptPath] - Ignored compatibility argument
 * @returns {{ shouldInject: boolean, reserved: boolean }} Whether to inject and whether a pending reservation was written
 */
function reserveInjectionScope(sessionContext, scopeKey = "session", _transcriptPath = null) {
	if (!sessionContext) {
		return {
			shouldInject: true,
			reserved: false,
		};
	}

	try {
		let shouldInject = false;
		const now = Date.now();
		const updated = updateSessionState(sessionContext, (state) => {
			const reminderState =
				state.devRulesReminder && typeof state.devRulesReminder === "object" ? state.devRulesReminder : {};
			const scopes = pruneReminderScopes(reminderState.scopes, now);
			const scopeState = getReminderScopeState({ scopes }, scopeKey) || {};

			if (hasRecentInjection(scopeState, now) || hasPendingInjection(scopeState, now)) {
				return state;
			}

			shouldInject = true;
			scopes[scopeKey] = {
				...scopeState,
				pendingAt: new Date(now).toISOString(),
			};

			return {
				...state,
				devRulesReminder: {
					...reminderState,
					scopes,
				},
			};
		});

		if (!updated) {
			return {
				shouldInject: true,
				reserved: false,
			};
		}

		return { shouldInject, reserved: shouldInject };
	} catch {
		return {
			shouldInject: true,
			reserved: false,
		};
	}
}

/**
 * Persist a recent injection marker for the current session and clear the pending reservation.
 * @param {Object|null} sessionContext - Explicit session state context
 * @param {string|null} [scopeKey='session'] - Scope key for cwd/transcript-aware dedup
 * @returns {boolean} true when the marker is written
 */
function markRecentlyInjected(sessionContext, scopeKey = "session") {
	if (!sessionContext) return false;

	try {
		return updateSessionState(sessionContext, (state) => {
			const reminderState =
				state.devRulesReminder && typeof state.devRulesReminder === "object" ? state.devRulesReminder : {};
			const scopes = pruneReminderScopes(reminderState.scopes);
			const scopeState = getReminderScopeState({ scopes }, scopeKey) || {};

			scopes[scopeKey] = {
				...scopeState,
				lastInjectedAt: new Date().toISOString(),
			};
			delete scopes[scopeKey].pendingAt;

			return {
				...state,
				devRulesReminder: {
					...reminderState,
					scopes,
				},
			};
		});
	} catch {
		return false;
	}
}

/**
 * Clear a pending reservation when the hook fails after reserving a slot.
 * @param {Object|null} sessionContext - Explicit session state context
 * @param {string|null} [scopeKey='session'] - Scope key for cwd/transcript-aware dedup
 * @returns {boolean} true when cleanup succeeds
 */
function clearPendingInjection(sessionContext, scopeKey = "session") {
	if (!sessionContext) return false;

	try {
		return updateSessionState(sessionContext, (state) => {
			const reminderState =
				state.devRulesReminder && typeof state.devRulesReminder === "object" ? state.devRulesReminder : {};
			const scopes = pruneReminderScopes(reminderState.scopes);
			const scopeState = getReminderScopeState({ scopes }, scopeKey);

			if (!scopeState || !scopeState.pendingAt) {
				return state;
			}

			const nextScopeState = { ...scopeState };
			delete nextScopeState.pendingAt;

			if (Object.keys(nextScopeState).length === 0) {
				delete scopes[scopeKey];
			} else {
				scopes[scopeKey] = nextScopeState;
			}

			return {
				...state,
				devRulesReminder: {
					...reminderState,
					scopes,
				},
			};
		});
	} catch {
		return false;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION BUILDERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build language section
 * @param {Object} params
 * @param {string} [params.thinkingLanguage] - Language for thinking
 * @param {string} [params.responseLanguage] - Language for response
 * @returns {string[]} Lines for language section
 */
function buildLanguageSection({ thinkingLanguage, responseLanguage }) {
	// Auto-default thinkingLanguage to 'en' when only responseLanguage is set
	const effectiveThinking = thinkingLanguage || (responseLanguage ? "en" : null);
	const hasThinking = effectiveThinking && effectiveThinking !== responseLanguage;
	const hasResponse = responseLanguage;
	const lines = [];

	if (hasThinking || hasResponse) {
		lines.push(`## Language`);
		if (hasThinking) {
			lines.push(`- Thinking: Use ${effectiveThinking} for reasoning (logic, precision).`);
		}
		if (hasResponse) {
			lines.push(`- Response: Respond in ${responseLanguage} (natural, fluent).`);
			lines.push(
				`- The response language is configured in the AgentKit config file (locale.response_language). Every agent and subagent MUST comply, including prose in delegated subagent prompts and reports. Resolve it with \`ak config prefs resolve --json\` (.prefs.locale.responseLanguage) or read the AgentKit config file directly when the CLI is unavailable.`,
			);
		}
		lines.push(``);
	}

	return lines;
}

/**
 * Build session section
 * @param {Object} [staticEnv] - Pre-computed static environment info
 * @returns {string[]} Lines for session section
 */
function buildSessionSection(staticEnv = {}) {
	// Only values the model cannot infer belong here. Memory and CPU readings
	// were this hook process's own figures, not the machine's, and they changed
	// on every prompt; the delegation contract lives in the orchestration rules,
	// where it applies to the tasks that warrant a delegate rather than to
	// every turn.
	return [
		`## Session`,
		`- DateTime: ${new Date().toLocaleString()}`,
		`- Timezone: ${safeDisplayValue(staticEnv.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone)}`,
		`- Working directory: ${safeDisplayValue(staticEnv.cwd || process.cwd())}`,
		`- OS: ${safeDisplayValue(staticEnv.osPlatform || process.platform)}`,
		`- User: ${safeDisplayValue(staticEnv.user || process["env"].USERNAME || process["env"].USER)}`,
		`- Locale: ${safeDisplayValue(staticEnv.locale || process["env"].LANG || "")}`,
		`- Pass the working directory, timezone, and language settings to any delegate you spawn.`,
		``,
	];
}

/**
 * Read usage limits from cache file (written by usage-context-awareness.cjs)
 * @returns {Object|null} Usage data or null if unavailable
 */
function readUsageCache(cachePath = getUsageCachePath()) {
	try {
		if (fs.existsSync(cachePath)) {
			const cache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
			// Cache is valid for 5 minutes for injection purposes
			if (Date.now() - cache.timestamp < 300000 && cache.data) {
				return cache.data;
			}
		}
	} catch {}
	return null;
}

/**
 * Format time until reset
 * @param {string} resetAt - ISO timestamp
 * @returns {string|null} Formatted time or null
 */
function formatTimeUntilReset(resetAt) {
	if (!resetAt) return null;
	const resetTime = new Date(resetAt);
	const remaining = Math.floor(resetTime.getTime() / 1000) - Math.floor(Date.now() / 1000);
	if (remaining <= 0 || remaining > 18000) return null; // Only show if < 5 hours
	const hours = Math.floor(remaining / 3600);
	const mins = Math.floor((remaining % 3600) / 60);
	return `${hours}h ${mins}m`;
}

/**
 * Format percentage with warning level
 * @param {number} value - Percentage value
 * @param {string} label - Label prefix
 * @returns {string} Formatted string with warning if applicable
 */
function formatUsagePercent(value, label) {
	const pct = Math.round(value);
	if (pct >= CRITICAL_THRESHOLD) return `${label}: ${pct}% [CRITICAL]`;
	if (pct >= WARN_THRESHOLD) return `${label}: ${pct}% [WARNING]`;
	return `${label}: ${pct}%`;
}

/**
 * Build context window section from statusline cache
 * @param {string} sessionId - Session ID
 * @returns {string[]} Lines for context section
 */
function buildContextSection(_sessionContext) {
	// Intentionally empty: rendering a context-usage countdown into the prompt
	// causes premature wrap-up on current models. The status line shows usage
	// to the user instead. Do not re-enable.
	return [];
}

/**
 * Build usage section from cache
 * @returns {string[]} Lines for usage section
 */
function buildUsageSection() {
	// Budget countdowns push the model to cut work short; usage belongs in the
	// status line, not the prompt. The renderer that followed this return was
	// unreachable and is removed so an edit cannot revive it by accident.
	return [];
}

/**
 * Build rules section
 * @param {Object} params
 * @param {string} [params.devRulesPath] - Path to dev rules
 * @param {string} [params.skillsVenv] - Path to skills venv
 * @param {string} [params.plansPath] - Absolute plans path, preventing wrong subdirectory creation
 * @param {string} [params.docsPath] - Absolute docs path
 * @returns {string[]} Lines for rules section
 */
function buildRulesSection({ devRulesPath, skillsVenv, plansPath, docsPath }) {
	const lines = [`## Rules`];

	if (devRulesPath) {
		lines.push(`- Read and follow development rules: "${devRulesPath}"`);
	}

	// Absolute paths prevent LLM confusion in multi-CLAUDE.md projects.
	const plansRef = plansPath || "plans";
	const docsRef = docsPath || "docs";
	lines.push(`- Markdown files are organized in: Plans → "${plansRef}" directory, Docs → "${docsRef}" directory`);
	lines.push(
		`- **IMPORTANT:** DO NOT create markdown files outside of "${plansRef}" or "${docsRef}" UNLESS the user explicitly requests it.`,
	);

	if (skillsVenv) {
		lines.push(`- Python scripts in .claude/skills/: Use \`${skillsVenv}\``);
	}

	lines.push(
		`- When skills' scripts fail, report the failure unless the current task explicitly authorizes fixing skill code; only then fix and rerun.`,
	);
	lines.push(
		`- When working with a database, always back up before any schema or data change (migration, drop, bulk update).`,
	);
	// YAGNI is opt-in: the model reads the request, so the condition lives in the
	// instruction rather than in a prompt-parsing parameter threaded through here.
	// The predicate must name the user's own request — this rules text is itself
	// injected into the prompt, so "the prompt contains --yagni" would always be
	// true and would silently re-enable YAGNI everywhere.
	lines.push(
		`- Follow **KISS (Keep It Simple, Stupid) - DRY (Don't Repeat Yourself)** principles. Deliver the full requested scope; add nothing unrequested. Apply **YAGNI** (challenge and cut scope not needed for the stated outcome) only when the user's own request explicitly passes the \`--yagni\` flag; this rules text mentioning the flag never counts.`,
	);
	lines.push(
		`- Lead with the outcome. Keep reports short by being selective about what you include, not by compressing the writing into fragments, abbreviations, or arrow chains; write complete sentences.`,
	);
	lines.push(`- In reports, list any unresolved questions at the end, if any.`);
	lines.push(``);

	return lines;
}

/**
 * Build paths section
 * @param {Object} params
 * @param {string} params.reportsPath - Reports path
 * @param {string} params.plansPath - Plans path
 * @param {string} params.docsPath - Docs path
 * @param {number} [params.docsMaxLoc=800] - Max lines of code for docs
 * @returns {string[]} Lines for paths section
 */
function buildPathsSection({ reportsPath, plansPath, docsPath, docsMaxLoc = 800 }) {
	return [
		`## Paths`,
		`Reports: ${safeDisplayValue(reportsPath)} | Plans: ${safeDisplayValue(plansPath)} | Docs: ${safeDisplayValue(docsPath)} | docs.maxLoc: ${docsMaxLoc}`,
		``,
	];
}

/**
 * Build plan context section
 * @param {Object} params
 * @param {string} params.planLine - Plan status line
 * @param {string} params.reportsPath - Reports path
 * @param {string} [params.gitBranch] - Git branch
 * @param {string} params.validationMode - Validation mode
 * @param {number} params.validationMin - Min questions
 * @param {number} params.validationMax - Max questions
 * @returns {string[]} Lines for plan context section
 */
function buildPlanContextSection({ planLine, reportsPath, gitBranch, validationMode, validationMin, validationMax }) {
	const lines = [`## Plan Context`, planLine, `- Reports: ${safeDisplayValue(reportsPath)}`];

	if (gitBranch) {
		lines.push(`- Branch: ${safeDisplayValue(gitBranch)}`);
	}

	lines.push(`- Validation: mode=${validationMode}, questions=${validationMin}-${validationMax}`);
	lines.push(``);

	return lines;
}

/**
 * Build naming section
 * @param {Object} params
 * @param {string} params.reportsPath - Reports path
 * @param {string} params.plansPath - Plans path
 * @param {string} params.namePattern - Naming pattern
 * @returns {string[]} Lines for naming section
 */
function buildNamingSection({ reportsPath, plansPath, namePattern }) {
	return [
		`## Naming`,
		`- Report: \`${reportsPath}{type}-${namePattern}.md\``,
		`- Plan dir: \`${plansPath}/${namePattern}/\``,
		`- Replace \`{type}\` with: agent name, report type, or context`,
		`- Replace \`{slug}\` in pattern with: descriptive-kebab-slug`,
	];
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build full reminder content from all sections
 * @param {Object} params - All parameters for building reminder
 * @returns {string[]} Array of lines
 */
function buildReminder(params) {
	const {
		sessionContext,
		thinkingLanguage,
		responseLanguage,
		devRulesPath,
		skillsVenv,
		reportsPath,
		plansPath,
		docsPath,
		docsMaxLoc,
		planLine,
		gitBranch,
		namePattern,
		validationMode,
		validationMin,
		validationMax,
		staticEnv,
		hooks,
	} = params;

	// Respect hooks config — skip sections when their corresponding hook is disabled
	const hooksConfig = hooks || {};
	const contextEnabled = hooksConfig["context-tracking"] !== false;
	const usageEnabled = hooksConfig["usage-context-awareness"] !== false;

	return [
		...buildLanguageSection({ thinkingLanguage, responseLanguage }),
		...buildSessionSection(staticEnv),
		...(contextEnabled ? buildContextSection(sessionContext) : []),
		...(usageEnabled ? buildUsageSection() : []),
		...buildRulesSection({ devRulesPath, skillsVenv, plansPath, docsPath }),
		...buildPathsSection({ reportsPath, plansPath, docsPath, docsMaxLoc }),
		...buildPlanContextSection({ planLine, reportsPath, gitBranch, validationMode, validationMin, validationMax }),
		...buildNamingSection({ reportsPath, plansPath, namePattern }),
	];
}

/**
 * Build complete reminder context (unified entry point for plugins)
 *
 * @param {Object} [params]
 * @param {string} [params.sessionId] - Session ID
 * @param {Object} [params.config] - AgentKit config (auto-loaded if not provided)
 * @param {Object} [params.staticEnv] - Pre-computed static environment info
 * @param {string} [params.configDirName='.claude'] - Config directory name
 * @param {string} [params.baseDir] - Base directory for absolute path resolution
 * @returns {{
 *   content: string,
 *   lines: string[],
 *   sections: Object
 * }}
 */
function buildReminderContext({ sessionContext, config, staticEnv, configDirName = ".claude", baseDir } = {}) {
	// Load config if not provided
	const cfg = config || loadConfig({ includeProject: false, includeAssertions: false });

	// Resolve paths
	const devRulesPath = resolveRulesPath("development-rules.md", configDirName);
	const skillsVenv = resolveSkillsVenv(configDirName);

	// Build plan context
	const planCtx = buildPlanContext(sessionContext, cfg);

	// Use baseDir for subdirectory-aware absolute path resolution.
	// If baseDir provided, resolve paths as absolute; otherwise use relative paths
	const effectiveBaseDir = baseDir || null;
	const plansPathRel = normalizePath(cfg.paths?.plans) || "plans";
	const docsPathRel = normalizePath(cfg.paths?.docs) || "docs";

	// Build all parameters with absolute paths if baseDir provided
	const params = {
		sessionContext,
		thinkingLanguage: cfg.locale?.thinkingLanguage,
		responseLanguage: cfg.locale?.responseLanguage,
		devRulesPath,
		skillsVenv,
		// resolveAgainstBase, not path.join: a configured plans/docs path may
		// already be absolute, and joining a base onto it concatenates the two
		// into one nonexistent ABS/ABS path. These three land in the injected
		// prompt, so every subagent that trusts them would write there.
		reportsPath: resolveAgainstBase(effectiveBaseDir, planCtx.reportsPath),
		plansPath: resolveAgainstBase(effectiveBaseDir, plansPathRel),
		docsPath: resolveAgainstBase(effectiveBaseDir, docsPathRel),
		docsMaxLoc: Math.max(1, parseInt(cfg.docs?.maxLoc, 10) || 800),
		planLine: planCtx.planLine,
		gitBranch: planCtx.gitBranch,
		namePattern: planCtx.namePattern,
		validationMode: planCtx.validationMode,
		validationMin: planCtx.validationMin,
		validationMax: planCtx.validationMax,
		staticEnv,
		hooks: cfg.hooks,
	};

	const lines = buildReminder(params);

	// Respect hooks config for sections object too
	const hooksConfig = cfg.hooks || {};
	const contextEnabled = hooksConfig["context-tracking"] !== false;
	const usageEnabled = hooksConfig["usage-context-awareness"] !== false;

	return {
		content: lines.join("\n"),
		lines,
		sections: {
			language: buildLanguageSection({
				thinkingLanguage: params.thinkingLanguage,
				responseLanguage: params.responseLanguage,
			}),
			session: buildSessionSection(staticEnv),
			context: contextEnabled ? buildContextSection(sessionContext) : [],
			usage: usageEnabled ? buildUsageSection() : [],
			rules: buildRulesSection({ devRulesPath, skillsVenv, plansPath: params.plansPath, docsPath: params.docsPath }),
			paths: buildPathsSection({
				reportsPath: params.reportsPath,
				plansPath: params.plansPath,
				docsPath: params.docsPath,
				docsMaxLoc: params.docsMaxLoc,
			}),
			planContext: buildPlanContextSection(planCtx),
			naming: buildNamingSection({
				reportsPath: params.reportsPath,
				plansPath: params.plansPath,
				namePattern: params.namePattern,
			}),
		},
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
	// Main entry points
	buildReminderContext,
	buildReminder,

	// Section builders
	buildLanguageSection,
	buildSessionSection,
	buildContextSection,
	buildUsageSection,
	buildRulesSection,
	buildPathsSection,
	buildPlanContextSection,
	buildNamingSection,

	// Helpers
	execSafe,
	getUsageCachePath,
	readUsageCache,
	resolveRulesPath,
	resolveScriptPath,
	resolveSkillsVenv,
	resolveAgainstBase,
	buildPlanContext,
	buildInjectionScopeKey,
	wasRecentlyInjected,
	reserveInjectionScope,
	markRecentlyInjected,
	clearPendingInjection,

	// Backward compat alias
	resolveWorkflowPath: resolveRulesPath,
};
