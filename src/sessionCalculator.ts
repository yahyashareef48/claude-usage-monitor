import { ClaudeMessage, SessionMetrics, PlanConfig } from './types';
import { calculateTokensFromUsage } from './sessionParser';

const SESSION_DURATION_MS = 5 * 60 * 60 * 1000; // 5 hours in milliseconds
const BURN_RATE_WINDOW_MS = 10 * 60 * 1000; // Last 10 minutes for burn rate

/**
 * Calculate session metrics from parsed messages
 */
export function calculateSessionMetrics(
	messages: ClaudeMessage[],
	sessionId: string
): SessionMetrics | null {
	if (messages.length === 0) {
		return null;
	}

	// Sort messages by timestamp
	const sortedMessages = [...messages].sort(
		(a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
	);

	const startTime = new Date(sortedMessages[0].timestamp);
	const lastMessageTime = new Date(sortedMessages[sortedMessages.length - 1].timestamp);
	const sessionEndTime = new Date(startTime.getTime() + SESSION_DURATION_MS);
	const now = new Date();
	const timeRemaining = Math.max(0, sessionEndTime.getTime() - now.getTime());
	const isActive = timeRemaining > 0;

	// Calculate token totals
	let totalTokens = 0;
	let inputTokens = 0;
	let cacheCreationTokens = 0;
	let cacheReadTokens = 0;
	let outputTokens = 0;

	for (const message of sortedMessages) {
		if (message.usage) {
			totalTokens += calculateTokensFromUsage(message.usage);
			inputTokens += message.usage.input_tokens;
			cacheCreationTokens += message.usage.cache_creation_input_tokens || 0;
			cacheReadTokens += message.usage.cache_read_input_tokens || 0;
			outputTokens += message.usage.output_tokens;
		}
	}

	// Calculate burn rate (tokens per minute over last 10 minutes)
	const burnRate = calculateBurnRate(sortedMessages, now);

	return {
		totalTokens,
		inputTokens,
		cacheCreationTokens,
		cacheReadTokens,
		outputTokens,
		messages: sortedMessages.length,
		startTime,
		lastMessageTime,
		sessionId,
		sessionEndTime,
		timeRemaining,
		isActive,
		burnRate
	};
}

/**
 * Calculate burn rate (tokens per minute) over the last 10 minutes
 */
function calculateBurnRate(messages: ClaudeMessage[], now: Date): number {
	const windowStart = now.getTime() - BURN_RATE_WINDOW_MS;

	const recentMessages = messages.filter(
		msg => new Date(msg.timestamp).getTime() >= windowStart
	);

	if (recentMessages.length === 0) {
		return 0;
	}

	let totalTokens = 0;
	for (const message of recentMessages) {
		if (message.usage) {
			totalTokens += calculateTokensFromUsage(message.usage);
		}
	}

	const earliestTime = new Date(recentMessages[0].timestamp).getTime();
	const elapsedMinutes = (now.getTime() - earliestTime) / (60 * 1000);

	return elapsedMinutes > 0 ? totalTokens / elapsedMinutes : 0;
}

/**
 * Estimate time to hit token limit based on burn rate
 */
export function estimateTimeToLimit(
	currentTokens: number,
	tokenLimit: number,
	burnRate: number
): number | undefined {
	if (burnRate <= 0 || currentTokens >= tokenLimit) {
		return undefined;
	}

	const remainingTokens = tokenLimit - currentTokens;
	const minutesToLimit = remainingTokens / burnRate;
	return minutesToLimit * 60 * 1000; // Convert to milliseconds
}

/**
 * Format milliseconds to human-readable time
 */
export function formatTimeRemaining(ms: number): string {
	const totalMinutes = Math.floor(ms / (60 * 1000));
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;

	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	return `${minutes}m`;
}

/**
 * Format date to readable string
 */
export function formatDateTime(date: Date): string {
	return date.toLocaleString('en-US', {
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	});
}

/**
 * Get status color based on usage percentage
 */
export function getStatusColor(usagePercent: number): string {
	if (usagePercent >= 80) {
		return '#ff6b6b'; // Red
	} else if (usagePercent >= 60) {
		return '#ffd93d'; // Yellow
	}
	return '#51cf66'; // Green
}
