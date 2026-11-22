# Vendored third-party code

Used by `tests/lib/doc_links.py` (the link check of the external user documents) and by
`scripts/pr-body-lint.sh` (the PR body layout check workers run; it ships with the release, which is
a copy of the whole repository), so neither needs anything installed beyond Python's standard library.

| Package | Version | Licence | Source |
|---|---|---|---|
| `markdown_it` (markdown-it-py) | 3.0.0 | MIT, see `markdown_it/LICENSE` | https://github.com/executablebooks/markdown-it-py |
| `mdurl` | 0.1.2 | MIT, see `mdurl/LICENSE` | https://github.com/executablebooks/mdurl |

Copied unchanged from the Debian / Ubuntu packages `python3-markdown-it` 3.0.0 and
`python3-mdurl` 0.1.2 (`/usr/lib/python3/dist-packages/`); `markdown_it/cli/` (the command
line tool) and `__pycache__/` were left out. Do not edit these files: to update, copy a newer
release over them, keep the two `LICENSE` files, update this table and run
`bash tests/doc-links.test.sh` and `bash tests/client-docs.test.sh`.
