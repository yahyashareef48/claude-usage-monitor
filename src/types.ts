/**
 * Core types for Claude Usage Monitor
 */

export interface QuotaBucket {
	utilization: number; // percentage 0–100
	resetsAt: string;    // ISO 8601
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
	extraUsage: ExtraUsage | null;
	fetchedAt: Date;
}
