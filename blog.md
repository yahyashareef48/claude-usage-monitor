# How to Track Claude Token Usage in Real Time with a VS Code Extension

## 1: Setting Up the Status Bar with Custom Icons

### The Challenge

I wanted to build a VS Code extension that monitors Claude Code token usage with a clean, recognizable icon in the status bar. Simple enough, right? Not quite.

### The Icon Problem

VS Code status bars don't support custom SVG icons directly. You're limited to:

- Built-in codicons (like `$(sparkle)`, `$(hubot)`)
- Text/Unicode/Emoji characters

But I wanted the actual Claude icon - that distinctive geometric pattern that represents the AI.

### The Solution: Custom Icon Fonts

After research, I discovered VS Code's `contributes.icons` API allows custom icons via **font files**. Here's the process:

1. **Convert SVG to Font**: Used [Glyphter.com](https://www.glyphter.com/) to convert the Claude SVG logo into a `.woff` font file
2. **Map to Character**: Glyphter mapped the icon to the "^" character (`\005E` in Unicode)
3. **Register in package.json**:

```json
"contributes": {
  "icons": {
    "claude-icon": {
      "description": "Claude AI icon",
      "default": {
        "fontPath": "./resources/Glyphter.woff",
        "fontCharacter": "\\005E"
      }
    }
  }
}
```

4. **Use in Status Bar**:

```typescript
statusBarItem.text = "$(claude-icon)";
statusBarItem.show();
```

### Key Learnings

- VS Code extensions can't use SVG directly in status bars
- Custom icons require conversion to font format (.woff, .ttf)
- The icon ID in package.json must match the syntax in code: `$(icon-id)`
- Status bar alignment: `Left` vs `Right` matters for UX

### What's Next

- Implement actual token usage monitoring
- Add click handler to show detailed metrics
- Parse Claude's local JSONL session files
- Calculate costs and burn rates

### Tech Stack

- TypeScript
- VS Code Extension API
- Custom icon fonts via Glyphter
- Status bar API for persistent UI presence
