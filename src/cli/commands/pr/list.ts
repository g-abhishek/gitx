import type { Command } from "commander";
import ora from "ora";
import { logger } from "../../../logger/logger.js";
import { Gitx } from "../../../core/gitx.js";
import { createProvider } from "../../../providers/factory.js";
import type { PullRequest } from "../../../providers/base.js";

// ─── Author identity matching ─────────────────────────────────────────────────
//
// provider.getCurrentUser() returns different shapes per provider:
//   Azure  → "Abhishek Gupta"                     (displayName only)
//   GitHub → "Abhishek Gupta (abhishek-gupta)"    (displayName + login)
//   GitLab → "Abhishek Gupta (abhishek.gupta)"    (displayName + username)
//
// The PR author field also differs per provider:
//   Azure  → displayName   e.g. "Abhishek Gupta"
//   GitHub → login         e.g. "abhishek-gupta"
//   GitLab → username      e.g. "abhishek.gupta"
//
// So we extract every identity form from getCurrentUser() and check if the
// PR author field matches ANY of them — handles all three providers correctly.

function extractUserIdentities(raw: string): string[] {
  const ids = new Set<string>();
  const trimmed = raw.trim();

  // Full string (covers Azure exact match)
  ids.add(trimmed.toLowerCase());

  // Part in parentheses → login/username (covers GitHub/GitLab author field)
  const parenMatch = trimmed.match(/\(([^)]+)\)/);
  if (parenMatch?.[1]) ids.add(parenMatch[1].toLowerCase());

  // Part before parentheses → display name
  const namePart = trimmed.replace(/\s*\([^)]+\)/, "").trim();
  if (namePart) ids.add(namePart.toLowerCase());

  return [...ids];
}

function authorMatchesCurrentUser(author: string, currentUser: string): boolean {
  if (!currentUser || !author) return false;
  const authorL = author.toLowerCase();
  // Match if the author field equals or is contained in any identity form,
  // or any identity form is contained in the author field
  return extractUserIdentities(currentUser).some(
    (id) => authorL === id || authorL.includes(id) || id.includes(authorL)
  );
}

// ─── Basic client-side filter (no AI) ────────────────────────────────────────
//
// Handles the most common prompt patterns without calling the AI at all.
// Returns null when the prompt is too complex for basic matching — caller
// should then fall back to the AI filter.
//
// Patterns recognised:
//   "my PRs" / "created by me" / "mine"       → author = currentUser
//   "by amar" / "created by amar" / "author amar" → author contains "amar"
//   "to release/v2" / "targeting release/v2"  → base branch contains value
//   "from feature/x" / "source feature/x"     → head branch contains value
//   "title contains login" / "login in title"  → title contains value

interface BasicFilterResult {
  prs: PullRequest[];
  explanation: string;
}

function tryBasicFilter(
  prs: PullRequest[],
  prompt: string,
  currentUser: string,
): BasicFilterResult | null {
  const q = prompt.trim().toLowerCase();

  // "me" / "my" / "mine" / "I" → match current user
  if (/\b(me|my|mine|by me|created by me)\b/.test(q)) {
    if (!currentUser) return null; // can't resolve without identity
    const matched = prs.filter((p) => authorMatchesCurrentUser(p.author, currentUser));
    return { prs: matched, explanation: `Showing PRs authored by you (${currentUser})` };
  }

  // "by <name>" / "created by <name>" / "author <name>" / "authored by <name>"
  const authorMatch = q.match(/(?:by|created by|author|authored by)\s+([a-z0-9_.\- ]+)/);
  if (authorMatch?.[1]) {
    const name = authorMatch[1].trim();

    // Build normalised variants of the search name to handle different author
    // field formats across providers:
    //   "amar gupta" → also try "amar-gupta" (GitHub) and "amar.gupta" (GitLab)
    const nameVariants = new Set<string>([
      name,
      name.replace(/\s+/g, "-"),  // GitHub: space → hyphen
      name.replace(/\s+/g, "."),  // GitLab: space → dot
      name.replace(/\s+/g, "_"),  // some systems use underscores
    ]);

    const matched = prs.filter((p) => {
      const authorL = p.author.toLowerCase();
      return [...nameVariants].some((v) => authorL.includes(v) || v.includes(authorL));
    });

    // If no matches found with basic substring check, return null so the
    // caller falls through to the AI for smarter fuzzy matching.
    if (matched.length === 0) return null;

    return { prs: matched, explanation: `Showing PRs where author matches "${name}"` };
  }

  // "to <branch>" / "targeting <branch>" / "target <branch>" / "into <branch>"
  const baseMatch = q.match(/(?:to|targeting|target|into|base|merged? into)\s+([\w/.\-]+)/);
  if (baseMatch?.[1]) {
    const branch = baseMatch[1].trim();
    const matched = prs.filter((p) => p.base.toLowerCase().includes(branch));
    return { prs: matched, explanation: `Showing PRs targeting branch "${branch}"` };
  }

  // "from <branch>" / "source <branch>" / "head <branch>"
  const headMatch = q.match(/(?:from|source|head)\s+([\w/.\-]+)/);
  if (headMatch?.[1]) {
    const branch = headMatch[1].trim();
    const matched = prs.filter((p) => p.head.toLowerCase().includes(branch));
    return { prs: matched, explanation: `Showing PRs from branch "${branch}"` };
  }

  // "<word> in title" / "title contains <word>" / "title: <word>"
  const titleMatch = q.match(/(?:title(?:\s+contains?)?[:\s]+|(.+?)\s+in\s+title)([\w ]+)/);
  if (titleMatch) {
    const keyword = (titleMatch[2] ?? titleMatch[1] ?? "").trim();
    if (keyword) {
      const matched = prs.filter((p) => p.title.toLowerCase().includes(keyword));
      return { prs: matched, explanation: `Showing PRs with "${keyword}" in title` };
    }
  }

  return null; // prompt is too complex — caller should use AI
}

// ─── Command ──────────────────────────────────────────────────────────────────

export function registerPrListCommand(pr: Command): void {
  pr.command("list")
    .description("📋 List open pull requests")
    .option("--state <state>", "Filter: open|closed|all", "open")
    .option("--mine", "Show only PRs created by you (no AI needed)")
    .option("--prompt <query>", "Natural-language filter (e.g. 'show PRs by amar' or 'to release/v2')")
    .action(async (options: { state: string; mine?: boolean; prompt?: string }) => {
      const cwd = process.cwd();
      const gitx = await Gitx.fromCwd(cwd);
      const ctx = await gitx.getRepoContext();

      logger.info(`📋 Fetching PRs for ${ctx.repoSlug} (${ctx.provider})…`);

      const provider = createProvider(ctx);
      const needsAll = !!(options.prompt || options.mine);

      // Paginate fully only when filtering — plain list keeps the fast 50-PR default.
      const prs: PullRequest[] = await provider.listPRs(ctx.repoSlug, {
        fetchAll: needsAll,
      });

      // ── State filter ────────────────────────────────────────────────────────
      let filtered =
        options.state === "all"
          ? prs
          : prs.filter((p) => p.state === options.state);

      // ── --mine: instant author filter, no AI ───────────────────────────────
      if (options.mine) {
        const spinner = ora("Resolving your identity…").start();
        const currentUser = await provider.getCurrentUser();
        if (!currentUser) {
          spinner.warn("Could not determine your identity from the provider — showing all PRs.");
        } else {
          filtered = filtered.filter((p) => authorMatchesCurrentUser(p.author, currentUser));
          spinner.succeed(`Showing PRs authored by ${currentUser}`);
        }
      }

      // ── --prompt: basic filter first, AI fallback ──────────────────────────
      if (options.prompt && !options.mine) {
        const currentUser = await provider.getCurrentUser();
        const basic = tryBasicFilter(filtered, options.prompt, currentUser);

        if (basic) {
          // Simple pattern matched — no AI call needed
          filtered = basic.prs;
          logger.info(`🔍 ${basic.explanation}`);
        } else {
          // Complex prompt — send to AI
          const aiAvailable = await Gitx.isAiAvailable(gitx.config);
          if (!aiAvailable) {
            logger.warn("⚠️  No AI configured — --prompt requires an AI provider for complex queries. Run `gitx config setup`.");
          } else {
            const spinner = ora(`🤖 Filtering with AI: "${options.prompt}"…`).start();
            try {
              const result = await gitx.ai.filterPRs(
                filtered.map((p) => ({
                  number: p.number,
                  title: p.title,
                  author: p.author,
                  head: p.head,
                  base: p.base,
                  state: p.state,
                  updatedAt: p.updatedAt,
                })),
                options.prompt,
                { name: currentUser, email: "" },
              );
              const matchedSet = new Set(result.matchedIds);
              filtered = filtered.filter((p) => matchedSet.has(p.number));
              spinner.succeed(`🤖 ${result.explanation}`);
            } catch (err) {
              spinner.warn(`AI filter failed — showing all results. ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }

      // ── Display ─────────────────────────────────────────────────────────────
      if (filtered.length === 0) {
        logger.info(
          options.mine
            ? "No PRs found created by you."
            : options.prompt
            ? `No PRs matched "${options.prompt}".`
            : `No ${options.state} pull requests found.`
        );
        return;
      }

      logger.info(`\nFound ${filtered.length} pull request(s):\n`);
      for (const p of filtered) {
        const stateIcon = p.state === "open" ? "🟢" : p.state === "merged" ? "🟣" : "🔴";
        logger.info(`  ${stateIcon} #${p.number}  ${p.title}`);
        logger.info(`        Branch: ${p.head} → ${p.base}`);
        logger.info(`        Author: ${p.author}  |  Updated: ${new Date(p.updatedAt).toLocaleDateString()}`);
        logger.info(`        URL:    ${p.url}`);
        logger.info("");
      }
    });
}
