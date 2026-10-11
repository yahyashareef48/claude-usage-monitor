import * as assert from 'assert';
import * as vscode from 'vscode';
import { colorPct, renderTemplate, tokenValues } from '../windows';
import { UsageData } from '../types';

suite('Usage display: used vs remaining (#26)', () => {
	const cfg = () => vscode.workspace.getConfiguration('claude-usage-monitor');
	const set = (key: string, value: unknown) => cfg().update(key, value, vscode.ConfigurationTarget.Global);
	const inAnHour = new Date(Date.now() + 3_600_000).toISOString();
	const data: UsageData = {
		fiveHour:          { utilization: 12, resetsAt: inAnHour },
		sevenDay:          { utilization: 70, resetsAt: inAnHour },
		sevenDaySonnet:    null,
		sevenDayOpus:      null,
		sevenDayOauthApps: null,
		extraUsage:        null,
		fetchedAt:         new Date(),
	};

	suiteTeardown(async () => { await set('usageDisplay', undefined); });

	test('used (default) keeps today\'s numbers', async () => {
		await set('usageDisplay', undefined);
		const t = tokenValues(data);
		assert.strictEqual(t['5h.pct'], '12%');
		assert.strictEqual(t['5h.bar'], '█░░░░░░░░░');
	});

	test('remaining flips .pct and .bar', async () => {
		await set('usageDisplay', 'remaining');
		const t = tokenValues(data);
		assert.strictEqual(t['5h.pct'], '88%');
		assert.strictEqual(t['5h.bar'], '█████████░');
		assert.strictEqual(t['max.pct'], '30%', 'max still picks the most-used window');
		assert.match(renderTemplate('{5h.pct} · {5h.reset}', data), /^88% · (\d+h )?\d+m$/);
	});

	test('.used and .left ignore the setting', async () => {
		for (const mode of ['used', 'remaining']) {
			await set('usageDisplay', mode);
			const t = tokenValues(data);
			assert.strictEqual(t['5h.used'], '12%');
			assert.strictEqual(t['5h.left'], '88%');
		}
	});

	test('colours stay on used', async () => {
		await set('usageDisplay', 'remaining');
		assert.strictEqual(colorPct(data, ['5h', '7d']), 70);
	});
});
