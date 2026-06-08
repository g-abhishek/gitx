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
  - [gitx port](#gitx-port)
  - [gitx implement](#gitx-implement)
  - [gitx pr create](#gitx-pr-create)
  - [gitx pr review](#gitx-pr-review)
  - [gitx pr resolve](#gitx-pr-resolve)
  - [gitx pr merge](#gitx-pr-merge)
  - [gitx pr list](#gitx-pr-list)
  - [gitx pr close](#gitx-pr-close)
  - [gitx pr cherry-pick](#gitx-pr-cherry-pick)
  - [gitx pr port](#gitx-pr-port)
  - [gitx config](#gitx-config)
- [Supported Providers](#supported-providers)
- [Environment Variables](#environment-variables)

---

## Features

| Feature | What it does |
|---------|--------------|
| **AI commit messages** | Generates conventional-commit messages from your staged diff |
| **AI PR descriptions** | Writes PR title + body from your branch commits and diff |
| **AI code review** | Senior-dev quality review with inline comments posted to GitHub/GitLab/Azure (`gitx pr review`) |
| **AI comment resolve** | Reads unresolved review comments, fixes them in code, commits and pushes (`gitx pr resolve`) |
| **AI conflict resolution** | Tries to auto-resolve merge/rebase conflicts; prompts when unsure |
| **AI task implementation** | Takes a plain-English task, plans and applies diffs, commits, pushes, opens PR |
| **gitx ask** | Ask anything about your repo — get answers grounded in live git context |
| **PR cherry-pick** | Pull all commits from any PR into your current branch in one command (`gitx pr cherry-pick`) |
| **PR port** | Port a PR's commits onto multiple target branches and open PRs in one command (`gitx pr port`) |

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

1. **Git provider** — GitHub, GitLab, or Azure DevOps
2. **AI provider** — Anthropic Claude (API key), OpenAI (API key), or local Claude CLI (no key needed)

Config is stored in `~/.config/gitx/config.json` (or the platform-appropriate XDG path).

**Quick config with env vars (no wizard needed):**

```bash
export ANTHROPIC_API_KEY=sk-ant-…   # enables Claude automatically
export OPENAI_API_KEY=sk-…          # enables OpenAI automatically
```

### Azure DevOps authentication

Azure DevOps supports two authentication methods:

| Method | When to use |
|--------|-------------|
| **GCM (recommended)** | Your company uses Git Credential Manager + OAuth (blocks PAT tokens) |
| **PAT** | Personal Access Token — classic approach, works everywhere |

**GCM setup (one time):**

```bash
# 1. Configure git to use OAuth for Azure DevOps
git config --global credential.azreposCredentialType oauth
git config --global credential.https://dev.azure.com.useHttpPath true

# 2. Run gitx setup — choose "Azure DevOps" → "GCM"
gitx config set azure
# gitx verifies your GCM setup and saves authMethod: "gcm" — no token stored
```

With GCM configured, gitx calls `git credential fill` at runtime to obtain a short-lived OAuth token. GCM handles browser login (once) and silent token refresh automatically.

### Jira integration

Connect gitx to Jira so `gitx implement --jira` can read tickets directly:

```bash
gitx config set jira
# Interactive wizard prompts for:
#   • Atlassian base URL  (e.g. https://yourorg.atlassian.net)
#   • Account email
#   • API token          (generate at id.atlassian.com → Security → API tokens)
#   • Default project key (optional, e.g. PROJ — lets you use bare ticket numbers like --jira 123)
```

Config is stored in `~/.config/gitx/config.json` under the `"jira"` key. The API token is redacted in `gitx config show`.

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
gitx push --staged                # commit only already-staged files (skip git add -A)
gitx push --dry-run               # preview without pushing
```

Use `--staged` when you've manually staged a subset of changes with `git add` and want the AI commit message to reflect only those changes.

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

To address review comments before syncing, run `gitx pr resolve <number>` first.

---

### gitx port

Port commits from your current branch onto one or more other branches — the solution to "my lead wants this change on two other branches too."

gitx uses `git cherry` (patch-ID comparison) to detect which commits are already ported, so re-running is always safe and incremental.

```bash
# From your feature branch:
gitx port release/v2                    # port to one branch
gitx port release/v2 hotfix/v1         # port to multiple at once
gitx port release/v2 --base develop    # override base branch detection
gitx port release/v2 --no-pr           # push only, create PRs manually
gitx port release/v2 --draft           # create draft PRs

# After adding more commits — only NEW commits will be ported:
gitx port release/v2                   # incremental: skips already-ported commits

# Conflict resolution:
gitx port --continue                   # after manually fixing conflicts
gitx port --abort                      # abandon a stuck port
```

**What it does per target branch:**
1. Checks `origin/<target>` exists — errors clearly if not
2. On first run: creates `port/<source>-to-<target>` and cherry-picks all commits
3. On re-run: uses `git cherry` to find only NEW commits — skips already-ported ones
4. Conflicts → AI attempts resolution; unresolvable ones pause for manual fix
5. Pushes the port branch, checks for an existing open PR (updates it), or creates a new one with an AI-generated description

---

### gitx implement

Give the AI a task in plain English (or a Jira ticket). It analyzes the repo, creates a step-by-step plan, generates and applies diffs, commits, pushes, and opens a PR.

```bash
# Manual task
gitx implement "add pagination to the users endpoint"
gitx implement "fix the null pointer on login" --mode guided
gitx implement "refactor auth module" --mode plan    # plan only, no code changes
gitx implement "add unit tests for utils" --dry-run  # preview plan, no commits

# Jira-driven (requires gitx config set jira)
gitx implement --jira PROJ-123
gitx implement --jira 123                          # uses configured projectKey
gitx implement --jira PROJ-123 --jira-comment      # post PR URL as comment on ticket
gitx implement --jira PROJ-123 --jira-transition "In Progress"   # move ticket status
gitx implement --jira PROJ-123 --mode auto --jira-comment --jira-transition "In Review"
```

**Autonomy modes:**

| Mode | Behaviour |
|------|-----------|
| `plan` | Analyze and generate a plan — no code changes |
| `guided` | Confirm analysis, plan, and each step's diff before applying |
| `semi-auto` | Confirm once before execution begins |
| `auto` | Fully automatic end-to-end |

**Jira integration** — set up once, then drive all your tickets automatically:

```bash
gitx config set jira     # interactive wizard: URL, email, API token, project key
```

When `--jira` is used, the branch is named `feature/<PROJ-123>-short-description` and the PR title/body include the ticket key and a link to Jira. Pass `--jira-comment` to have gitx post the PR URL back to the ticket, and `--jira-transition` to move the ticket to a new status.

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
gitx pr review 42 --no-comment    # show review locally, don't post to PR
gitx pr review 42 --inline        # force inline comments (skip plain-comment fallback)
```

The review covers: correctness, security, robustness, performance, breaking changes, best practices, test coverage, and documentation. After reviewing, run `gitx pr resolve <number>` to AI-fix the comments in your code.

---

### gitx pr resolve

Read all unresolved review comments on a PR, AI-generate targeted code fixes for each, and apply them.

```bash
gitx pr resolve <number>                  # apply fixes, commit, and push
gitx pr resolve 42 --no-commit           # apply fixes to working tree only — review before committing
gitx pr resolve 42 --no-push            # apply and commit locally, skip push
gitx pr resolve 42 --dry-run            # preview what would be fixed, nothing applied
```

**Typical workflow:**
```bash
gitx pr review 42       # AI reviews and posts inline comments to the PR
# ... read the comments, understand the feedback ...
gitx pr resolve 42      # AI fixes the comments in your code and pushes
```

Use `--no-commit` when you want to inspect the AI-applied diffs with `git diff` before deciding to commit.

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

### gitx pr cherry-pick

Cherry-pick all commits from a PR into the current branch.

Useful when you want to pull someone else's PR work (or a PR targeting a different branch) directly onto your own branch — without merging or waiting for the PR to land.

```bash
gitx pr cherry-pick <number>               # cherry-pick all commits of a PR
gitx pr cherry-pick 42 --dry-run           # list commits without applying
gitx pr cherry-pick 42 --no-confirm        # skip confirmation prompt
```

**What it does:**
1. Fetches the PR's source branch from origin
2. Lists all commits between the PR's base and head (oldest → newest)
3. Cherry-picks them onto your current branch with `-x` (records original SHA)
4. On conflicts: AI attempts resolution — high-confidence fixes are applied automatically; low-confidence ones show a preview and ask for your approval
5. Leaves you ready to review and push: `gitx push`

**Difference from `gitx port`:** `gitx port` moves commits *from* your branch *to* other branches. `gitx pr cherry-pick` pulls commits *from* a PR *into* your current branch.

---

### gitx pr port

Port all commits from a PR onto one or more target branches and open PRs — without touching your current working branch.

```bash
gitx pr port <number> <target1> [target2...]

# Examples:
gitx pr port 12345 release/v1 release/v2
gitx pr port 12345 hotfix/v1 --draft          # create PRs as drafts
gitx pr port 12345 release/v1 --no-pr         # push branch only, skip PR creation
gitx pr port 12345 release/v1 --dry-run       # preview commits without changes
gitx pr port 12345 release/v1 --no-confirm    # skip per-target confirmation
```

**What it does per target branch:**
1. Verifies the target branch exists on origin
2. Creates `port/pr-<number>-to-<target>` from `origin/<target>`
3. Cherry-picks all PR commits (oldest → newest) with `-x` flag
4. AI resolves conflicts automatically where possible
5. Pushes the port branch
6. Opens a PR: `port/pr-<number>-to-<target>` → `<target>`
7. Prints the PR URL

**Summary at the end** shows URLs for all created PRs, any branches pushed without PRs, and any targets skipped due to unresolvable conflicts.

**Difference from `gitx port`:** `gitx port` ports commits *from your current branch* to other branches. `gitx pr port` ports commits *from a specific PR* (by number) to any targets — your working branch is never touched.

---

### gitx config

Manage your gitx configuration.

```bash
gitx config                         # run interactive setup wizard
gitx config setup                   # same as above
gitx config show                    # display current config (secrets redacted)
gitx config set github              # configure GitHub token
gitx config set gitlab              # configure GitLab token
gitx config set azure               # configure Azure DevOps (PAT or GCM)
gitx config set openai              # configure OpenAI API key
gitx config set jira                # configure Jira integration (URL, email, API token)
gitx config set-default-ai claude   # switch AI provider
gitx config set-default-branch main # set default base branch
```

---

## Supported Providers

| Type | Supported |
|------|-----------|
| **Git hosts** | GitHub, GitLab, Azure DevOps |
| **Azure auth** | PAT (Personal Access Token), GCM OAuth (Git Credential Manager) |
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
