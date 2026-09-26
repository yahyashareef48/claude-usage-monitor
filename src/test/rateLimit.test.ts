import * as assert from 'assert';
// The real module object: TS's import wrapper exposes read-only getters.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const https = require('https') as typeof import('https');
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import { fetchUsageData, retryAtFromMessage, setUserAgent, UsageHttpError } from '../usageClient';
import { newerData } from '../extension';
import { UsageData } from '../types';

type Fake = { status: number; headers?: Record<string, string>; body?: string };

/** Replace https.get for the whole host (the bundled extension shares the module). */
function stubHttps(fake: Fake) {
	const calls: Record<string, string>[] = [];
	const original = https.get;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(https as any).get = (_url: string, opts: { headers: Record<string, string> }, cb: (res: any) => void) => {
		calls.push(opts.headers);
		const req = new EventEmitter() as EventEmitter & { setTimeout: () => void; destroy: () => void; end: () => void };
		req.setTimeout = () => {}; req.destroy = () => {}; req.end = () => {};
		setImmediate(() => {
			const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; setEncoding: () => void };
			res.statusCode = fake.status;
			res.headers = fake.headers ?? {};
			res.setEncoding = () => {};
			cb(res);
			res.emit('data', fake.body ?? '{}');
			res.emit('end');
		});
		return req;
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return { calls, restore: () => { (https as any).get = original; } };
}

const RATE_BODY = '{"error":{"type":"rate_limit_error","message":"Rate limited. Please try again later."}}';

suite('Rate limiting (#16 / PR #18)', () => {
	test('429 with retry-after seconds → typed error with the wait', async () => {
		const s = stubHttps({ status: 429, headers: { 'retry-after': '120' }, body: RATE_BODY });
		try {
			await assert.rejects(fetchUsageData(), (e: unknown) => {
				assert.ok(e instanceof UsageHttpError);
				assert.strictEqual(e.statusCode, 429);
				assert.strictEqual(e.retryAfterMs, 120_000);
				assert.ok(retryAtFromMessage(e.message), `message names a time: ${e.message}`);
				return true;
			});
		} finally { s.restore(); }
	});

	test('retry-after as an HTTP date, and capped at 6h', async () => {
		const at = new Date(Date.now() + 10 * 60_000).toUTCString();
		let s = stubHttps({ status: 429, headers: { 'retry-after': at }, body: RATE_BODY });
		try {
			await assert.rejects(fetchUsageData(), (e: UsageHttpError) => {
				assert.ok(e.retryAfterMs! > 8 * 60_000 && e.retryAfterMs! <= 10 * 60_000, String(e.retryAfterMs));
				return true;
			});
		} finally { s.restore(); }
		s = stubHttps({ status: 429, headers: { 'retry-after': '999999' }, body: RATE_BODY });
		try {
			await assert.rejects(fetchUsageData(), (e: UsageHttpError) => e.retryAfterMs === 6 * 3600_000);
		} finally { s.restore(); }
	});

	test('429 without retry-after keeps the old backoff message', async () => {
		const s = stubHttps({ status: 429, body: RATE_BODY });
		try {
			await assert.rejects(fetchUsageData(), (e: UsageHttpError) => e.retryAfterMs === null && retryAtFromMessage(e.message) === null);
		} finally { s.restore(); }
	});

	test('sends an honest User-Agent', async () => {
		setUserAgent('9.9.9');
		const s = stubHttps({ status: 429, body: RATE_BODY });
		try {
			await fetchUsageData().catch(() => undefined);
			assert.strictEqual(s.calls[0]['User-Agent'], 'claude-usage-monitor/9.9.9');
		} finally { s.restore(); }
	});

	test('a failed poll keeps the fresher snapshot for the shared cache', () => {
		const snap = (at: string, pct: number): UsageData => ({
			fiveHour: { utilization: pct, resetsAt: '2030-01-01T00:00:00Z' },
			sevenDay: null, sevenDaySonnet: null, sevenDayOpus: null, sevenDayOauthApps: null,
			extraUsage: null, fetchedAt: new Date(at),
		});
		const older = snap('2026-09-26T10:00:00Z', 10);
		const newer = snap('2026-09-26T10:05:00Z', 12);
		assert.strictEqual(newerData(older, newer), newer);
		assert.strictEqual(newerData(newer, older), newer);
		assert.strictEqual(newerData(null, older), older, 'cold window falls back to the cache');
		assert.strictEqual(newerData(older, undefined), older, 'wiped cache falls back to memory');
		assert.strictEqual(newerData(null, undefined), null);
		// Revived from globalState, fetchedAt may still be an ISO string.
		const revived = { ...newer, fetchedAt: '2026-09-26T10:05:00.000Z' as unknown as Date };
		assert.strictEqual(newerData(older, revived), revived);
	});

	test('extension: a manual refresh during a block does not call the API again', async function () {
		this.timeout(20_000);
		const ext = vscode.extensions.getExtension('YahyaShareef.claude-code-usage-tracker');
		assert.ok(ext, 'extension found');
		await ext.activate();
		const s = stubHttps({ status: 429, headers: { 'retry-after': '3600' }, body: RATE_BODY });
		try {
			await vscode.commands.executeCommand('claude-usage-monitor.refresh');
			const afterFirst = s.calls.length;           // 1, or 0 if a block is already cached
			assert.ok(afterFirst <= 1);
			await vscode.commands.executeCommand('claude-usage-monitor.refresh');
			await vscode.commands.executeCommand('claude-usage-monitor.refresh');
			assert.strictEqual(s.calls.length, afterFirst, 'blocked refreshes made no request');
			console.log(`    [block] API calls across 3 refreshes: ${s.calls.length}`);
		} finally { s.restore(); }
	});

	test('live: real API answers 200, or a typed 429', async function () {
		this.timeout(20_000);
		try {
			const d = await fetchUsageData();
			console.log(`    [live] 200 — 5h ${d.fiveHour?.utilization}%`);
		} catch (e) {
			assert.ok(e instanceof UsageHttpError && e.statusCode === 429, `unexpected: ${e}`);
			console.log(`    [live] 429 — retryAfterMs=${e.retryAfterMs}`);
		}
	});
});
