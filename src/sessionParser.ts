import * as fs from "fs";
import * as readline from "readline";
import { ClaudeMessage, MessageUsage } from "./types";

/**
 * Parse a Claude JSONL session file and extract messages with usage data
 */
export async function parseSessionFile(filePath: string): Promise<ClaudeMessage[]> {
  const messages: ClaudeMessage[] = [];

  try {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) {
        continue; // Skip empty lines
      }

      try {
        const parsed = JSON.parse(line);

        // Skip non-message entries (summaries, etc.)
        if (parsed.type === "summary" || !parsed.message) {
          continue;
        }

        // Extract relevant fields from the nested message structure
        const msg = parsed.message;
        const message: ClaudeMessage = {
          id: msg.id || parsed.uuid || "",
          timestamp: parsed.timestamp || new Date().toISOString(),
          role: msg.role || "user",
          usage: msg.usage
            ? {
                input_tokens: msg.usage.input_tokens || 0,
                cache_creation_input_tokens: msg.usage.cache_creation_input_tokens || 0,
                cache_read_input_tokens: msg.usage.cache_read_input_tokens || 0,
                output_tokens: msg.usage.output_tokens || 0,
              }
            : undefined,
        };

        messages.push(message);
      } catch (err) {
        console.warn(`Failed to parse line in ${filePath}:`, err);
      }
    }
  } catch (err) {
    console.error(`Failed to read session file ${filePath}:`, err);
  }

  return messages;
}

/**
 * Calculate total tokens from message usage
 */
export function calculateTokensFromUsage(usage: MessageUsage): number {
  return usage.input_tokens + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.output_tokens || 0);
}

/**
 * Extract session ID from file path
 * Example: /path/to/abc123-def456.jsonl -> abc123-def456
 */
export function extractSessionId(filePath: string): string {
  const match = filePath.match(/([^/\\]+)\.jsonl$/);
  return match ? match[1] : "unknown";
}
