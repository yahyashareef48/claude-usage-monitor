import * as assert from 'assert';
import * as vscode from 'vscode';
import { fetchUsageData } from '../usageClient';
import { renderTemplate, tokenValues } from '../windows';
import { UsageData } from '../types';

// Runs inside a real VS Code against the live /api/oauth/usage response.
suite('Reset display (#17)', () => {
	const cfg = () => vscode.workspace.getConfiguration('claude-usage-monitor');
	const set = (key: string, value: unknown) => cfg().update(key, value, vscode.ConfigurationTarget.Global);
	let data: UsageData;

	suiteSetup(async function () {
		this.timeout(20_000);
		data = await fetchUsageData();
		assert.ok(data.fiveHour?.resetsAt, 'live API returned a 5h reset time');
	});

	suiteTeardown(async () => {
		await set('resetDisplay', undefined);
		await set('clockFormat', undefined);
	});

	const show = (label: string) => {
		const t = tokenValues(data);
		console.log(`    [${label}] reset="${t['5h.reset']}" resetTime="${t['5h.resettime']}" 7d.reset="${t['7d.reset']}" bar="${renderTemplate('{5h.pct} · {5h.reset}', data)}"`);
		return t;
	};

	test('countdown (default) keeps "3h 37m"', async () => {
		await set('resetDisplay', undefined);
		const t = show('countdown');
		assert.match(t['5h.reset'], /^(\d+h )?\d+m$|^resetting$/);
	});

	test('clock shows local time, 24h', async () => {
		await set('clockFormat', '24h');
		await set('resetDisplay', 'clock');
		const t = show('clock 24h');
		assert.match(t['5h.reset'], /^(\w{3},? )?\d{1,2}:\d{2}$/);
		const d = new Date(data.fiveHour!.resetsAt);
		assert.ok(t['5h.reset'].endsWith(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`)
			|| t['5h.reset'].endsWith(`${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`), 'matches the real reset hour');
	});

	test('clock honours 12h', async () => {
		await set('clockFormat', '12h');
		await set('resetDisplay', 'clock');
		const t = show('clock 12h');
		assert.match(t['5h.reset'], /\d{1,2}:\d{2}\s?(AM|PM)$/i);
	});

	test('both combines countdown and clock', async () => {
		await set('clockFormat', '24h');
		await set('resetDisplay', 'both');
		const t = show('both');
		assert.match(t['5h.reset'], /^(\d+h )?\d+m \(.*\d{1,2}:\d{2}\)$/);
	});

	test('.resetTime is the clock regardless of mode', async () => {
		await set('resetDisplay', 'countdown');
		const t = show('resetTime');
		assert.match(t['5h.resettime'], /\d{1,2}:\d{2}/);
		assert.notStrictEqual(t['5h.resettime'], t['5h.reset']);
	});
});
