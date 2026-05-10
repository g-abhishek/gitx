# gitx

**AI-powered Git workflow automation CLI and SDK.**

gitx wraps your everyday git operations with AI to generate commit messages, write PR descriptions, review code, resolve merge conflicts, implement tasks from a plain-English prompt, and answer questions about your repo — all from a single CLI.

---

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Configuration](#configuration)
- [Commands](#commands)
  - [gitx ask](#gitx-ask)
  - [gitx commit](#gitx-commit)
  - [gitx push](#gitx-push)
  - [gitx sync](#gitx-sync)
  - [gitx implement](#gitx-implement)
  - [gitx pr create](#gitx-pr-create)
  - [gitx pr review](#gitx-pr-review)
  - [gitx pr fix-comments](#gitx-pr-fix-comments)
  - [gitx pr merge](#gitx-pr-merge)
  - [gitx pr list](#gitx-pr-list)
  - [gitx pr close](#gitx-pr-close)
  - [gitx config](#gitx-config)
- [Supported Providers](#supported-providers)
- [Environment Variables](#environment-variables)

---

## Features

| Feature | What it does |
|---------|--------------|
| **AI commit messages** | Generates conventional-commit messages from your staged diff |
| **AI PR descriptions** | Writes PR title + body from your branch commits and diff |
| **AI code review** | Senior-dev quality review with inline comments posted to GitHub/GitLab/Azure |
| **AI conflict resolution** | Tries to auto-resolve merge/rebase conflicts; prompts when unsure |
| **AI task implementation** | Takes a plain-English task, plans and applies diffs, commits, pushes, opens PR |
| **AI comment addressing** | Reads unresolved review comments and generates targeted fixes |
| **gitx ask** | Ask anything about your repo — get answers grounded in live git context |

---

## Installation

```bash
# Clone and build
git clone https://github.com/g-abhishek/gitx.git
cd gitx
npm install
npm run build

# Link globally so `gitx` is available everywhere
npm link
```

**Requirements:** Node.js ≥ 18

---

## Configuration

Run the interactive setup wizard on first use:

```bash
gitx init
# or equivalently:
gitx config setup
```

The wizard will ask you to configure:

1. **Git provider** — GitHub, GitLab, or Azure DevOps (token, optional org)
2. **AI provider** — Anthropic Claude (API key), OpenAI (API key), or local Claude CLI (no key needed)

Config is stored in `~/.config/gitx/config.json` (or the platform-appropriate XDG path).

**Quick config with env vars (no wizard needed):**

```bash
export ANTHROPIC_API_KEY=sk-ant-…   # enables Claude automatically
export OPENAI_API_KEY=sk-…          # enables OpenAI automatically
```

---

## Commands

### gitx ask

Acts as a smart support assistant that can answer three categories of question — all in one command.

```bash
gitx ask "<question>"
gitx ask "<question>" --pr     # also fetch open PRs for context
```

**1. Setup & diagnostic questions** — answered from your live gitx config (no fabrication):

```bash
gitx ask "is my AI provider set up?"
gitx ask "which AI model am I using?"
gitx ask "do I have a GitHub token configured?"
gitx ask "why isn't gitx working?"
```

**2. Repo state questions** — answered from live git data:

```bash
gitx ask "what did I last commit?"
gitx ask "do I have any unstaged changes?"
gitx ask "show me all open PRs" --pr
gitx ask "do I have any stashed changes?"
```

**3. How-to questions** — answered from the built-in command reference:

```bash
gitx ask "how do I sync my branch with main?"
gitx ask "how do I undo my last commit without losing changes?"
gitx ask "what command creates a PR?"
gitx ask "how do I implement a task with AI?"
```

**Sources the AI draws from:**

- **Live gitx config** — which AI provider is active, whether keys are set, which git providers have tokens (keys are never exposed, only their presence/absence)
- **Live git state** — current branch, last 10 commits, working-tree status, stash list
- **Open PRs** — fetched from the provider API when `--pr` is passed or the question mentions "PR"
- **Built-in command reference** — the full gitx command table is embedded in every prompt

---

### gitx commit

Stage all changes, AI-generate a conventional-commit message from the diff, preview it, and commit.

```bash
gitx commit                    # stage → AI message → confirm → commit
gitx commit -m "feat: …"       # skip AI, use your own message
gitx commit --push             # commit then push to origin
gitx commit --dry-run          # preview the AI message without committing
```

The AI always receives a `git diff --stat` file summary alongside the diff, so it sees every changed file even when the diff is large and gets truncated.

---

### gitx push

Stage → AI-commit → push in one command.

```bash
gitx push
gitx push -b feature/my-branch   # push to a specific branch name
gitx push --dry-run               # preview without pushing
```

---

### gitx sync

Sync your current branch with its base branch. Auto-detects the base branch, fetches from origin, then merges or rebases.

```bash
gitx sync                              # auto-detect base, merge (default)
gitx sync --strategy rebase            # rebase instead of merge
gitx sync --base develop               # explicitly set the base branch
gitx sync --continue                   # resume after manually resolving conflicts
gitx sync --abort                      # cancel an in-progress operation
```

**AI conflict resolution:** When a merge/rebase conflict is detected, gitx asks the AI to resolve it. High-confidence resolutions are applied automatically; low-confidence ones are shown to you for confirmation.

**Pre-sync PR comment check:** If your branch has an open PR with unresolved review comments, gitx will ask whether to address them before syncing. Choosing "Resolve comments first" runs the address workflow, commits the fixes, then the sync rebase/merge picks everything up in a single push.

---

### gitx implement

Give the AI a task in plain English. It analyzes the repo, creates a plan, generates and applies diffs, commits, pushes, and opens a PR.

```bash
gitx implement "add pagination to the users endpoint"
gitx implement "fix the null pointer on login" --mode guided
gitx implement "refactor auth module" --mode plan    # plan only, no code changes
gitx implement "add unit tests for utils" --dry-run  # preview plan, no commits
```

**Autonomy modes:**

| Mode | Behaviour |
|------|-----------|
| `plan` | Analyze and generate a plan — no code changes |
| `guided` | Confirm after every AI step |
| `semi-auto` | Confirm once before execution begins |
| `auto` | Fully automatic end-to-end |

---

### gitx pr create

Stage any uncommitted changes, AI-generate a PR title and body from your branch commits and diff, and open the PR.

```bash
gitx pr create
gitx pr create --title "feat: …" --body "…"   # override AI-generated content
gitx pr create --draft                          # open as draft PR
gitx pr create --dry-run                        # preview without creating
```

---

### gitx pr review

Run a senior-developer quality AI review on an open PR and post the results as formal review comments (inline where supported).

```bash
gitx pr review <number>
gitx pr review 42 --no-comment    # show review locally, don't post to GitHub
gitx pr review 42 --address       # skip review, jump straight to addressing comments
gitx pr review 42 --no-push       # apply fixes locally without pushing
```

The review covers: correctness, security, robustness, performance, breaking changes, best practices, test coverage, and documentation.

---

### gitx pr fix-comments

Read all unresolved review comments on a PR, AI-generate targeted fixes for each, and apply them.

```bash
gitx pr fix-comments <number>
gitx pr fix-comments 42 --dry-run    # preview fixes without applying
gitx pr fix-comments 42 --no-push   # apply locally, skip push
```

---

### gitx pr merge

Merge a pull request via the provider API.

```bash
gitx pr merge <number>
gitx pr merge 42 --strategy rebase       # rebase merge
gitx pr merge 42 --strategy merge        # regular merge commit
gitx pr merge 42 --delete-branch        # delete source branch after merge
gitx pr merge 42 --force                 # skip confirmation prompt
```

Default strategy: `squash`.

---

### gitx pr list

List pull requests for the current repo.

```bash
gitx pr list                    # open PRs (default)
gitx pr list --state closed
gitx pr list --state all
```

---

### gitx pr close

Close (or abandon on Azure DevOps) a pull request.

```bash
gitx pr close <number>
gitx pr close 42 --force    # skip confirmation prompt
```

---

### gitx config

Manage your gitx configuration.

```bash
gitx config                         # run interactive setup wizard
gitx config setup                   # same as above
gitx config show                    # display current config (secrets redacted)
gitx config set github              # configure GitHub token
gitx config set openai              # configure OpenAI API key
gitx config set-default-ai claude   # switch AI provider
gitx config set-default-branch main # set default base branch
```

---

## Supported Providers

| Type | Supported |
|------|-----------|
| **Git hosts** | GitHub, GitLab, Azure DevOps |
| **AI backends** | Anthropic Claude (API), OpenAI GPT-4o, Local Claude CLI |

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key — auto-selects Claude as the AI provider |
| `OPENAI_API_KEY` | OpenAI API key — auto-selects OpenAI as the AI provider |
| `GITX_AI_MODEL` | Override the AI model name (e.g. `claude-opus-4-5`, `gpt-4-turbo`) |
| `GITX_DEBUG=1` | Print full stack traces on errors |

AI provider priority when multiple are configured:
1. `ANTHROPIC_API_KEY` env var → Claude
2. `OPENAI_API_KEY` env var → OpenAI
3. `defaultAiProvider` in config
4. First configured provider entry with a key
5. Auto-detected local `claude` CLI
6. Mock fallback (warns user)

---

## License

MIT
