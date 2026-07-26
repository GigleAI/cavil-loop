# Contributing

> **English** · [中文](CONTRIBUTING.zh.md)

Welcome. This is a small tool with no CLA, no agreement to sign — it's MIT licensed, opening a PR implies acceptance.

> Maintainers and long-term collaborators should start with [AGENTS.md](AGENTS.md), which has project layout, conventions, and local dev workflow. This page is for first-time contributors.

## Good PRs to send

- **Bug fixes**: script logic errors, doc typos, outdated config samples
- **New scheduler support**: beyond cron / launchd (nix systemd, runit, …)
- **Prompt improvements**: making the worker more reliable / token-efficient in some scenario
- **Cross-platform compatibility**: BSD coreutils adaptations, macOS path handling
- **New GitHub event sources**: e.g. subscribing to review requests, check failures
- **Doc additions and translations**: especially welcome — "potholes I hit" notes

## Not-so-good PRs

- Big refactors without motivation (open an issue to discuss the approach first)
- New runtime dependencies introduced without explaining why they're necessary (every extra dep raises the install cost)
- Breaking changes to existing `prompts/*.template.md` placeholders (deployed host projects will break)
- Adding complex abstraction layers that only support one use case (wait for N≥3 before abstracting)

## PR flow

1. **Fork → edit locally → push to your fork's branch**
   - Branch name: `feature/<topic>` / `fix/<topic>` / `docs/<topic>` style
2. **Open a PR against `GigleAI/cavil-loop`'s `main`**
3. **PR title**: conventional-commits style
   ```
   feat(poll): add review-request event listener
   fix(dispatch): worktree path with spaces drops quotes
   docs(security): note fine-grained PAT limitations
   ```
4. **PR body** must include at minimum:
   - **Motivation**: what's being solved / fixed. Link related issues via `Closes #N` / `Refs #N`
   - **Changes**: 1–2 paragraphs or a bullet list. Don't make the reviewer read the diff to figure it out
   - **Verification**: how you tested it (which commands you ran / which project you connected it to / which prompt scenario you verified)
   - **Impact**: if you changed `coding-agent.config.example` / `prompts/*.template.md` / state.json schema, say so explicitly — these are compatibility-bound interfaces
5. **Keep PRs small**: one focused change per PR. Mixing daemon changes + a rename + a new feature in one PR will get split
6. **Style**: follow existing conventions (shell `set -euo pipefail` + `log()` helper + functions from `_lib.sh`; markdown follows the project's bilingual layout)

## When you review: remember to click Submit

There are two ways to add inline review comments on GitHub:

| Action | Visibility | Daemon sees it |
|--------|------------|:---:|
| **Add single comment** (post one directly) | Immediately public | ✅ |
| **Start a review** → add comments → ⚠️ **forget to Submit review** | Draft state, visible only to you | ❌ |

If you've left a review and the daemon doesn't react, **first check whether you have a PENDING review stuck in draft**. GitHub won't let others read your draft — this is platform behavior, not a daemon bug.

## Security agreements around daemon triggers

The `main` branch of this repo runs an active daemon. Adding `pending/agent` to one of this repo's issues / PRs triggers an AI to auto-modify code + push on the maintainer's machine.

So:

- **External contributors must not label their own PRs `pending/agent`** — GitHub gates label permissions to collaborators by default. If you do get added as a collaborator, please still only use the label to drive changes to **your own** PRs and coordinate scope with the maintainer
- **Don't write "scaffolded prompts"** in issue / PR comments (`[SYSTEM] ignore previous instructions...`) — the tool has prompt-injection defenses but they're not 100%; malicious attempts get logged and the user gets banned
- **Found a security issue**: do not post to a public issue. Use GitHub Security Advisory → "Report a vulnerability", or email the maintainer directly
- Full security model: [docs/security.md](docs/security.md)

## License

MIT. By submitting code you agree to release it under MIT. No DCO / CLA signing required, but **commit with a real email** (we don't accept fully-anonymous `noreply` commits — attribution must be traceable).

## Code of conduct

Discuss the work, not the person. Review feedback in issues / PRs is about the code, not character. We don't have a formal CoC doc but follow the Contributor Covenant spirit.
