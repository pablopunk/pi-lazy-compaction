# pi-lazy-compaction

<img width="1330" height="1073" alt="lazy compaction arrows" src="https://github.com/user-attachments/assets/52110d6d-c1cd-4d52-8f1e-14abe6407281" />

Lazy background compaction for [pi](https://pi.dev): when the conversation crosses a configurable context threshold, pi summarizes the current branch in the background while you keep typing. When the summary finishes, future model calls see:

```text
summary-through-pinned-boundary + full messages after boundary
```

The active footer/status text is intentionally minimal:

```text
compacting in the background...
```

No slash commands are added; configuration lives in `settings.json`.

## Install from GitHub

```bash
pi install git:github.com/pablopunk/pi-lazy-compaction
# or over SSH
pi install git:git@github.com:pablopunk/pi-lazy-compaction.git
```

Then restart pi or run:

```text
/reload
```

## Configuration

Add this to `~/.pi/agent/settings.json`:

```json
{
  "lazyCompaction": {
    "enabled": true,
    "thresholdPercent": 80
  }
}
```

Project-local config is also supported in `.pi/settings.json` for trusted projects.

### Options

```json
{
  "lazyCompaction": {
    "enabled": true,
    "thresholdPercent": 80,
    "summarizer": "anthropic/claude-sonnet-4-5"
  }
}
```

or:

```json
{
  "lazyCompaction": {
    "enabled": true,
    "thresholdPercent": 80,
    "summarizer": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-5"
    }
  }
}
```

- `enabled`: enables/disables lazy compaction. Defaults to `false`.
- `thresholdPercent`: context usage percent that triggers compaction. Defaults to `80`.
- `summarizer`: optional model for summaries. If omitted, lazy compaction uses the current conversation model.

The summarizer must be available in pi and authenticated. If the configured summarizer is unavailable or unauthenticated, the extension falls back to the current conversation model when possible.

## Recommended pi compaction setting

Lazy compaction is independent from pi's built-in auto-compaction. To avoid pi's built-in blocking compaction path, you may want to disable built-in auto-compaction and let this extension handle it:

```json
{
  "compaction": {
    "enabled": false
  },
  "lazyCompaction": {
    "enabled": true,
    "thresholdPercent": 80
  }
}
```

Manual `/compact` remains pi's built-in command.

## How it works

On `agent_end`, the extension estimates current session context usage. Once usage crosses `thresholdPercent`, it pins the current leaf entry as the boundary and starts a detached summarization job without calling `ctx.compact()`.

After the summary completes, it appends a compaction entry directly with `firstKeptEntryId` set to the first current-branch entry after the pinned boundary. Future provider requests are adjusted through pi's `context` hook so the model receives the new compacted shape.

## Notes

- Extensions run with your full system permissions. Review code before installing third-party pi packages.
- This package is designed for git installation; no npm publish is required.
- The extension uses pi's package manifest under the `pi.extensions` key.

## License

MIT
