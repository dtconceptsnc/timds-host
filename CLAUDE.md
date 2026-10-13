@AGENTS.md

Claude Code specifics: `.claude/settings.json` pre-approves the read-only
checks named in AGENTS.md and denies reading `.env`, `.dev.vars` and
`docs/evidence/`. Deployment commands are not pre-approved; they prompt.
