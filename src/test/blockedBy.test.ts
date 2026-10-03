import * as assert from 'assert';
import * as vscode from 'vscode';
import { blockedWindow, readBlockedBy } from '../windows';
import { UsageData, UsageLimit } from '../types';

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

function limit(kind: string, percent: number, resetsAt: string, modelName: string | null = null): UsageLimit {
	return { kind, group: kind === 'session' ? 'session' : 'weekly', percent, severity: null, resetsAt, isActive: true, modelName, surface: null };
}

function usage(fiveH: number, sevenD: number, fable: number): UsageData {
	return {
		fiveHour: null, sevenDay: null, sevenDaySonnet: null, sevenDayOpus: null, sevenDayOauthApps: null,
		limits: [
			limit('session', fiveH, inHours(3)),
			limit('weekly_all', sevenD, inHours(48)),
			limit('weekly_scoped', fable, inHours(1), 'Fable'),
		],
		extraUsage: null,
		fetchedAt: new Date(),
	};
}

// Hand-built usage data — no live API call.
suite('Blocked takeover (#20)', () => {
	const cfg = () => vscode.workspace.getConfiguration('claude-usage-monitor');
	const set = (value: unknown) => cfg().update('statusBarBlockedBy', value, vscode.ConfigurationTarget.Global);

	suiteTeardown(() => set(undefined));

	test('a maxed-out model does not take over by default', async () => {
		await set(undefined);
		assert.deepStrictEqual(readBlockedBy(), ['5h', '7d']);
		assert.strictEqual(blockedWindow(usage(40, 70, 100), readBlockedBy()), null);
	});

	test('5h wins over 7d by list order, not reset time', () => {
		assert.strictEqual(blockedWindow(usage(100, 100, 0), ['5h', '7d'])?.key, '5h');
		assert.strictEqual(blockedWindow(usage(100, 100, 0), ['7d', '5h'])?.key, '7d');
	});

	test('[] never takes over', async () => {
		await set([]);
		assert.deepStrictEqual(readBlockedBy(), []);
		assert.strictEqual(blockedWindow(usage(100, 100, 100), readBlockedBy()), null);
	});

	test('model keys match case-insensitively', () => {
		assert.strictEqual(blockedWindow(usage(40, 70, 100), ['5h', '7d', 'model:fable'])?.name, 'Fable');
	});

	test('* means any window, soonest reset first', () => {
		// Fable resets in 1h, the session in 3h.
		assert.strictEqual(blockedWindow(usage(100, 70, 100), ['*'])?.name, 'Fable');
	});

	test('a key the account does not report is skipped', () => {
		assert.strictEqual(blockedWindow(usage(40, 100, 0), ['model:Gone', '7d'])?.key, '7d');
	});

	test('a non-array setting falls back to the default', async () => {
		await set('off');
		assert.deepStrictEqual(readBlockedBy(), ['5h', '7d']);
	});
});
