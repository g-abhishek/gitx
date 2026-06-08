# CLAUDE.md — gitx Architecture & AI Contributor Guide

This file is the authoritative reference for anyone (human or AI) working on the gitx codebase. It describes the architecture, conventions, extension points, and how to keep this file and `README.md` in sync.

---

## Project Overview

**gitx** is an AI-powered Git workflow CLI and Node.js SDK written in TypeScript. It automates the most common git ceremonies — committing, pushing, syncing, PR creation, code review, conflict resolution, and task implementation — by embedding AI at every step.

**Key design goals:**
- Provider-agnostic: works with GitHub, GitLab, and Azure DevOps through a single interface
- AI-agnostic: pluggable AI backends (Anthropic Claude API, OpenAI, local Claude CLI, mock)
- Graceful degradation: every AI call has a non-crashing fallback
- Modular: CLI commands, workflows, providers, and AI clients are fully decoupled

---

## Repository Layout

```
src/
├── bin.ts                   Entry point — calls runCli(process.argv)
├── index.ts                 SDK public exports
│
├── cli/
│   ├── index.ts             Commander program setup & error handler
│   └── commands/
│       ├── ask.ts           gitx ask — free-form repo Q&A
│       ├── commit.ts        gitx commit — AI commit message workflow
│       ├── config.ts        gitx config — setup wizard & config management
│       ├── implement.ts     gitx implement — AI task implementation
│       ├── init.ts          gitx init — alias for config setup
│       ├── port.ts          gitx port — cherry-pick branch commits onto other branches
│       ├── push.ts          gitx push — stage → commit → push
│       ├── sync.ts          gitx sync — branch sync with AI conflict resolution
│       └── pr/
│           ├── index.ts     PR command dispatcher
│           ├── close.ts         gitx pr close
│           ├── create.ts        gitx pr create — AI PR creation
│           ├── resolve.ts       gitx pr resolve — AI-fix review comments in code
│           ├── cherryPick.ts    gitx pr cherry-pick — pull PR commits into current branch
│           ├── port.ts          gitx pr port — port PR commits onto multiple target branches + open PRs
│           ├── list.ts          gitx pr list
│           ├── merge.ts         gitx pr merge
│           └── review.ts        gitx pr review — senior-dev AI review
│
├── workflows/
│   ├── implement.ts         Full task implementation orchestration
│   ├── pr.ts                PR review & resolve workflows
│   └── prAddress.ts         Address PR comments workflow (used by sync + review)
│
├── ai/
│   ├── types.ts             AiClient interface + all request/response types
│   ├── claudeAi.ts          Anthropic Messages API implementation
│   ├── claudeCliAi.ts       Local `claude` CLI wrapper implementation
│   ├── openAiAi.ts          OpenAI Chat Completions implementation
│   ├── mockAi.ts            No-op mock (shown when no AI is configured)
│   ├── localClaudeAi.ts     Backward-compat re-export → claudeCliAi
│   └── reviewHelpers.ts     Shared prompt builders & parsers for review, fix, and ask
│
├── providers/
│   ├── base.ts              GitProvider interface + PullRequest/Comment types
│   ├── factory.ts           createProvider(ctx) factory
│   ├── github.ts            GitHub REST API implementation
│   ├── gitlab.ts            GitLab REST API implementation
│   └── azure.ts             Azure DevOps REST API implementation
│
├── core/
│   ├── gitx.ts              Gitx class — AI resolution cascade, factory, repo context
│   ├── context.ts           RepoContext type
│   └── plugin.ts            GitxPlugin interface
│
├── config/
│   ├── config.ts            loadConfig() / saveConfig()
│   └── schema.ts            Config validation (isGitxConfig guard — no Zod, supports tokenless GCM entries)
│
├── types/
│   ├── config.ts            GitxConfig type
│   ├── modes.ts             AutonomyMode type
│   └── provider.ts          ProviderKind type
│
├── utils/
│   ├── gitOps.ts            All git command wrappers (branch, diff, commit, stat, etc.)
│   ├── git.ts               Low-level git utilities (remote URL, slug inference)
│   ├── azureAuth.ts         Azure DevOps GCM OAuth helpers (getTokenViaGcm, verifyGcmSetup)
│   ├── errors.ts            GitxError class with exit codes
│   ├── lockFile.ts          withLockRetry() for concurrent git ops
│   ├── retry.ts             Generic async retry utility
│   ├── validators.ts        Input validation helpers
│   └── modes.ts             AutonomyMode parsing
│
└── logger/
    └── logger.ts            Colored console output (chalk-based)
```

---

## Core Abstractions

### `AiClient` interface (`src/ai/types.ts`)

Every AI method lives here. All four providers must implement the full interface.

| Method | Used by |
|--------|---------|
| `generateCommitMessage(diff)` | `gitx commit`, `gitx push`, `gitx pr create` |
| `generatePrContent(commits, diff, stat?)` | `gitx pr create` |
| `reviewPR(context)` | Basic review (legacy) |
| `reviewPRDetailed(context)` | `gitx pr review` (senior-dev quality) |
| `generateFix(context)` | `gitx pr resolve`, address workflow |
| `resolveConflict(filePath, content)` | `gitx sync` conflict resolution |
| `analyzeTask(input)` | `gitx implement` |
| `generatePlan(context)` | `gitx implement` |
| `generateDiffs(step)` | `gitx implement` |
| `summarizeChanges(diff)` | `gitx implement` |
| `suggestFixes(comment)` | Legacy fix workflow |
| `ask(question, context)` | `gitx ask` |

**Rule:** Any new AI capability must be added to `AiClient` in `types.ts` first, then implemented in all four providers (`claudeAi.ts`, `openAiAi.ts`, `claudeCliAi.ts`, `mockAi.ts`).

### `GitProvider` interface (`src/providers/base.ts`)

All provider operations (PRs, comments, reviews) go through this interface. Never call a provider's REST API directly from a command — always use the interface.

| Method | Description |
|--------|-------------|
| `listPRs(repoSlug)` | List all PRs |
| `getPR(repoSlug, number)` | Fetch a single PR |
| `createPR(repoSlug, params)` | Open a PR |
| `mergePR(repoSlug, number, strategy)` | Merge a PR |
| `closePR(repoSlug, number)` | Close a PR |
| `getPRDiff(repoSlug, number)` | Get the unified diff |
| `getPRComments(repoSlug, number)` | Fetch review comments + fallback `📍` comments |
| `postReview(repoSlug, number, review)` | Post formal review with inline comments |
| `replyToComment(repoSlug, number, commentId, body)` | Reply to a thread |

### `Gitx` class (`src/core/gitx.ts`)

The main SDK entry point. Responsible for:
- Building the right `AiClient` based on environment + config
- Providing `getRepoContext()` (provider, repoSlug, token)
- Exposing `ai` for direct method calls

**AI selection cascade (highest to lowest priority):**
1. `ANTHROPIC_API_KEY` env var → `ClaudeAi`
2. `OPENAI_API_KEY` env var → `OpenAiAi`
3. `defaultAiProvider` in config
4. First `aiProviders` entry in config with a valid key
5. Auto-detected local `claude` CLI → `ClaudeCliAi`
6. `MockAi` (warns user to configure)

**`isAiAvailable(config)`** is `async` — it runs `ClaudeCliAi.isAvailable()` (which shells out to `which claude`) to mirror step 5 of the cascade. All callers must `await` it. Never replace this with a plain env-var check or it will miss auto-detected CLI providers.

---

## Shared Prompt Helpers (`src/ai/reviewHelpers.ts`)

All non-trivial AI prompt builders and response parsers live here so they are shared across all providers without duplication:

| Export | Purpose |
|--------|---------|
| `buildSeniorReviewSystem()` | System prompt for `reviewPRDetailed` |
| `buildSeniorReviewPrompt(ctx)` | User prompt for `reviewPRDetailed` |
| `parseSeniorReview(raw)` | Parse + validate `AiDetailedReviewResponse` |
| `buildFixSystem()` | System prompt for `generateFix` |
| `buildFixPrompt(ctx)` | User prompt for `generateFix` |
| `parseFixResponse(raw, file, line)` | Parse + validate `AiFixResponse` |
| `buildAskSystem()` | System prompt for `ask` (command reference + setup fix guide) |
| `buildAskPrompt(question, ctx)` | User prompt for `ask` (injects gitx setup status + live git context) |
| `parseAskResponse(raw)` | Parse `AiAskResponse` with plain-text fallback |

**Pattern:** builder functions are pure (no I/O), parser functions never throw (always return a safe default).

---

## Azure GCM Authentication (`src/utils/azureAuth.ts`)

Handles Azure DevOps OAuth authentication via Git Credential Manager. No token is ever written to the gitx config file — GCM is the OS-level secure credential store.

| Export | Purpose |
|--------|---------|
| `getTokenViaGcm(org)` | Calls `git credential fill` to obtain a Bearer token; in-memory cache for the process lifetime |
| `invalidateGcmCache(org?)` | Clears the in-memory cache (called after a 401 to force re-fetch) |
| `decodeJwtExpiry(token)` | Decodes the JWT `exp` claim from an Azure OAuth token (no signature check) |
| `verifyGcmSetup(org)` | Checks git config (`useHttpPath`, `azreposCredentialType`) and does a live token fetch; returns `GcmVerifyResult` with issues + shell fixes |

**Auth flow:**
1. User runs `gitx config set azure` → wizard asks GCM or PAT → saves `authMethod: "gcm"` (no token)
2. Any PR command calls `gitx.getRepoContext()` → detects `authMethod: "gcm"` → calls `getTokenViaGcm(org)` → returns `tokenType: "bearer"`
3. `AzureProvider` constructor receives `tokenType: "bearer"` → sends `Authorization: Bearer <token>` instead of Basic auth
4. On 401, user is directed to run `git pull` to trigger a fresh GCM browser login

**Prerequisites (run once per machine):**
```bash
git config --global credential.azreposCredentialType oauth
git config --global credential.https://dev.azure.com.useHttpPath true
```

---

## git Helpers (`src/utils/gitOps.ts`)

All `git` subprocess calls are centralized here. Use these instead of spawning `git` yourself.

| Export | Command |
|--------|---------|
| `getCurrentBranch(cwd)` | `git rev-parse --abbrev-ref HEAD` |
| `detectBaseBranch(cwd)` | finds true parent branch by scanning all remote refs and picking fewest-commits-ahead |
| `getWorkingDiff(cwd)` | `git diff HEAD` (staged + unstaged) |
| `getWorkingDiffStat(cwd)` | `git diff --stat HEAD` |
| `getBranchDiff(cwd, base)` | `git diff base...HEAD` |
| `getBranchStat(cwd, base)` | `git diff --stat base...HEAD` |
| `getBranchCommits(cwd, base)` | `git log --oneline base..HEAD` |
| `getGitStatus(cwd)` | `git status --short` |
| `getRecentCommits(cwd, n)` | `git log --oneline -n` |
| `getStashList(cwd)` | `git stash list` |
| `getStagedDiff(cwd)` | `git diff --cached` (staged changes only) |
| `getStagedDiffStat(cwd)` | `git diff --cached --stat` |
| `stageAll(cwd)` | `git add -A` |
| `hasStagedChanges(cwd)` | `git diff --cached --name-only` |
| `commitChanges(msg, cwd)` | `git commit -m` |
| `pushBranch(branch, cwd)` | `git push --set-upstream origin` |
| `applyUnifiedDiff(diff, cwd)` | `git apply --3way` |
| `isWorkingTreeDirty(cwd)` | `git status --porcelain` |

---

## Address Workflow (`src/workflows/prAddress.ts`)

The `filterUnresolvedInlineComments()` function is the **single source of truth** for deciding which PR comments still need attention. It:
- Keeps only root comments (no `inReplyToId`) that have a `path` and `line`
- Excludes comments that already have a `"✅ Addressed"` reply from the bot

**Address modes:**
- `interactive` — user approves each fix, then pushes
- `commit-no-push` — commits fixes without pushing
- `no-push` — applies fixes locally only

> **Note:** The dedicated command for addressing review comments is `gitx pr resolve`, which uses `runFixCommentsWorkflow` in `workflows/pr.ts` directly. `prAddress.ts` is retained as a shared utility for any future internal use.

---

## PR Comment Parsing (`src/providers/github.ts`)

GitHub sometimes rejects inline review comments (422 "Line could not be resolved"). In that case, the gitx bot posts a plain issue comment formatted as:

```
📍 **`path/to/file:123`**

<comment body>
```

`getPRComments()` detects this format in issue comments and reconstructs `path`, `line`, and the real `body`, so the rest of the codebase sees them identically to real inline comments.

---

## Conventions

### TypeScript
- **Strict mode** enabled (`tsconfig.json`)
- `import type` for type-only imports (enforced by ESLint)
- NodeNext module resolution — all local imports use `.js` extensions even in `.ts` files
- No `any` without a comment explaining why

### AI prompts
- All AI responses must be **valid JSON** — use `parseJson<T>(text, fallback)` which never throws
- System prompts describe the task; user prompts inject the concrete data
- Include a `Respond with ONLY valid JSON (no markdown fences):` instruction in every system prompt
- Add a token-saving fallback: truncate large inputs with `slice(0, N)`, and always pass `git diff --stat` alongside truncated diffs so the AI sees every file name

### Error handling
- Throw `GitxError` (not `Error`) for user-facing failures — it carries an `exitCode`
- Non-fatal failures (AI generation, PR fetching) must fall back gracefully and warn
- The CLI top-level error handler (`src/cli/index.ts`) formats `GitxError` cleanly; unknown errors fall through to the generic handler

### Spinners & output
- Use `ora()` spinners for any async operation > ~500ms
- Use `logger.info/warn/error` (not `console.log`) for output
- `GITX_DEBUG=1` enables full stack traces via `console.error`

---

## Adding a New Command

1. Create `src/cli/commands/<name>.ts` with a `register<Name>Command(program)` export.
2. Register it in `src/cli/index.ts`.
3. If the command needs a new AI capability, add the method to `AiClient` in `src/ai/types.ts` first, then implement it in all four providers.
4. If the command needs new git operations, add them to `src/utils/gitOps.ts`.
5. Update both `README.md` (user-facing docs) and this `CLAUDE.md` (architecture docs).

---

## Adding a New AI Provider

1. Create `src/ai/<name>Ai.ts` implementing the full `AiClient` interface.
2. Register it in the `Gitx.buildAi()` cascade in `src/core/gitx.ts`.
3. Add the provider kind to `AiProviderKind` in `src/types/config.ts`.
4. Update the config wizard in `src/cli/commands/config.ts` to offer the new provider.
5. Update `README.md` Supported Providers table and this file.

---

## Adding a New Git Provider

1. Create `src/providers/<name>.ts` implementing the full `GitProvider` interface.
2. Add a case to `createProvider()` in `src/providers/factory.ts`.
3. Add the provider kind to `ProviderKind` in `src/types/provider.ts`.
4. Update `detectProviderFromRemote()` in `src/utils/git.ts` to recognize the new remote URL pattern.
5. Update `README.md` Supported Providers table and this file.

---

## Keeping README.md and CLAUDE.md in Sync

**Rule:** Any time you change a command's flags, add/remove a command, add an AI method, change a key data type, or change the architecture, update both files in the same commit.

| Change | README.md section | CLAUDE.md section |
|--------|-------------------|-------------------|
| New command | Commands table + new section | Repository Layout + Adding a New Command |
| New flag on existing command | That command's section | (if the flag changes architecture) Core Abstractions |
| New AI method | (none, internal) | AiClient interface table |
| New git helper | (none, internal) | git Helpers table |
| New util file | (none, internal) | Repository Layout utils tree |
| New provider (git or AI) | Supported Providers | Adding a New Provider section |
| New auth method on existing provider | Configuration section (Azure section) | Azure GCM Authentication |
| New shared prompt helper | (none, internal) | Shared Prompt Helpers table |
| Environment variable | Environment Variables | Environment Variables |
| Config key | Configuration section | (as needed) |
| `isAiAvailable` behaviour change | (none) | Gitx class cascade note |

---

## Build & Development

```bash
npm install          # install dependencies
npm run build        # tsc compile + shebang postprocess → dist/
node dist/bin.js --help

# Watch mode (if configured):
npx tsc --watch

# Debug a specific command:
GITX_DEBUG=1 node dist/bin.js ask "what did I last commit?"
```

**TypeScript config:** `ES2022` target, `NodeNext` module resolution, strict mode. All compiled output goes to `dist/`.

The `scripts/postbuild-shebang.mjs` script adds `#!/usr/bin/env node` to `dist/bin.js` so it can be executed directly after `npm link`.
