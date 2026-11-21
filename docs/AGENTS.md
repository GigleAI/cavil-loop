# docs/AGENTS.md

Rules for the **external user documents** — the pages people outside this repo read to install,
configure and use cavil-loop. Read this before editing any of them. It is written for agents and
exists in English only (like the root [AGENTS.md](../AGENTS.md)); the rest of the root AGENTS.md still
applies.

## Which files these rules cover

| Covered (external user documents) | Not covered (internal, keep their history) |
|---|---|
| `README.md` / `README.zh.md` | `docs/retrospectives/` — reports written by the post-merge retrospective |
| `CONTRIBUTING.md` / `CONTRIBUTING.zh.md` | `docs/design/` — mock-ups that old issue comments link to by URL |
| every `*.md` directly under `docs/` (one English + one `.zh.md` copy each), except this file | every `AGENTS.md`, including this one |
| their pictures: `docs/images/`, `docs/client-screens/`, `docs/logo/`, `docs/github_project.png` (the README's first picture) | `prompts/` and `.agents/` (templates, `lessons.md`, `review.extra.md`) |

The list is computed in one place, `external_docs` in `tests/lib/doc_links.py`; the checks below
use it. A new page directly under `docs/` is covered automatically — give it both language copies.

## How to write them

- **Say how it works now.** No history of how it got there: no "at first … later changed to …",
  no "since GitHub#N", no "before the rename it was …". A compatibility fact that still holds is
  stated as a present fact ("installs from before the rename keep the path X working"), without
  the story behind it.
- **No issue or PR numbers** (`GitHub#N`, `PR #N`, `#N` pointing at this repo's work). A link
  to an issue a reader should follow today (for example a feature still in progress) is fine.
- **Core outside, details folded.** Under each heading, one to three sentences a reader can stop
  at: what it is, whether it is on by default, how to turn it on or off. Rules, edge cases,
  long commands and long tables each go into their own folded block:

  ```html
  <details><summary>Details: what happens when the read fails</summary>

  …markdown…

  </details>
  ```

  Leave the blank line after `<summary>…</summary>` — without it GitHub does not render the
  markdown inside.
- **Headings never go inside a folded block.** `##` / `###` headings are link targets (other
  docs, templates and AGENTS.md link to them); a heading inside `<details>` is hidden until
  someone opens the block.
- **Both languages say the same thing.** Change `x.md` and `x.zh.md` in the same commit.

## Where the reasons go

Design reasons, rejected alternatives and the history of a behaviour belong in the root
[AGENTS.md](../AGENTS.md) or in a comment next to the code — not in these documents. Agents
reading AGENTS.md need that trail; a user reading the docs does not.

## When a document must change

- A change to anything a user can see — behaviour, a default, a setting, a command, a label —
  updates the matching external document, both languages, in the same PR.
- Renaming or removing a heading means updating every link to it in the whole repository
  (other docs, `prompts/`, every AGENTS.md) in the same PR. The link check below finds them.
- A command block that a test runs verbatim (wrapped in `<!-- …:begin -->` / `<!-- …:end -->`
  markers) is moved as a whole and changed in both languages together; the tests compare the
  two copies.
- The explainer diagrams in `docs/images/` are generated: change `scripts/doc-diagrams/gen.py`,
  run `python3 scripts/doc-diagrams/gen.py`, commit the output.

## Checks

| What | Where | Run |
|---|---|---|
| Every relative link and `#anchor` in the external documents resolves; so do the links in `prompts/`, `.agents/` and every AGENTS.md that point at them; every external document has its other-language copy | `tests/doc-links.test.sh` (parser: `tests/lib/doc_links.py`, shared with `tests/client-docs.test.sh`) | `bash tests/doc-links.test.sh` |
| The client guide's screenshots, structure and network-boundary wording | `tests/client-docs.test.sh` | `bash tests/client-docs.test.sh` |
| The diagrams equal the generator's output, animate correctly, and each page references its own language's pictures | `tests/doc-diagrams.test.sh` | `bash tests/doc-diagrams.test.sh` |
| The orchestration guide names only real settings, and its example commands run as written | `tests/orchestration-docs.test.sh` | `bash tests/orchestration-docs.test.sh` |
| No issue / PR number in any external document (`GitHub#N`, `PR #N`, `owner/repo#N`, a parenthesised `(#N)`), command blocks included; internal files keep theirs | `tests/doc-numbers.test.sh` (`--numbers`, the `NUMBER` pattern in `tests/lib/doc_links.py`) | `bash tests/doc-numbers.test.sh` |

All of them are `# kind: guard` tests: they run in `bash tests/run.sh --quick`, on every PR and
in the pre-commit hook.

The number check deliberately lets two forms through, because telling them from a history
reference needs a reader: a bare `#42` (the README's worked example, a search example, "sort key
#1") and a link whose text is the number (`[#628](https://github.com/…/issues/628)`, a feature
still in progress). The reviewer checks those by reading.

The "no history narrative" rule is **not** checked by a text test: phrases like "at first" or
"后来" appear in plenty of legitimate sentences, and every pattern tried raised more false alarms
than real hits. The reviewer checks it by reading.
