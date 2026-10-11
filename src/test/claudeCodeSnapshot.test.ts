import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { newest, readClaudeCodeSnapshot } from '../usageClient';
import { UsageData } from '../types';

const BODY = {
	five_hour:  { utilization: 12, resets_at: '2026-10-03T12:29:59.865543+00:00' },
	seven_day:  { utilization: 34, resets_at: '2026-10-03T22:59:59.865561+00:00' },
	seven_day_sonnet: null,
	extra_usage: { is_enabled: true, monthly_limit: 20000, used_credits: 0, utilization: null, currency: 'USD' },
	limits: [
		{ kind: 'session',       group: 'session', percent: 12, resets_at: '2026-10-03T12:29:59Z', scope: null, is_active: false },
		{ kind: 'weekly_all',    group: 'weekly',  percent: 34, resets_at: '2026-10-03T22:59:59Z', scope: null, is_active: true },
		{ kind: 'weekly_scoped', group: 'weekly',  percent: 100, resets_at: '2026-10-03T23:00:00Z',
			scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
	],
};

// Claude Code's saved reading, from a temp CLAUDE_CONFIG_DIR — no live API call.
suite("Claude Code's saved reading", () => {
	const saved = process.env.CLAUDE_CONFIG_DIR;
	let dir: string;
	const write = (name: string, json: unknown) =>
		fs.writeFileSync(path.join(dir, name), typeof json === 'string' ? json : JSON.stringify(json));
	const config = (over: Record<string, unknown> = {}) => ({
		oauthAccount: { accountUuid: 'acc-1' },
		cachedUsageUtilization: { fetchedAtMs: Date.now() - 30_000, accountUuid: 'acc-1', utilization: BODY },
		...over,
	});

	setup(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cum-snap-'));
		process.env.CLAUDE_CONFIG_DIR = dir;
	});
	teardown(() => {
		fs.rmSync(dir, { recursive: true, force: true });
		if (saved === undefined) { delete process.env.CLAUDE_CONFIG_DIR; } else { process.env.CLAUDE_CONFIG_DIR = saved; }
	});

	test('parses the same shape as the API, Fable and pay-as-you-go included', async () => {
		const c = config();
		write('.claude.json', c);
		const d = await readClaudeCodeSnapshot();
		assert.ok(d);
		assert.strictEqual(d.source, 'claude-code');
		assert.strictEqual(d.fetchedAt.getTime(), c.cachedUsageUtilization.fetchedAtMs);
		assert.strictEqual(d.fiveHour?.utilization, 12);
		assert.strictEqual(d.sevenDay?.utilization, 34);
		assert.strictEqual(d.limits?.find((l) => l.modelName === 'Fable')?.percent, 100);
		assert.strictEqual(d.extraUsage?.monthlyLimit, 20000);
	});

	test('a legacy .config.json in the config dir wins, as in Claude Code', async () => {
		write('.claude.json', config());
		write('.config.json', config({ cachedUsageUtilization: { fetchedAtMs: 1, accountUuid: 'acc-1', utilization: BODY } }));
		assert.strictEqual((await readClaudeCodeSnapshot())?.fetchedAt.getTime(), 1);
	});

	test('a reading saved under another account is ignored', async () => {
		write('.claude.json', config({ oauthAccount: { accountUuid: 'acc-2' } }));
		assert.strictEqual(await readClaudeCodeSnapshot(), null);
	});

	test('missing file, bad JSON, or no saved reading → null, never a throw', async () => {
		assert.strictEqual(await readClaudeCodeSnapshot(), null);
		write('.claude.json', '{ not json');
		assert.strictEqual(await readClaudeCodeSnapshot(), null);
		write('.claude.json', { oauthAccount: { accountUuid: 'acc-1' } });
		assert.strictEqual(await readClaudeCodeSnapshot(), null);
		write('.claude.json', config({ cachedUsageUtilization: { fetchedAtMs: 'soon', utilization: BODY } }));
		assert.strictEqual(await readClaudeCodeSnapshot(), null);
	});

	test('a future timestamp is clamped to now', async () => {
		write('.claude.json', config({ cachedUsageUtilization: { fetchedAtMs: Date.now() + 3_600_000, accountUuid: 'acc-1', utilization: BODY } }));
		const d = await readClaudeCodeSnapshot();
		assert.ok(d && d.fetchedAt.getTime() <= Date.now());
	});

	test('newest() picks the latest reading and skips nulls', () => {
		const at = (ms: number) => ({ fetchedAt: new Date(ms) } as UsageData);
		const a = at(1000), b = at(2000);
		assert.strictEqual(newest(a, null, b, undefined), b);
		assert.strictEqual(newest(b, a), b);
		assert.strictEqual(newest(null, undefined), null);
	});

	test('live: reads the real config on this machine, if Claude Code saved one', async () => {
		if (saved === undefined) { delete process.env.CLAUDE_CONFIG_DIR; } else { process.env.CLAUDE_CONFIG_DIR = saved; }
		const d = await readClaudeCodeSnapshot();
		console.log(d
			? `    [live] saved ${Math.round((Date.now() - d.fetchedAt.getTime()) / 1000)}s ago · 5h ${d.fiveHour?.utilization}% · 7d ${d.sevenDay?.utilization}% · ${d.limits?.length ?? 0} limits`
			: '    [live] no saved reading on this machine');
		if (d) { assert.strictEqual(d.source, 'claude-code'); }
	});
});
