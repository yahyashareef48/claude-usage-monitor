import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as https from 'https';
import { execSync } from 'child_process';
import { UsageData } from './types';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const BETA_HEADER = 'oauth-2025-04-20';

interface Credentials {
	claudeAiOauth?: {
		accessToken?: string;
	};
}

/**
 * Mirrors the Claude Code extension's own config dir resolution:
 * CLAUDE_CONFIG_DIR env var, otherwise ~/.claude
 */
function getClaudeConfigDir(): string {
	const envDir = process.env.CLAUDE_CONFIG_DIR;
	if (envDir) {
		return envDir;
	}
	return path.join(os.homedir(), '.claude');
}

function readTokenFromKeychain(): string | null {
	if (process.platform !== 'darwin') { return null; }
	try {
		const json = execSync(
			"security find-generic-password -s 'Claude Code-credentials' -w",
			{ timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
		).toString().trim();
		const parsed = JSON.parse(json);
		// Keychain output: { accessToken, refreshToken, expiresAt }
		// Fallback: older format { claudeAiOauth: { accessToken } }
		return parsed?.accessToken ?? parsed?.claudeAiOauth?.accessToken ?? null;
	} catch {
		return null;
	}
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

export async function fetchUsageData(): Promise<UsageData> {
	const token = readAccessToken();
	if (!token) {
		const credPath = path.join(getClaudeConfigDir(), '.credentials.json');
		const macNote = process.platform === 'darwin' ? ' and macOS Keychain (Claude Code-credentials)' : '';
		throw new Error(`No OAuth token found. Looked in: ${credPath}${macNote}. Make sure you are logged in to Claude Code.`);
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

	return {
		fiveHour: parseQuotaBucket(raw.five_hour),
		sevenDay: parseQuotaBucket(raw.seven_day),
		sevenDaySonnet: parseQuotaBucket(raw.seven_day_sonnet),
		sevenDayOpus: parseQuotaBucket(raw.seven_day_opus),
		sevenDayOauthApps: parseQuotaBucket(raw.seven_day_oauth_apps),
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
