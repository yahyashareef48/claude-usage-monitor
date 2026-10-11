import * as vscode from 'vscode';
import { UsageData } from './types';
import { accountScopedKey } from './claudeConfig';
import { QuotaWindow, allWindows, resetMs, sameCycle } from './windows';

/**
 * Bounded usage history, used to estimate burn rate and project when a window
 * will run out.
 *
 * Everything here is sized so the store cannot grow without limit:
 *   - fixed slot counts, trimmed on every write (buckets rotate, never append
 *     indefinitely)
 *   - a window's samples are dropped the moment it resets, since a new cycle
 *     makes the old ones meaningless
 *   - windows the API stops reporting are deleted outright
 *   - a hard byte ceiling as a backstop for anything not thought of
 *   - disabling the feature deletes the key, so it costs nothing when off
 */

/** Account-scoped: two accounts must not blend into one burn-rate trend. */
const key = () => accountScopedKey('claudeUsage.history.v3');

const MAX_BUCKETS = 40;            // sparkline resolution
const MAX_RECENT  = 30;            // raw samples kept for the rate fit
const RECENT_MS   = 60 * 60_000;   // …covering at most the last hour
const HARD_CAP    = 64 * 1024;     // absolute ceiling on the serialized store

const MIN_FIT_SAMPLES = 4;
const MIN_FIT_SPAN_MS = 20 * 60_000;
const MIN_FIT_SPREAD  = 3;              // percentages are integers — need real movement
const PATIENT_SPAN_MS = 45 * 60_000;    // …but do not hold out forever on a slow burn
const PATIENT_SPREAD  = 1;

type Sample = [number, number];    // [epoch ms, percent]

interface WindowHistory {
	/** Epoch ms of this cycle's reset, compared with a tolerance — see sameCycle. */
	resetAt: number | null;
	buckets: Sample[];
	recent:  Sample[];
}

export interface Store { v: 3; windows: Record<string, WindowHistory>; }

function empty(): Store { return { v: 3, windows: {} }; }


/** In-memory mirror so readers see the current poll without awaiting the write. */
let cache: Store | null = null;

export function historyEnabled(): boolean {
	return vscode.workspace.getConfiguration('claude-usage-monitor').get<boolean>('burnRate', false);
}

function load(memento: vscode.Memento): Store {
	const raw = memento.get<Store>(key());
	return raw && raw.v === 3 && raw.windows ? raw : empty();
}

/**
 * Drop the in-memory mirror without touching storage, so the next read reloads
 * from whichever key is current. Used when the window switches accounts.
 */
export function resetHistoryCache(): void {
	cache = null;
}

export function getStore(memento: vscode.Memento): Store {
	if (!historyEnabled()) { return empty(); }
	if (!cache) { cache = load(memento); }
	return cache;
}

export async function clearHistory(memento: vscode.Memento): Promise<void> {
	cache = empty();
	if (memento.get(key()) !== undefined) { await memento.update(key(), undefined); }
}

/** A weekly window spans ~7 days, the session window 5 hours. */
function bucketMs(key: string): number {
	return key === '5h' ? (5 * 3_600_000) / MAX_BUCKETS : (7 * 86_400_000) / MAX_BUCKETS;
}

/** Trim until the serialized store fits, oldest buckets of the biggest window first. */
function enforceCap(store: Store): void {
	for (let guard = 0; guard < 500; guard++) {
		if (JSON.stringify(store).length <= HARD_CAP) { return; }
		let biggest: WindowHistory | null = null;
		for (const h of Object.values(store.windows)) {
			if (!biggest || h.buckets.length > biggest.buckets.length) { biggest = h; }
		}
		if (!biggest || biggest.buckets.length === 0) { store.windows = {}; return; }
		biggest.buckets.shift();
	}
	// Should be unreachable; wipe rather than let it grow.
	store.windows = {};
}

export function recordHistory(memento: vscode.Memento, data: UsageData): void {
	if (!historyEnabled()) {
		if (cache === null || Object.keys(cache.windows).length > 0) { void clearHistory(memento); }
		return;
	}

	const store = getStore(memento);
	const now   = Date.now();
	const live  = allWindows(data);
	const alive = new Set(live.map((w) => w.key));

	// Windows the account no longer reports leave nothing behind.
	for (const key of Object.keys(store.windows)) {
		if (!alive.has(key)) { delete store.windows[key]; }
	}

	for (const w of live) {
		let h = store.windows[w.key];
		const resetAt = resetMs(w.resetsAt);
		const lastPct = h && h.recent.length > 0 ? h.recent[h.recent.length - 1][1] : null;
		// A new cycle: the reset moved by more than noise, or usage went backwards.
		if (!h || !sameCycle(h.resetAt, resetAt) || (lastPct !== null && w.pct < lastPct)) {
			h = { resetAt, buckets: [], recent: [] };
			store.windows[w.key] = h;
		}

		h.recent.push([now, w.pct]);
		h.recent = h.recent.filter(([t]) => now - t <= RECENT_MS).slice(-MAX_RECENT);

		const last = h.buckets[h.buckets.length - 1];
		// `now < last[0]` means the system clock moved backwards; open a new
		// bucket rather than getting stuck replacing the same one forever.
		if (!last || now < last[0] || now - last[0] >= bucketMs(w.key)) {
			h.buckets.push([now, w.pct]);
		} else {
			// Keep the bucket's start time — advancing it would slide the window
			// forward on every poll and no new bucket would ever open.
			h.buckets[h.buckets.length - 1] = [last[0], w.pct];
		}
		if (h.buckets.length > MAX_BUCKETS) { h.buckets = h.buckets.slice(-MAX_BUCKETS); }
	}

	enforceCap(store);
	void memento.update(key(), store);
}

/** How many samples exist for a window — 0 means nothing has been recorded. */
export function sampleCount(store: Store, w: QuotaWindow): number {
	return store.windows[w.key]?.recent.length ?? 0;
}

export interface Burn {
	ratePerHour: number;
	/** Epoch ms when the window is projected to hit 100%, or null if never. */
	etaAt: number | null;
}

/**
 * Least-squares slope over the recent samples. Deliberately refuses to answer
 * until the data has moved enough to mean something — percentages are
 * integers, so a two-point slope is mostly quantization noise.
 */
export function burnFor(store: Store, w: QuotaWindow): Burn | null {
	const h = store.windows[w.key];
	if (!h || h.recent.length < MIN_FIT_SAMPLES) { return null; }

	const pts  = h.recent;
	const span = pts[pts.length - 1][0] - pts[0][0];
	if (span < MIN_FIT_SPAN_MS) { return null; }

	const values = pts.map((p) => p[1]);
	const spread = Math.max(...values) - Math.min(...values);

	// Not a single percent in 20 minutes: idle, and say so rather than leaving
	// the row on "measuring…" forever.
	if (spread === 0) { return { ratePerHour: 0, etaAt: null }; }

	// Enough movement to fit, or slow enough that we have waited long enough to
	// stop hedging — a weekly window creeping at 2 %/hr would otherwise never
	// clear the spread threshold at all.
	const enough = spread >= MIN_FIT_SPREAD || (span >= PATIENT_SPAN_MS && spread >= PATIENT_SPREAD);
	if (!enough) { return null; }

	const t0 = pts[0][0];
	const xs = pts.map((p) => (p[0] - t0) / 3_600_000);
	const n  = pts.length;
	const mx = xs.reduce((a, b) => a + b, 0) / n;
	const my = values.reduce((a, b) => a + b, 0) / n;

	let num = 0;
	let den = 0;
	for (let i = 0; i < n; i++) {
		num += (xs[i] - mx) * (values[i] - my);
		den += (xs[i] - mx) ** 2;
	}
	if (den === 0) { return null; }

	const ratePerHour = num / den;
	if (ratePerHour <= 0.1) { return { ratePerHour: 0, etaAt: null }; }

	const remaining = Math.max(0, 100 - w.pct);
	return { ratePerHour, etaAt: Date.now() + (remaining / ratePerHour) * 3_600_000 };
}

/**
 * The percentage series to plot for a window.
 *
 * Buckets only fill one slot per 7.5 min (session) or 4.2 h (weekly), so fall
 * back to the raw recent samples until there are enough buckets — otherwise
 * the chart is empty for the first several minutes.
 */
export function seriesFor(store: Store, w: QuotaWindow): number[] {
	const h = store.windows[w.key];
	if (!h) { return []; }
	const source = h.buckets.length >= 2 ? h.buckets : h.recent;
	return source.map((s) => s[1]);
}

/** The window projected to run out first, and before its own reset. */
export function bindingWindow(store: Store, data: UsageData): { window: QuotaWindow; burn: Burn } | null {
	let best: { window: QuotaWindow; burn: Burn } | null = null;
	for (const w of allWindows(data)) {
		const burn = burnFor(store, w);
		if (!burn || burn.etaAt === null) { continue; }
		if (w.resetsAt && burn.etaAt >= new Date(w.resetsAt).getTime()) { continue; } // resets first
		if (!best || burn.etaAt < best.burn.etaAt!) { best = { window: w, burn }; }
	}
	return best;
}
