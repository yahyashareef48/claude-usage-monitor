# Token Calculation Investigation

**Status:** 🔍 In Progress
**Started:** 2025-10-04
**Priority:** High

## Problem Summary

Extension is calculating token usage that's ~2.5x higher than what `ccusage` reports:

- **Our calculation**: 103,285 tokens (Input: 7,555 + Output: 95,730)
- **ccusage (v15.2.0)**: 40,203 tokens (Input: 7,655 + Output: 32,548)

Claude Code is still working even though we show usage over the 44k Pro limit, indicating our calculation is wrong.

## Key Findings

### 1. Cache Tokens Do NOT Count Toward Limits ✅

After extensive research and testing:
- **Only `input_tokens` + `output_tokens` count toward the 44k/88k/220k limits**
- `cache_creation_input_tokens` and `cache_read_input_tokens` are NOT counted
- This is confirmed by user's Claude Code still working at "103k" usage

### 2. ccusage Has a Known Bug (Fixed in v17+)

- User is running ccusage v15.2.0 (outdated)
- GitHub Issue #274: `getTotalTokens()` calculated incorrectly in v15
- PR #309 (merged July 19, 2025) fixed it in v17.0.0+
- **v15 only counts input+output** (the bug)
- **v17+ counts all four token types** (the fix)

However, since cache tokens don't count toward limits, **v15's behavior is actually correct for session limits!**

### 3. Message Deduplication Required ✅

Discovered messages appear multiple times across files:
- **Total messages collected**: 10,240
- **After deduplication by ID**: 6,604 unique messages
- **Removed ~3,600 duplicates** (35% were duplicates!)

Deduplication logic added:
```typescript
const uniqueMessages = Array.from(
  new Map(messages.map(m => [m.id, m])).values()
);
```

### 4. Session Windowing Logic Fixed ✅

**Original Problem**: Extension was using first message EVER as session start, not first message of current 5-hour window.

**Solution Implemented**:
1. Filter messages to only today (00:00:00 onwards)
2. Group into 5-hour sets starting from first message of each set
3. Find the last set that overlaps with current time
4. Return null if no set overlaps (session expired)

```typescript
function groupIntoFiveHourSets(messages: ClaudeMessage[]): SessionSet[] {
  // Messages outside 5-hour window start new set
  if (msgTime > currentSet.endTime) {
    sets.push(currentSet);
    currentSet = {
      startTime: msgTime,
      endTime: new Date(msgTime.getTime() + 5 * 60 * 60 * 1000),
      messages: [message]
    };
  }
}
```

### 5. Global vs Per-Project Tracking ✅

**Confirmed**: Claude Code limits are **GLOBAL across ALL projects**, not per-project.

Extension correctly:
- Scans all project directories under `~/.claude/projects/`
- Combines messages from all projects
- Tracks the single active 5-hour session globally

## Remaining Issue: Output Token Discrepancy

**Still unresolved:**
- Our input matches ccusage (7,555 vs 7,655) ✅
- Our output is 3x too high (95,730 vs 32,548) ❌

**Possible causes:**
1. Counting streaming chunks + final message (double/triple counting)
2. Reading wrong messages from session files
3. Different message filtering logic than ccusage
4. Bug in our parsing that counts some messages multiple times

## Current Implementation Status

### Working ✅
- Message deduplication by ID
- Today-only filtering
- 5-hour session window grouping
- Finding active session that overlaps current time
- Cache tokens excluded from total
- Global cross-project tracking

### Not Working ❌
- Output token calculation is 3x too high
- Need to investigate why we're getting 95k output vs 33k

## Next Steps

1. **Add detailed logging** to see every message's output tokens
2. **Compare message IDs** between our parsing and ccusage
3. **Check for streaming messages** - maybe we're counting partial responses
4. **Verify ccusage logic** - clone repo and compare parsing approach
5. **Manual calculation** - Sum output tokens from raw JSONL files to verify ground truth

## Technical Details

### Token Calculation Formula (Confirmed Correct)

```typescript
export function calculateTokensFromUsage(usage: MessageUsage): number {
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  // Cache tokens NOT included - they don't count toward limits
  return inputTokens + outputTokens;
}
```

### Session Files Location

```
~/.claude/projects/{project-dir}/{uuid}.jsonl
```

Example:
```
~/.claude/projects/c--Users-yahya-projects-programing-webdev-personal-projects-claude-usage-monitor/084e0bda-3999-497a-99fb-c53a3f86e742.jsonl
```

### Message Structure

```json
{
  "timestamp": "2025-10-04T12:45:35.675Z",
  "message": {
    "id": "msg_01Gx5gSHNZSKoqGjv4JPsNrZ",
    "role": "assistant",
    "usage": {
      "input_tokens": 4,
      "cache_creation_input_tokens": 11663,
      "cache_read_input_tokens": 5371,
      "output_tokens": 1
    }
  }
}
```

## Debug Session Output (Latest)

```
🔄 Updating metrics...
📊 Collected 10240 total messages
🔄 Total messages: 10240, Unique messages: 6604
📅 Sorted messages: 6604, Today's messages: 669
📦 Created 2 session sets
   Set 1: 10:23:22 AM - 3:23:22 PM (64 messages)
   Set 2: 4:38:57 PM - 9:38:57 PM (605 messages)
⏰ Current time: 7:25:57 PM
✅ Active sets found: 1
🎯 Active set: 4:38:57 PM - 9:38:57 PM with 605 messages
📝 Messages with usage data: 252 out of 605
💰 Token breakdown:
   Input: 7555
   Cache creation: 839432 (not counted toward limit)
   Cache read: 12914244 (not counted toward limit)
   Output: 95730
   TOTAL (toward limit): 103285
```

## References

- [ccusage GitHub Issue #274](https://github.com/ryoppippi/ccusage/issues/274) - Token calculation bug
- [ccusage PR #309](https://github.com/ryoppippi/ccusage/pull/309) - Fix for getTotalTokens
- ccusage source: `/tmp/ccusage/apps/ccusage/src/_token-utils.ts`
