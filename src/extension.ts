import * as vscode from 'vscode';
import { fetchUsageData, setUserAgent, UsageHttpError } from './usageClient';
import { StatusBarManager } from './statusBar';
import { UsagePanel } from './sessionPopover';
import { maybeNotify } from './notifications';
import { recordHistory, resetHistoryCache } from './history';
import { accountScopedKey, affectsAccount } from './claudeConfig';
import { UsageData } from './types';

const CONFIG_SECTION           = 'claude-usage-monitor';
const DEFAULT_POLL_INTERVAL_S  = 120;
const MIN_POLL_INTERVAL_S      = 60;
const MAX_POLL_INTERVAL_S      = 3600;
// The cache is considered fresh for slightly less than one interval, so a
// window whose timer fires a moment early still reuses the previous fetch.
const CACHE_TTL_SLACK_MS       = 5_000;
const BACKOFF_STEPS_MS = [
	4  * 60_000,  // 1st error → wait 4 min
	8  * 60_000,  // 2nd error → wait 8 min
	16 * 60_000,  // 3rd+ error → wait 16 min
];

/** Poll interval from settings, clamped to the documented range. */
function pollIntervalMs(): number {
	const raw = vscode.workspace.getConfiguration(CONFIG_SECTION).get<number>('refreshInterval');
	const seconds = typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULT_POLL_INTERVAL_S;
	return Math.min(MAX_POLL_INTERVAL_S, Math.max(MIN_POLL_INTERVAL_S, seconds)) * 1000;
}

function cacheTtlMs(): number {
	return pollIntervalMs() - CACHE_TTL_SLACK_MS;
}

// Versioned key: pre-1.3.0 builds wrote a UsageData without `limits` to the
// unversioned key. Sharing a key across versions let an older co-installed
// build feed limits-free data to a newer one, blanking the per-model bars.
//
// Account-scoped, and read through a function rather than a const, because the
// configured account can change while the window is open — see claudeConfig.
const cacheKey = () => accountScopedKey('claudeUsage.cache.v2');

interface CacheEntry {
	data:      UsageData | null;
	error:     string | null;
	fetchedAt: number; // Date.now()
	/**
	 * Epoch ms until which the API told us to stay away (`retry-after` on a
	 * 429). Lives in the shared cache so every window honours one block
	 * instead of each of them discovering it again.
	 */
	blockedUntil?: number;
}

function reviveCache(raw: CacheEntry | undefined): CacheEntry | null {
	if (!raw) { return null; }
	// Rehydrate fetchedAt on the nested data object if present
	if (raw.data) {
		raw.data.fetchedAt = new Date(raw.data.fetchedAt);
	}
	return raw;
}

/**
 * Keys written by earlier versions. Bumping a key's version orphans the old
 * blob, which would otherwise sit in global storage forever.
 */
const LEGACY_KEYS = [
	'claudeUsage.cache',
	'claudeUsage.history.v1',
	'claudeUsage.history.v2',
	'claudeUsage.notified.v1',
];

function dropLegacyKeys(memento: vscode.Memento) {
	for (const key of LEGACY_KEYS) {
		if (memento.get(key) !== undefined) { void memento.update(key, undefined); }
	}
}

export function activate(context: vscode.ExtensionContext) {
	setUserAgent(String(context.extension.packageJSON?.version ?? ''));
	dropLegacyKeys(context.globalState);

	const statusBar = new StatusBarManager();
	const panel     = new UsagePanel(context.extensionUri, context.globalState);

	let currentData:  UsageData | null = null;
	let currentError: string | null    = null;
	let errorCount    = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let blockedUntil = 0; // epoch ms, from the API's own retry-after
	// Read the real state: onDidChangeWindowState only fires on a *change*, so a
	// window that activates unfocused would otherwise poll forever believing it
	// is focused. On a machine with several windows open that multiplies every
	// poll, and the usage endpoint is rate limited per account.
	let windowFocused = vscode.window.state.focused;

	function applyState(data: UsageData | null, error: string | null) {
		if (data) { currentData = data; } // keep last good data on error
		currentError = error;
		if (currentData) {
			// Record before rendering so the panel sees this poll in its history.
			recordHistory(context.globalState, currentData);
			statusBar.update(currentData, error);
			panel.update(currentData, error);
			void maybeNotify(context.globalState, currentData);
		} else {
			statusBar.showError(error ?? 'Unknown error');
			panel.update(null, error);
		}
	}

	function scheduleNext() {
		if (!windowFocused) { return; } // don't poll in background

		// A 429 comes with the exact time to wait. Retrying earlier keeps the
		// rate limit window saturated, so the block never lifts. Honour it over
		// both the interval and the backoff.
		const interval = pollIntervalMs();
		const backoff = errorCount === 0
			? interval
			: Math.max(interval, BACKOFF_STEPS_MS[Math.min(errorCount - 1, BACKOFF_STEPS_MS.length - 1)]);
		const untilUnblocked = blockedUntil - Date.now() + 1_000; // clear the boundary
		const delay = Math.max(backoff, untilUnblocked);

		timer = setTimeout(async () => {
			await refresh();
			scheduleNext();
		}, delay);
	}

	async function refresh() {
		const cached = reviveCache(context.globalState.get<CacheEntry>(cacheKey()));

		// Another window (or an earlier poll here) was told to back off. Calling
		// anyway would count against the same account budget and keep the block
		// alive, so show what we have and wait it out.
		if (cached?.blockedUntil && cached.blockedUntil > Date.now()) {
			blockedUntil = cached.blockedUntil;
			applyState(cached.data, cached.error);
			return;
		}

		// Skip the fetch if another window just did it
		if (cached && (Date.now() - cached.fetchedAt) < cacheTtlMs()) {
			errorCount = cached.error ? errorCount : 0;
			applyState(cached.data, cached.error);
			return;
		}

		try {
			const data = await fetchUsageData();
			errorCount = 0;
			blockedUntil = 0;
			const entry: CacheEntry = { data, error: null, fetchedAt: Date.now() };
			await context.globalState.update(cacheKey(), entry);
			applyState(data, null);
		} catch (err) {
			errorCount++;
			const error = err instanceof Error ? err.message : String(err);
			const retryAfterMs = err instanceof UsageHttpError ? err.retryAfterMs : null;
			blockedUntil = retryAfterMs === null ? 0 : Date.now() + retryAfterMs;
			const entry: CacheEntry = { data: null, error, fetchedAt: Date.now() };
			if (blockedUntil > 0) { entry.blockedUntil = blockedUntil; }
			await context.globalState.update(cacheKey(), entry);
			applyState(null, error);
			console.error('[Claude Usage Monitor]', error);
		}
	}

	// On startup: show whatever the shared cache holds immediately.
	const cached = reviveCache(context.globalState.get<CacheEntry>(cacheKey()));
	if (cached) {
		applyState(cached.data, cached.error);
	} else {
		statusBar.showInitializing();
	}

	// Only a focused window fetches. Restoring a session opens every window at
	// once; without this they would all fetch in the same instant, before any of
	// them has written the shared cache the others check. An unfocused window
	// stays idle until onDidChangeWindowState reports focus, which refreshes.
	if (windowFocused) {
		const age = cached ? Date.now() - cached.fetchedAt : Number.POSITIVE_INFINITY;
		const ttl = cacheTtlMs();
		if (age < ttl) {
			// Cache is fresh — delay first fetch to fill remaining TTL
			timer = setTimeout(() => {
				refresh().then(() => scheduleNext());
			}, ttl - age);
		} else {
			refresh().then(() => scheduleNext());
		}
	}

	const onFocus = vscode.window.onDidChangeWindowState((state) => {
		windowFocused = state.focused;
		if (state.focused) {
			// Window came back into focus — cancel any pending timer and refresh immediately
			if (timer) { clearTimeout(timer); timer = null; }
			refresh().then(() => scheduleNext());
		} else {
			// Window lost focus — cancel the pending timer
			if (timer) { clearTimeout(timer); timer = null; }
		}
	});

	// Pointing the window at a different account invalidates everything derived
	// from the old one, so drop it and refetch rather than waiting for the poll.
	const onAccountChange = vscode.workspace.onDidChangeConfiguration((e) => {
		if (!affectsAccount(e)) { return; }
		resetHistoryCache();
		currentData = null;
		if (timer) { clearTimeout(timer); timer = null; }
		statusBar.showInitializing();
		refresh().then(() => scheduleNext());
	});

	const showPopup = vscode.commands.registerCommand('claude-usage-monitor.showPopup', () => {
		panel.show(currentData, currentError);
	});

	// Apply a changed interval without a reload: restart the timer from now.
	const onIntervalChange = vscode.workspace.onDidChangeConfiguration((event) => {
		if (!event.affectsConfiguration(`${CONFIG_SECTION}.refreshInterval`)) { return; }
		if (timer) { clearTimeout(timer); timer = null; }
		scheduleNext();
	});

	const refreshCmd = vscode.commands.registerCommand('claude-usage-monitor.refresh', async () => {
		if (timer) { clearTimeout(timer); timer = null; }
		// Force a real fetch by clearing the cache, unless the API told us to
		// wait: a manual retry during a block costs quota and extends nothing.
		const cached = reviveCache(context.globalState.get<CacheEntry>(cacheKey()));
		const stillBlocked = !!cached?.blockedUntil && cached.blockedUntil > Date.now();
		if (!stillBlocked) { await context.globalState.update(cacheKey(), undefined); }
		await refresh();
		scheduleNext();
	});

	context.subscriptions.push(
		{ dispose: () => { if (timer) { clearTimeout(timer); } } },
		statusBar,
		panel,
		onFocus,
		onAccountChange,
		onIntervalChange,
		showPopup,
		refreshCmd,
	);
}

export function deactivate() {}
