/**
 * Core types for Claude Usage Monitor
 */

/**
 * Token usage data from a single message
 */
export interface MessageUsage {
	input_tokens: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
	output_tokens: number;
}

/**
 * A single message from Claude JSONL session file
 */
export interface ClaudeMessage {
	id: string;
	timestamp: string; // ISO 8601 format
	role: 'user' | 'assistant';
	usage?: MessageUsage;
}

/**
 * Session metrics and timing information
 */
export interface SessionMetrics {
	// Token counts
	totalTokens: number;
	inputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	outputTokens: number;

	// Session metadata
	messages: number;
	startTime: Date;
	lastMessageTime: Date;
	sessionId: string;

	// Timing
	sessionEndTime: Date; // Predicted end (start + 5 hours)
	timeRemaining: number; // Milliseconds until session ends
	isActive: boolean; // Still within 5-hour window

	// Performance metrics
	burnRate: number; // Tokens per minute
	estimatedTimeToLimit?: number; // Milliseconds until limit hit (if applicable)
}

/**
 * Configuration for token limits based on plan
 */
export interface PlanConfig {
	plan: 'pro' | 'max5' | 'max20' | 'custom';
	tokenLimit: number;
}

/**
 * Overall monitoring state
 */
export interface MonitorState {
	activeSessions: SessionMetrics[];
	totalTokensAcrossAllSessions: number;
	planConfig: PlanConfig;
	lastUpdate: Date;
}
