# pi-async-compaction

- This package intentionally does not use pi's built-in `ctx.compact()` / auto-compaction primitives because they set `session.isCompacting` and queue user messages until compaction finishes; the goal here is true background compaction while conversation continues.
- Bump `version` in `package.json`, then `git tag vX.Y.Z && git push origin vX.Y.Z`
