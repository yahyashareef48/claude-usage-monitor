import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// The real module object: TS's import wrapper exposes read-only getters.
const https = require('https') as typeof import('https');
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import { fetchUsageData, readClaudeCodeSnapshot } from '../usageClient';
import { accountScopedKey, getAccount, getClaudeConfigDir, getKeychainServices } from '../claudeConfig';
import { StatusBarManager } from '../statusBar';

/** Record the Authorization header of every https.get, answering with an empty usage body. */
function stubHttps() {
	const auth: string[] = [];
	const original = https.get;
	(https as any).get = (_url: string, opts: { headers: Record<string, string> }, cb: (res: any) => void) => {
		auth.push(opts.headers.Authorization);
		const req = new EventEmitter() as EventEmitter & { setTimeout: () => void; destroy: () => void; end: () => void };
		req.setTimeout = () => {}; req.destroy = () => {}; req.end = () => {};
		setImmediate(() => {
			const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; setEncoding: () => void };
			res.statusCode = 200;
			res.headers = {};
			res.setEncoding = () => {};
			cb(res);
			res.emit('data', '{}');
			res.emit('end');
		});
		return req;
	};
	return { auth, restore: () => { (https as any).get = original; } };
}

const reading = (pct: number) => ({
	five_hour: { utilization: pct, resets_at: new Date(Date.now() + 3 * 3_600_000).toISOString() },
	seven_day: { utilization: pct, resets_at: new Date(Date.now() + 48 * 3_600_000).toISOString() },
});

/** A logged-in Claude Code config directory, as Claude Code lays it out on Windows/Linux. */
function account(name: string, pct: number): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cum-${name}-`));
	const uuid = `uuid-${name}`;
	fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `test-token-${name}` } }));
	fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({
		oauthAccount: { accountUuid: uuid, emailAddress: `${name}@example.com`, displayName: name, organizationName: `${name}@example.com's Organization` },
		cachedUsageUtilization: { fetchedAtMs: Date.now(), accountUuid: uuid, utilization: reading(pct) },
	}));
	return dir;
}

const cfg = () => vscode.workspace.getConfiguration('claude-usage-monitor');
const set = (key: string, value: unknown) => cfg().update(key, value, vscode.ConfigurationTarget.Global);
const sha8 = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);

// Two fake accounts in two temp config dirs — no live API call, no real credentials.
suite('Two accounts, one per window (#12 / PR #15)', () => {
	const savedEnv = process.env.CLAUDE_CONFIG_DIR;
	let personal: string;
	let work: string;

	suiteSetup(() => {
		// The extension host never sees CLAUDE_CONFIG_DIR in real use; neither do we.
		delete process.env.CLAUDE_CONFIG_DIR;
		personal = account('personal', 12);
		work     = account('work', 77);
	});
	suiteTeardown(async () => {
		await set('configDir', undefined);
		await set('statusBarFormat', undefined);
		for (const dir of [personal, work]) { fs.rmSync(dir, { recursive: true, force: true }); }
		if (savedEnv === undefined) { delete process.env.CLAUDE_CONFIG_DIR; } else { process.env.CLAUDE_CONFIG_DIR = savedEnv; }
	});

	test('the setting picks the config dir, with ~ expanded', async () => {
		await set('configDir', work);
		assert.strictEqual(getClaudeConfigDir(), path.resolve(work));
		await set('configDir', '~/.claude-work');
		assert.strictEqual(getClaudeConfigDir(), path.join(os.homedir(), '.claude-work'));
		await set('configDir', undefined);
		assert.strictEqual(getClaudeConfigDir(), path.join(os.homedir(), '.claude'));
	});

	test("each window calls the API with its own account's token", async () => {
		const s = stubHttps();
		try {
			await set('configDir', personal);
			await fetchUsageData();
			await set('configDir', work);
			await fetchUsageData();
		} finally { s.restore(); }
		assert.deepStrictEqual(s.auth, ['Bearer test-token-personal', 'Bearer test-token-work']);
	});

	test("Claude Code's saved reading comes from the window's own account", async () => {
		// The bug fixed during the merge: this read ~/.claude.json for every window.
		await set('configDir', personal);
		assert.strictEqual((await readClaudeCodeSnapshot())?.fiveHour?.utilization, 12);
		await set('configDir', work);
		assert.strictEqual((await readClaudeCodeSnapshot())?.fiveHour?.utilization, 77);
	});

	test('the account is named from its own .claude.json', async () => {
		await set('configDir', personal);
		assert.strictEqual(getAccount()?.email, 'personal@example.com');
		await set('configDir', work);
		assert.strictEqual(getAccount()?.email, 'work@example.com');
	});

	test('cache, history and notification keys are separate per account; the default keeps the bare key', async () => {
		await set('configDir', personal);
		const a = accountScopedKey('claudeUsage.cache.v2');
		await set('configDir', work);
		const b = accountScopedKey('claudeUsage.cache.v2');
		assert.notStrictEqual(a, b);
		assert.strictEqual(b, `claudeUsage.cache.v2:${sha8(path.resolve(work))}`);
		await set('configDir', undefined);
		assert.strictEqual(accountScopedKey('claudeUsage.cache.v2'), 'claudeUsage.cache.v2');
	});

	test('macOS Keychain lookup is namespaced per dir; the legacy item only for the default', async () => {
		await set('configDir', work);
		assert.deepStrictEqual(getKeychainServices(), [`Claude Code-credentials-${sha8(path.resolve(work))}`]);
		await set('configDir', undefined);
		const def = path.join(os.homedir(), '.claude');
		assert.deepStrictEqual(getKeychainServices(), [`Claude Code-credentials-${sha8(def)}`, 'Claude Code-credentials']);
	});

	test('the status bar shows each window its own numbers and account', async () => {
		await set('statusBarFormat', '{5h.pct} ({account})');
		const mgr = new StatusBarManager();
		const item = () => (mgr as unknown as { item: vscode.StatusBarItem }).item;
		const tooltip = () => { const t = item().tooltip; return typeof t === 'string' ? t : t?.value ?? ''; };
		try {
			for (const [dir, pct, email] of [[personal, 12, 'personal@example.com'], [work, 77, 'work@example.com']] as const) {
				await set('configDir', dir);
				const d = await readClaudeCodeSnapshot();
				assert.ok(d);
				mgr.update(d);
				console.log(`    [bar] ${item().text}`);
				assert.strictEqual(item().text, `${pct}% (${email})`);
				assert.ok(tooltip().includes(email), 'tooltip names the account');
			}
		} finally { mgr.dispose(); }
	});
});
