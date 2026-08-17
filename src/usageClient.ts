import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { execFileSync } from 'child_process';
import { QuotaBucket, UsageData, UsageLimit } from './types';
import { getClaudeConfigDir, getKeychainServices } from './claudeConfig';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const BETA_HEADER = 'oauth-2025-04-20';

interface Credentials {
	claudeAiOauth?: {
		accessToken?: string;
	};
}

/** execFile, not exec: the service name is derived from user input and must not reach a shell. */
function keychainRead(service: string): string | null {
	try {
		return execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
			timeout: 3000,
			stdio: ['ignore', 'pipe', 'ignore'],
		}).toString().trim();
	} catch {
		return null;
	}
}

function readTokenFromKeychain(): string | null {
	if (process.platform !== 'darwin') { return null; }

	for (const service of getKeychainServices()) {
		const json = keychainRead(service);
		if (!json) { continue; }
		try {
			const parsed = JSON.parse(json);
			// Keychain output: { accessToken, refreshToken, expiresAt }
			// Fallback: older format { claudeAiOauth: { accessToken } }
			const token = parsed?.accessToken ?? parsed?.claudeAiOauth?.accessToken ?? null;
			if (token) { return token; }
		} catch { /* unparseable item — try the next service */ }
	}
	return null;
}

function readAccessToken(): string | null {
	const credPath = path.join(getClaudeConfigDir(), '.credentials.json');
	try {
		const raw = fs.readFileSync(credPath, 'utf-8');
		const creds: Credentials = JSON.parse(raw);
		const token = creds.claudeAiOauth?.accessToken ?? null;
		if (token) { return token; }
	} catch { /* file missing or unreadable */ }

	// Fallback: macOS Keychain (Claude Code stores creds here on newer versions)
	return readTokenFromKeychain();
}

function httpsGet(url: string, headers: Record<string, string>): Promise<string> {
	return new Promise((resolve, reject) => {
		const req = https.get(url, { headers }, (res) => {
			let body = '';
			res.on('data', (chunk: Buffer) => (body += chunk.toString()));
			res.on('end', () => {
				if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
					resolve(body);
				} else {
					reject(new Error(`HTTP ${res.statusCode}: ${body}`));
				}
			});
		});
		req.on('error', reject);
		req.setTimeout(8000, () => {
			req.destroy(new Error('Request timed out'));
		});
	});
}

function parseQuotaBucket(raw: { utilization: number; resets_at: string } | null) {
	if (!raw) { return null; }
	return { utilization: raw.utilization, resetsAt: raw.resets_at };
}

/**
 * Parse the newer `limits` array generically — no hardcoded model names.
 * Skips malformed entries instead of throwing so one bad entry can't blank
 * every bar. Note: entries are rendered regardless of `is_active` (the
 * scoped per-model entries report is_active: false while still meaningful).
 */
function parseLimits(raw: unknown): UsageLimit[] {
	if (!Array.isArray(raw)) { return []; }
	const limits: UsageLimit[] = [];
	for (const e of raw) {
		if (!e || typeof e !== 'object') { continue; }
		const entry = e as Record<string, unknown>;
		if (typeof entry.percent !== 'number' || !isFinite(entry.percent)) { continue; }
		const scope = (entry.scope ?? null) as { model?: { display_name?: unknown }; surface?: unknown } | null;
		limits.push({
			kind:      typeof entry.kind === 'string' ? entry.kind : 'unknown',
			group:     typeof entry.group === 'string' ? entry.group : null,
			percent:   entry.percent,
			severity:  typeof entry.severity === 'string' ? entry.severity : null,
			resetsAt:  typeof entry.resets_at === 'string' && entry.resets_at ? entry.resets_at : null,
			isActive:  entry.is_active === true,
			modelName: typeof scope?.model?.display_name === 'string' ? scope.model.display_name : null,
			surface:   typeof scope?.surface === 'string' ? scope.surface : null,
		});
	}
	return limits;
}

/**
 * Backward-compat shim: on accounts where a legacy window field is null but
 * the equivalent `limits` entry exists, synthesize a QuotaBucket from it so
 * the status bar (which reads fiveHour/sevenDay) keeps working.
 */
function bucketFromLimit(limits: UsageLimit[], kind: string): QuotaBucket | null {
	const l = limits.find((x) => x.kind === kind && x.resetsAt !== null && x.modelName === null);
	if (!l) { return null; }
	return { utilization: l.percent, resetsAt: l.resetsAt! };
}

export async function fetchUsageData(): Promise<UsageData> {
	const token = readAccessToken();
	if (!token) {
		const credPath = path.join(getClaudeConfigDir(), '.credentials.json');
		const macNote = process.platform === 'darwin'
			? ` and macOS Keychain (${getKeychainServices().join(', ')})`
			: '';
		throw new Error(`No OAuth token found. Looked in: ${credPath}${macNote}. Make sure you are logged in to Claude Code. If you run more than one account, point "claude-usage-monitor.configDir" at the right config directory.`);
	}

	let body: string;
	try {
		body = await httpsGet(USAGE_URL, {
			'Authorization': `Bearer ${token}`,
			'Content-Type': 'application/json',
			'anthropic-beta': BETA_HEADER,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes('HTTP 401')) {
			throw new Error('HTTP 401 — Unauthorized: Your session token has expired or is invalid. Fix: start a new Claude Code session, then run "Claude: Refresh Usage" in the VS Code command palette. If that fails, log out and log back in to Claude Code.');
		}
		if (msg.includes('HTTP 403')) {
			throw new Error('HTTP 403 — Forbidden: Your account may not have access to the usage API. Fix: make sure you are logged in to Claude Code with a valid Pro/Max subscription.');
		}
		if (msg.includes('HTTP 429')) {
			throw new Error('HTTP 429 — Rate limited by Anthropic API. The extension will retry automatically with backoff.');
		}
		if (msg.includes('timed out') || msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')) {
			throw new Error(`Network error: ${msg}. Fix: check your internet connection and try running "Claude: Refresh Usage".`);
		}
		throw err;
	}

	const raw = JSON.parse(body);

	if (raw.type === 'error') {
		throw new Error(`API error: ${raw.error?.message ?? JSON.stringify(raw.error)}`);
	}

	const limits = parseLimits(raw.limits);

	return {
		fiveHour: parseQuotaBucket(raw.five_hour) ?? bucketFromLimit(limits, 'session'),
		sevenDay: parseQuotaBucket(raw.seven_day) ?? bucketFromLimit(limits, 'weekly_all'),
		sevenDaySonnet: parseQuotaBucket(raw.seven_day_sonnet),
		sevenDayOpus: parseQuotaBucket(raw.seven_day_opus),
		sevenDayOauthApps: parseQuotaBucket(raw.seven_day_oauth_apps),
		limits,
		extraUsage: raw.extra_usage
			? {
				isEnabled: raw.extra_usage.is_enabled ?? false,
				monthlyLimit: raw.extra_usage.monthly_limit ?? null,
				usedCredits: raw.extra_usage.used_credits ?? null,
				utilization: raw.extra_usage.utilization ?? null,
				currency: raw.extra_usage.currency ?? null,
			}
			: null,
		fetchedAt: new Date(),
	};
}
