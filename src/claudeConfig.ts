import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';

/**
 * Which Claude Code account this window is monitoring.
 *
 * Claude Code resolves `$CLAUDE_CONFIG_DIR` (falling back to ~/.claude), which
 * is how people keep two accounts side by side on one machine — a personal one
 * in the default directory and a work one somewhere else.
 *
 * That env var never reaches us, though: `claudeCode.environmentVariables`
 * injects only into the Claude Code process and `terminal.integrated.env.*`
 * only into integrated terminals. Neither touches the extension host, so
 * `process.env.CLAUDE_CONFIG_DIR` is empty here no matter which window we are
 * in. The `configDir` setting is the escape hatch, and it wins over the env var
 * when both are set.
 */
export function getClaudeConfigDir(): string {
	const configured = cfg().get<string>('configDir', '').trim();
	if (configured) { return path.resolve(expandHome(configured)); }

	const envDir = process.env.CLAUDE_CONFIG_DIR;
	if (envDir) { return path.resolve(expandHome(envDir)); }

	return defaultConfigDir();
}

const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/**
 * macOS Keychain service names to try, most specific first.
 *
 * Claude Code namespaces the item per config directory:
 *
 *     Claude Code-credentials-<first 8 hex of sha256(config dir)>
 *
 * The account attribute is the macOS user in every item, so it is the service
 * name — not the account — that tells two logged-in Claude accounts apart.
 *
 * The unsuffixed name is the legacy one, still present on machines that logged
 * in before the namespacing. It is only offered as a fallback for the default
 * directory: falling back to it for an explicitly configured directory is how
 * you end up quietly reporting the other account, which is the bug this whole
 * lookup exists to avoid.
 */
export function getKeychainServices(): string[] {
	const dir = getClaudeConfigDir();
	const namespaced = `${KEYCHAIN_SERVICE}-${sha256(dir).slice(0, 8)}`;
	return dir === defaultConfigDir() ? [namespaced, KEYCHAIN_SERVICE] : [namespaced];
}

/**
 * Namespace a globalState key by account.
 *
 * globalState is shared by every window of the same VS Code install, so two
 * windows watching different accounts would otherwise trade cached usage,
 * burn-rate history and notification bookkeeping with each other.
 *
 * Keyed off the directory rather than the account e-mail so the key stays
 * stable even when the e-mail cannot be read, and the default directory keeps
 * the bare key so existing users do not lose their history on upgrade.
 */
export function accountScopedKey(base: string): string {
	const dir = getClaudeConfigDir();
	if (dir === defaultConfigDir()) { return base; }
	return `${base}:${sha256(dir).slice(0, 8)}`;
}

/** True when a config change affects which account this window reports on. */
export function affectsAccount(e: vscode.ConfigurationChangeEvent): boolean {
	return e.affectsConfiguration('claude-usage-monitor.configDir');
}

/** The Claude account a window is monitoring, as Claude Code recorded it. */
export interface ClaudeAccount {
	email:            string | null;
	displayName:      string | null;
	organizationName: string | null;
}

/**
 * Who this window is logged in as.
 *
 * The usage API answers for whoever the token belongs to and never names them,
 * so the only way to label a window with its account is Claude Code's own
 * `.claude.json`, where `oauthAccount` is written on login and refreshed with
 * the profile. That matters most for the very setup `configDir` exists for: two
 * windows, two accounts, otherwise indistinguishable percentages.
 */
export function getAccount(): ClaudeAccount | null {
	for (const file of accountFiles()) {
		let mtimeMs: number;
		try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }

		const known = cachedAccount && cachedAccount.path === file ? cachedAccount : null;
		if (known && known.mtimeMs === mtimeMs) { return known.account; }

		const account = readAccount(file);
		// Claude Code rewrites .claude.json constantly, so a read can land
		// mid-write. Keep the account already known rather than blanking the
		// status bar for one poll.
		if (!account) { return known ? known.account : null; }

		cachedAccount = { path: file, mtimeMs, account };
		return account;
	}
	return null;
}

function sha256(s: string): string {
	return crypto.createHash('sha256').update(s).digest('hex');
}

function cfg() {
	return vscode.workspace.getConfiguration('claude-usage-monitor');
}

function defaultConfigDir(): string {
	return path.join(os.homedir(), '.claude');
}

function expandHome(p: string): string {
	if (p === '~') { return os.homedir(); }
	if (p.startsWith('~/')) { return path.join(os.homedir(), p.slice(2)); }
	return p;
}

interface CachedAccount { path: string; mtimeMs: number; account: ClaudeAccount; }

/** Keyed by path, so switching `configDir` cannot return the other account. */
let cachedAccount: CachedAccount | null = null;

/**
 * `.claude.json` candidates for this config directory, most authoritative first.
 *
 * Current Claude Code keeps the file inside the config directory; older versions
 * kept it at ~/.claude.json, and upgraded machines still carry that copy. The
 * legacy path is offered only for the default directory — reading it for an
 * explicitly configured one would name the other account, the same trap
 * getKeychainServices() avoids.
 */
function accountFiles(): string[] {
	const dir    = getClaudeConfigDir();
	const inside = path.join(dir, '.claude.json');
	return dir === defaultConfigDir() ? [inside, path.join(os.homedir(), '.claude.json')] : [inside];
}

function readAccount(file: string): ClaudeAccount | null {
	let oauth: Record<string, unknown> | undefined;
	try {
		oauth = JSON.parse(fs.readFileSync(file, 'utf8'))?.oauthAccount;
	} catch {
		return null;
	}
	if (!oauth) { return null; }
	return {
		email:            str(oauth.emailAddress),
		displayName:      str(oauth.displayName),
		organizationName: str(oauth.organizationName),
	};
}

function str(v: unknown): string | null {
	return typeof v === 'string' && v.trim() ? v.trim() : null;
}
