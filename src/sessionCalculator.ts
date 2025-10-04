import { ClaudeMessage, SessionMetrics, PlanConfig } from './types';
import { calculateTokensFromUsage } from './sessionParser';

const SESSION_DURATION_MS = 5 * 60 * 60 * 1000; // 5 hours in milliseconds
const BURN_RATE_WINDOW_MS = 10 * 60 * 1000; // Last 10 minutes for burn rate

/**
 * Calculate session metrics from ALL messages across all files
 */
export function calculateSessionMetrics(
	messages: ClaudeMessage[],
	sessionId: string
): SessionMetrics | null {
	if (messages.length === 0) {
		return null;
	}

	const now = new Date();

	// Step 1: Sort all messages by timestamp
	const sortedMessages = [...messages].sort(
		(a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
	);

	// Step 2: Filter to only today's messages
	const startOfToday = new Date(now);
	startOfToday.setHours(0, 0, 0, 0);

	const todayMessages = sortedMessages.filter(msg => {
		const msgTime = new Date(msg.timestamp);
		return msgTime >= startOfToday;
	});

	if (todayMessages.length === 0) {
		return null; // No messages from today
	}

	// Step 3: Group into 5-hour sets starting from the very first message of today
	const sets = groupIntoFiveHourSets(todayMessages);

	if (sets.length === 0) {
		return null;
	}

	// Step 4: Find the last set that overlaps with current time
	// A set overlaps if current time is between startTime and endTime
	const activeSets = sets.filter(set => {
		return now >= set.startTime && now <= set.endTime;
	});

	// Get the last (most recent) overlapping set
	const activeSet = activeSets.length > 0 ? activeSets[activeSets.length - 1] : null;

	if (!activeSet) {
		return null; // No active session - all sets have expired
	}

	// Calculate metrics for the active set
	const startTime = activeSet.startTime;
	const lastMessageTime = activeSet.lastMessageTime;
	const sessionEndTime = activeSet.endTime;
	const timeRemaining = Math.max(0, sessionEndTime.getTime() - now.getTime());
	const isActive = timeRemaining > 0;

	// Calculate token totals for messages in this set
	let totalTokens = 0;
	let inputTokens = 0;
	let cacheCreationTokens = 0;
	let cacheReadTokens = 0;
	let outputTokens = 0;

	for (const message of activeSet.messages) {
		if (message.usage) {
			totalTokens += calculateTokensFromUsage(message.usage);
			inputTokens += message.usage.input_tokens;
			cacheCreationTokens += message.usage.cache_creation_input_tokens || 0;
			cacheReadTokens += message.usage.cache_read_input_tokens || 0;
			outputTokens += message.usage.output_tokens;
		}
	}

	// Calculate burn rate (tokens per minute over last 10 minutes)
	const burnRate = calculateBurnRate(activeSet.messages, now);

	return {
		totalTokens,
		inputTokens,
		cacheCreationTokens,
		cacheReadTokens,
		outputTokens,
		messages: activeSet.messages.length,
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
 * Group messages into 5-hour sets
 * Starting from the first message, create a 5-hour window.
 * Any messages outside that window start a new 5-hour set.
 */
interface SessionSet {
	startTime: Date;
	endTime: Date;
	lastMessageTime: Date;
	messages: ClaudeMessage[];
}

function groupIntoFiveHourSets(messages: ClaudeMessage[]): SessionSet[] {
	if (messages.length === 0) {
		return [];
	}

	const sets: SessionSet[] = [];
	let currentSet: SessionSet | null = null;

	for (const message of messages) {
		const msgTime = new Date(message.timestamp);

		if (!currentSet) {
			// Start first set from the very first message
			currentSet = {
				startTime: msgTime,
				endTime: new Date(msgTime.getTime() + SESSION_DURATION_MS),
				lastMessageTime: msgTime,
				messages: [message]
			};
		} else if (msgTime <= currentSet.endTime) {
			// Message falls within current 5-hour set
			currentSet.messages.push(message);
			currentSet.lastMessageTime = msgTime;
		} else {
			// Message is outside current set - save current and start new set
			sets.push(currentSet);
			currentSet = {
				startTime: msgTime,
				endTime: new Date(msgTime.getTime() + SESSION_DURATION_MS),
				lastMessageTime: msgTime,
				messages: [message]
			};
		}
	}

	// Add the last set
	if (currentSet) {
		sets.push(currentSet);
	}

	return sets;
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
