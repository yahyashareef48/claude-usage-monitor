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
