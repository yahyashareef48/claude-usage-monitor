import * as assert from 'assert';
import * as vscode from 'vscode';
import { buildFragments } from '../sessionPopover';
import { UsageData } from '../types';
import { formatReset, formatTimeRemaining } from '../windows';

suite('Long reset countdown', () => {
	const cfg = () => vscode.workspace.getConfiguration('claude-usage-monitor');
	const set = (key: string, value: unknown) => cfg().update(key, value, vscode.ConfigurationTarget.Global);
	// Half a minute of slack so the countdown does not tick over mid-test.
	const inTwoDays = new Date(Date.now() + ((2 * 24 + 3) * 60 + 5) * 60_000 + 30_000).toISOString();
	const inAnHour  = new Date(Date.now() + 60 * 60_000 + 30_000).toISOString();

	suiteTeardown(async () => {
		await set('showLongResetCountdown', undefined);
		await set('resetDisplay', undefined);
	});

	test('off (default) shows the weekday and time past a day', async () => {
		await set('showLongResetCountdown', undefined);
		assert.doesNotMatch(formatTimeRemaining(inTwoDays), /^\d+d /);
	});

	test('on counts down in days', async () => {
		await set('showLongResetCountdown', true);
		assert.strictEqual(formatTimeRemaining(inTwoDays), '2d 3h 5m');
	});

	test('on leaves resets within a day unchanged', async () => {
		await set('showLongResetCountdown', true);
		assert.strictEqual(formatTimeRemaining(inAnHour), '1h 0m');
	});

	test('both mode pairs the long countdown with the clock', async () => {
		await set('resetDisplay', 'both');
		await set('showLongResetCountdown', true);
		assert.match(formatReset(inTwoDays), /^2d 3h 5m \(.+\)$/);
		await set('showLongResetCountdown', undefined);
		assert.doesNotMatch(formatReset(inTwoDays), /\(/, 'without it, past a day is just the clock');
	});

	test('the panel counts down in days and its checkbox follows the setting', async () => {
		const empty = { v: 3 as const, windows: {} };
		const data: UsageData = {
			fiveHour:          { utilization: 12, resetsAt: inAnHour },
			sevenDay:          { utilization: 70, resetsAt: inTwoDays },
			sevenDaySonnet:    null,
			sevenDayOpus:      null,
			sevenDayOauthApps: null,
			extraUsage:        null,
			fetchedAt:         new Date(),
		};
		const checkbox = /<input type="checkbox"( checked)? onchange="updateSetting\('claude-usage-monitor\.showLongResetCountdown', this\.checked\)">/;

		await set('showLongResetCountdown', true);
		const on = buildFragments(data, null, empty);
		assert.ok(on.bucketsHtml.includes('Resets in 2d 3h 5m'), 'panel bar uses the shared countdown');
		assert.strictEqual(on.settingsHtml.match(checkbox)?.[1], ' checked');

		await set('showLongResetCountdown', undefined);
		assert.strictEqual(buildFragments(data, null, empty).settingsHtml.match(checkbox)?.[1], undefined);
	});

	test('package.json contributes the setting', () => {
		const ext = vscode.extensions.getExtension('YahyaShareef.claude-code-usage-tracker');
		assert.ok(ext, 'extension found');
		const props = ext.packageJSON.contributes.configuration.properties;
		assert.strictEqual(props['claude-usage-monitor.showLongResetCountdown']?.default, false);
	});
});
