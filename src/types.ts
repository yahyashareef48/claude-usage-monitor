/**
 * Core types for Claude Usage Monitor
 */

export interface QuotaBucket {
	utilization: number; // percentage 0–100
	resetsAt: string;    // ISO 8601
}

/**
 * One entry of the newer `limits` array — the current source of truth for
 * per-window usage. Parsed generically so new kinds/models keep working.
 */
export interface UsageLimit {
	kind: string;              // e.g. "session", "weekly_all", "weekly_scoped"
	group: string | null;      // e.g. "session", "weekly"
	percent: number;           // 0–100 int
	severity: string | null;   // e.g. "normal" — other values possible
	resetsAt: string | null;   // ISO 8601, may be absent
	isActive: boolean;
	modelName: string | null;  // scope.model.display_name, e.g. "Fable"
	surface: string | null;    // scope.surface
}

export interface ExtraUsage {
	isEnabled: boolean;
	monthlyLimit: number | null;
	usedCredits: number | null;
	utilization: number | null;
	currency: string | null;
}

export interface UsageData {
	fiveHour: QuotaBucket | null;
	sevenDay: QuotaBucket | null;
	sevenDaySonnet: QuotaBucket | null;
	sevenDayOpus: QuotaBucket | null;
	sevenDayOauthApps: QuotaBucket | null;
	/** Newer per-window limits; preferred over the legacy fields when non-empty.
	 *  May be undefined on objects revived from a pre-1.3.0 cache. */
	limits?: UsageLimit[];
	extraUsage: ExtraUsage | null;
	fetchedAt: Date;
	/** Who fetched it: this extension, or Claude Code (read from its saved copy). */
	source?: 'api' | 'claude-code';
}
