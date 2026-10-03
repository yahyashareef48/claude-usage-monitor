import * as assert from 'assert';
import * as vscode from 'vscode';
import { blockedWindow, readBlockedBy } from '../windows';
import { StatusBarManager } from '../statusBar';
import { buildFragments } from '../sessionPopover';
import { UsageData, UsageLimit } from '../types';

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

function limit(kind: string, percent: number, resetsAt: string, modelName: string | null = null): UsageLimit {
	return { kind, group: kind === 'session' ? 'session' : 'weekly', percent, severity: null, resetsAt, isActive: false, modelName, surface: null };
}

function usage(fiveH: number, sevenD: number, fable: number, extraPct: number | null = null): UsageData {
	return {
		fiveHour: null, sevenDay: null, sevenDaySonnet: null, sevenDayOpus: null, sevenDayOauthApps: null,
		limits: [
			limit('session', fiveH, inHours(3)),
			limit('weekly_all', sevenD, inHours(48)),
			limit('weekly_scoped', fable, inHours(1), 'Fable'),
		],
		extraUsage: extraPct === null ? null
			: { isEnabled: true, monthlyLimit: 4000, usedCredits: 40 * extraPct, utilization: extraPct, currency: 'USD' },
		fetchedAt: new Date(),
	};
}

const cfg = () => vscode.workspace.getConfiguration('claude-usage-monitor');
const set = (key: string, value: unknown) => cfg().update(key, value, vscode.ConfigurationTarget.Global);
const setBlockedBy = (value: unknown) => set('statusBarBlockedBy', value);

// Hand-built usage data — no live API call.
suite('Blocked takeover (#20)', () => {
	suiteTeardown(() => setBlockedBy(undefined));

	test('a maxed-out model does not take over by default', async () => {
		await setBlockedBy(undefined);
		assert.deepStrictEqual(readBlockedBy(), ['5h', '7d']);
		assert.strictEqual(blockedWindow(usage(40, 70, 100), readBlockedBy()), null);
	});

	test('5h wins over 7d by list order, not reset time', () => {
		assert.strictEqual(blockedWindow(usage(100, 100, 0), ['5h', '7d'])?.key, '5h');
		assert.strictEqual(blockedWindow(usage(100, 100, 0), ['7d', '5h'])?.key, '7d');
	});

	test('the first maxed key wins even when an earlier key is not maxed', () => {
		assert.strictEqual(blockedWindow(usage(40, 100, 100), ['5h', 'model:Fable', '7d'])?.name, 'Fable');
	});

	test('[] never takes over', async () => {
		await setBlockedBy([]);
		assert.deepStrictEqual(readBlockedBy(), []);
		assert.strictEqual(blockedWindow(usage(100, 100, 100, 100), readBlockedBy()), null);
	});

	test('model keys match case-insensitively and ignore surrounding spaces', () => {
		assert.strictEqual(blockedWindow(usage(40, 70, 100), ['5h', '7d', ' model:fable '])?.name, 'Fable');
		assert.strictEqual(blockedWindow(usage(40, 70, 100), ['MODEL:FABLE'])?.name, 'Fable');
	});

	test('* means any window, soonest reset first', () => {
		// Fable resets in 1h, the session in 3h.
		assert.strictEqual(blockedWindow(usage(100, 70, 100), ['*'])?.name, 'Fable');
		assert.strictEqual(blockedWindow(usage(100, 100, 0), ['*'])?.key, '5h');
		// Listed keys before * still take priority.
		assert.strictEqual(blockedWindow(usage(100, 100, 100), ['7d', '*'])?.key, '7d');
	});

	test('a key the account does not report is skipped', () => {
		assert.strictEqual(blockedWindow(usage(40, 100, 0), ['model:Gone', '7d'])?.key, '7d');
	});

	test('99% is not blocked, over 100% is', () => {
		assert.strictEqual(blockedWindow(usage(99, 99, 99), ['*']), null);
		assert.strictEqual(blockedWindow(usage(103, 0, 0), ['5h'])?.key, '5h');
	});

	test('pay-as-you-go only takes over when listed', () => {
		assert.strictEqual(blockedWindow(usage(10, 10, 10, 100), ['5h', '7d']), null);
		assert.strictEqual(blockedWindow(usage(10, 10, 10, 100), ['extra'])?.key, 'extra');
	});

	test('legacy-only data (no limits array) still blocks on 5h', () => {
		const legacy: UsageData = {
			fiveHour: { utilization: 100, resetsAt: inHours(2) }, sevenDay: { utilization: 50, resetsAt: inHours(30) },
			sevenDaySonnet: null, sevenDayOpus: null, sevenDayOauthApps: null, extraUsage: null, fetchedAt: new Date(),
		};
		assert.strictEqual(blockedWindow(legacy)?.key, '5h');
	});

	test('a non-array setting falls back to the default; non-string entries are dropped', async () => {
		await setBlockedBy('off');
		assert.deepStrictEqual(readBlockedBy(), ['5h', '7d']);
		await setBlockedBy(['7d', 5, null]);
		assert.deepStrictEqual(readBlockedBy(), ['7d']);
	});

	test('package.json contributes the setting and drops blockedOverride', () => {
		const ext = vscode.extensions.getExtension('YahyaShareef.claude-code-usage-tracker');
		assert.ok(ext, 'extension found');
		const props = ext.packageJSON.contributes.configuration.properties;
		assert.deepStrictEqual(props['claude-usage-monitor.statusBarBlockedBy'].default, ['5h', '7d']);
		assert.strictEqual(props['claude-usage-monitor.blockedOverride'], undefined);
	});
});

suite('Blocked takeover: status bar (#20)', () => {
	const FORMAT = '{icon} 5h {5h.pct} · 7d {7d.pct}';
	let mgr: StatusBarManager;
	const item = () => (mgr as unknown as { item: vscode.StatusBarItem }).item;
	const bg = () => (item().backgroundColor as vscode.ThemeColor | undefined)?.id;
	const settle = () => new Promise((r) => setTimeout(r, 100));

	suiteSetup(async () => {
		await set('statusBarFormat', FORMAT);
		await set('statusBarIndicator', 'background');
		mgr = new StatusBarManager();
	});

	suiteTeardown(async () => {
		mgr.dispose();
		await set('statusBarFormat', undefined);
		await set('statusBarIndicator', undefined);
		await setBlockedBy(undefined);
	});

	test('Fable at 100% with defaults keeps the custom format', async () => {
		await setBlockedBy(undefined);
		mgr.update(usage(40, 70, 100));
		console.log(`    [bar] ${item().text}`);
		assert.strictEqual(item().text, '$(claude-icon) 5h 40% · 7d 70%');
		assert.strictEqual(bg(), 'statusBarItem.warningBackground', 'colour follows 5h/7d (70% ≥ warning)');
	});

	test('5h and 7d both maxed shows the session block', async () => {
		mgr.update(usage(100, 100, 0));
		console.log(`    [bar] ${item().text}`);
		assert.match(item().text, /^\$\(claude-icon\) blocked · \S/);
		assert.strictEqual(bg(), 'statusBarItem.errorBackground');
	});

	test('only 7d maxed names the window', async () => {
		mgr.update(usage(40, 100, 0));
		console.log(`    [bar] ${item().text}`);
		assert.match(item().text, /^\$\(claude-icon\) 7d blocked · /);
	});

	test('[] keeps the format even with everything maxed, and the bar still turns red', async () => {
		await setBlockedBy([]);
		mgr.update(usage(100, 100, 100));
		console.log(`    [bar] ${item().text}`);
		assert.strictEqual(item().text, '$(claude-icon) 5h 100% · 7d 100%');
		assert.strictEqual(bg(), 'statusBarItem.errorBackground');
	});

	test('changing the setting repaints right away', async () => {
		mgr.update(usage(40, 70, 100));
		assert.ok(!item().text.includes('blocked'));
		await setBlockedBy(['model:Fable']);
		await settle();
		console.log(`    [bar] ${item().text}`);
		assert.match(item().text, /^\$\(claude-icon\) Fable blocked · /);
		await setBlockedBy(undefined);
		await settle();
		assert.strictEqual(item().text, '$(claude-icon) 5h 40% · 7d 70%');
	});

	test('the tooltip still lists the exhausted model', async () => {
		mgr.update(usage(40, 70, 100));
		const tip = item().tooltip;
		const md = typeof tip === 'string' ? tip : tip?.value ?? '';
		assert.ok(md.includes('Fable'), 'tooltip mentions Fable');
		assert.ok(/100%/.test(md), 'tooltip shows 100%');
	});
});

suite('Blocked takeover: Settings tab (#20)', () => {
	const empty = { v: 3 as const, windows: {} };
	const boxes = (html: string) => {
		const block = html.split('id="blocked-by"')[1]?.split('</div>\n')[0] ?? '';
		const out: Record<string, boolean> = {};
		for (const m of block.matchAll(/<input type="checkbox" value="([^"]+)"( checked)? onchange="updateBlockedBy\(\)">/g)) {
			out[m[1]] = !!m[2];
		}
		return out;
	};

	suiteTeardown(() => setBlockedBy(undefined));

	test('default ticks 5h and 7d, not Fable', async () => {
		await setBlockedBy(undefined);
		const b = boxes(buildFragments(usage(40, 70, 100), null, empty).settingsHtml);
		console.log(`    [panel] ${JSON.stringify(b)}`);
		assert.deepStrictEqual(b, { '5h': true, '7d': true, 'model:Fable': false });
	});

	test('[] ticks nothing, * ticks everything', async () => {
		await setBlockedBy([]);
		assert.deepStrictEqual(boxes(buildFragments(usage(40, 70, 100), null, empty).settingsHtml),
			{ '5h': false, '7d': false, 'model:Fable': false });
		await setBlockedBy(['*']);
		assert.deepStrictEqual(boxes(buildFragments(usage(40, 70, 100), null, empty).settingsHtml),
			{ '5h': true, '7d': true, 'model:Fable': true });
	});

	test('a lower-case model key still ticks its box', async () => {
		await setBlockedBy(['model:fable']);
		assert.strictEqual(boxes(buildFragments(usage(40, 70, 100), null, empty).settingsHtml)['model:Fable'], true);
	});

	test('no data shows a hint instead of checkboxes', async () => {
		const html = buildFragments(null, null, empty).settingsHtml;
		assert.ok(html.includes('id="blocked-by"'));
		assert.deepStrictEqual(boxes(html), {});
	});

	test('the old At 100% dropdown is gone', async () => {
		const html = buildFragments(usage(40, 70, 100), null, empty).settingsHtml;
		assert.ok(!html.includes('blockedOverride'));
	});
});
