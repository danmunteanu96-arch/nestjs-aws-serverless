# Commit Documentation

Keep one short Markdown note per meaningful feature/refactor commit. Store implementation scope, user-visible behavior, architecture/AWS changes, verification commands and operational caveats. Do not duplicate full diffs.

Suggested filename: `YYYY-MM-DD-short-topic.md`.

```markdown
# Commit Topic

Commit: `<short-hash>`

## Summary

What changed and why.

## Architecture and Operations

Affected modules, AWS resources, configuration or migration steps.

## Verification

Commands run and their actual results; include known blockers.
```

See [the NestJS production refactor record](2026-10-14-nestjs-production-refactor.md).
