
# pi-async-compaction

> non-blocking compaction for [pi.dev](https://pi.dev/)

<img width="1330" height="1073" alt="async compaction" src="https://github.com/user-attachments/assets/7e39b023-5527-44b2-819d-8bcc703040df" />

## TLDR;

* You set a threshold, e.g., 50%:
* When you reach it, the full context will start to be compacted in the background.
* You can still iterate with the agent; those new messages WILL NOT get compacted.
* Once the compaction finishes, the new context will contain a summary of the compacted context + your new messages in full.

## Install from GitHub

```bash
pi install git:github.com/pablopunk/pi-async-compaction
```

Then restart pi or run:

```text
/reload
```

## Configuration

In `~/.pi/agent/settings.json` (or `.pi/settings.json` for trusted projects):

```json
{
  "asyncCompaction": {
    "enabled": true,
    "thresholdPercent": 80,
    "debug": false
  }
}
```

| Option | Default | Description |
|---|---|---|
| `enabled` | `false` | Enable async compaction |
| `thresholdPercent` | `80` | Context usage % that triggers compaction |
| `debug` | `false` | Show auto-trigger checks and skip reasons in the UI |
| `summarizer` | current model | Optional model, e.g. `"anthropic/claude-sonnet-4-5"` or `{ "provider", "model" }` |

Disable pi's built-in auto-compaction so it doesn't fight with async compaction:

```json
{
  "compaction": { "enabled": false },
  "asyncCompaction": { "enabled": true, "thresholdPercent": 80 }
}
```

Manual `/compact` remains available.

## Commands

### `/async-compaction`

Manually triggers async compaction immediately, regardless of the configured threshold or whether `enabled` is `false`. If a compaction is already running, it cancels it and starts a fresh one.

## How it works

On `agent_end`, the extension estimates current session context usage, falling back to pi's built-in context usage when needed. Once usage crosses `thresholdPercent`, it pins the current leaf entry as the boundary and starts a detached summarization job without calling `ctx.compact()`.

After the summary completes, it appends a compaction entry directly with `firstKeptEntryId` set to the first current-branch entry after the pinned boundary. Future provider requests are adjusted through pi's `context` hook so the model receives the new compacted shape.

### Rolling summary vs async compaction

| | Rolling summary (built-in) | Async compaction |
|---|---|---|
| Non-blocking UI | ❌ | ✅ |
| Suffix messages | ❌ eventually summarized away | ✅ preserved verbatim |
| Provider token cache | ❌ invalidated each time | ✅ warm between compactions |
| Interaction during compaction | ❌ blocked | ✅ fully interactive |

## Related

- [pi.nvim](https://github.com/pablopunk/pi.nvim) - use *pi* on your favorite editor

## License

MIT
