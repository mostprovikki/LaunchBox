---
name: leak-check
description: Use when a commit is refused by leak-check, when a side-project repo needs the commit-time leak check, when a false positive needs an allowlist, or before a history scan for secrets. Refuses a commit with the wrong author address, a secret, an Indian ID number, a data file, or an employer reference.
---

# leak-check

One commit-time gate for every side-project repo. The `commit-msg` hook runs
`leak-check.sh`, which refuses the commit when one check fails or cannot run:

| Check | Refuses | Source of truth |
|---|---|---|
| identity | an author or committer email that is not `git config leak-check.email` | the machine's git config, outside the repo |
| data file | a staged `.pdf`, sheet, database, `.tsv`, `.ofx` or `.qif`; a `.csv` outside a test or fixture folder | `leak-check.sh` |
| gitleaks | a secret (gitleaks default rules), a PAN, an IFSC code, an Aadhaar number where the text names it | `gitleaks.toml` |
| employer | an employer reference in the staged lines, the identity or the message | `employer-scan.sh --staged`, outside every repo |

A check that cannot run refuses the commit: no expected address, no gitleaks, no employer
scan, no installed copy. To skip the gate once, on purpose: `git commit --no-verify`.

## Install into a repo

```sh
~/mydevelopment/skills/install.sh <repo> leak-check     # copies this folder to <repo>/.claude/skills/
sh <repo>/.claude/skills/leak-check/hook.sh <repo>        # writes the commit-msg hook (core.hooksPath)
sh <repo>/.claude/skills/leak-check/hook.sh <repo> --check
```

Once per machine:

- `brew install gitleaks` (tested on 8.30.1). Unattended runs need it on their `PATH` too.
- `git config --file ~/.gitconfig-mydevelopment leak-check.email <the noreply address>`.
- The employer scan is `~/.claude/scripts/employer-scan.sh`; another path goes in
  `git config leak-check.employer-scan <path>`.

`hook.sh` refuses to replace a `commit-msg` hook it did not write: merge that by hand.
A repo the owner does not own keeps the copy and the hook untracked (`.git/info/exclude`).

## A false positive

- One line: add the comment `gitleaks:allow` on that line.
- A finding gitleaks reports with a fingerprint: add the fingerprint to `.gitleaksignore`
  at the repo root.
- A data file that must be in git: put it under `tests/` or `fixtures/` (CSV), or commit it
  once with `--no-verify` and say why in the message.

Never weaken `gitleaks.toml` for one repo: it is the same file in every repo.

## Scan the history

```sh
gitleaks git --no-banner --redact -c .claude/skills/leak-check/gitleaks.toml .
zsh ~/.claude/scripts/employer-scan.sh .
```

## Change the check

Edit in the library, run `sh leak-check/test.sh` (each gate is proved red there, and every fake
value is built at run time so the file passes its own gate), commit, install again in each repo.
`check.sh <repo>` fails on drift. Keep these files printable ASCII.

Measured facts this design depends on (gitleaks 8.30.1): the default config's global allowlist
skips `.pdf`, `.xlsx` and `.xls`, so the data-file check lives in `leak-check.sh`; `--pre-commit
--staged` scans the index.
