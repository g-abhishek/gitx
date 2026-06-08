/**
 * Jira REST API v3 helpers for gitx.
 *
 * All requests use HTTP Basic auth: base64(email:apiToken).
 * No third-party dependencies — uses Node's built-in fetch (Node 18+).
 *
 * Exported helpers used by `gitx implement --jira <ticket-id>`:
 *   fetchJiraTicket()       → load ticket details
 *   addJiraComment()        → post a comment (e.g. PR link)
 *   transitionJiraTicket()  → move ticket to a named status (e.g. "In Progress")
 *   buildTaskFromTicket()   → convert ticket fields into a task string for the AI
 *   resolveTicketId()       → expand "123" to "PROJ-123" using config.projectKey
 */

import type { JiraConfig } from "../types/config.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface JiraTicket {
  /** The Jira issue key, e.g. "PROJ-123" */
  key: string;
  /** Short single-line title */
  summary: string;
  /** Full description (Atlassian Document Format → plain text) */
  description: string;
  /** Acceptance criteria extracted from description or a custom field */
  acceptanceCriteria?: string;
  /** Issue type, e.g. "Bug", "Story", "Task", "Sub-task" */
  type: string;
  /** Current status name, e.g. "To Do", "In Progress", "Done" */
  status: string;
  /** Priority name, e.g. "High", "Medium", "Low" */
  priority: string;
  /** Assignee display name */
  assignee?: string;
  /** Label strings */
  labels: string[];
  /** Subtask summaries */
  subtasks: Array<{ key: string; summary: string; status: string }>;
  /** Full browser URL to the ticket */
  url: string;
}

// ─── Auth helper ──────────────────────────────────────────────────────────────

function basicAuth(email: string, apiToken: string): string {
  return "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
}

// ─── ADF → plain text conversion ─────────────────────────────────────────────
// Atlassian Document Format is a JSON doc tree. We walk it to extract text.

function adfToText(node: unknown, depth = 0): string {
  if (!node || typeof node !== "object") return "";
  const n = node as Record<string, unknown>;

  // Text node
  if (n["type"] === "text" && typeof n["text"] === "string") {
    return n["text"];
  }

  // Recurse into content array
  const content = n["content"];
  if (!Array.isArray(content)) return "";

  const lines: string[] = [];
  for (const child of content) {
    const childType = (child as Record<string, unknown>)["type"];

    if (childType === "paragraph" || childType === "heading") {
      const text = adfToText(child, depth + 1);
      if (text.trim()) lines.push(text.trim());
    } else if (childType === "bulletList" || childType === "orderedList") {
      const listItems = adfToText(child, depth + 1);
      if (listItems.trim()) lines.push(listItems.trim());
    } else if (childType === "listItem") {
      const item = adfToText(child, depth + 1);
      if (item.trim()) lines.push(`• ${item.trim()}`);
    } else if (childType === "codeBlock") {
      const code = adfToText(child, depth + 1);
      if (code.trim()) lines.push(`\`\`\`\n${code.trim()}\n\`\`\``);
    } else if (childType === "blockquote") {
      const quote = adfToText(child, depth + 1);
      if (quote.trim()) lines.push(`> ${quote.trim()}`);
    } else {
      const text = adfToText(child, depth + 1);
      if (text.trim()) lines.push(text.trim());
    }
  }

  return lines.join("\n");
}

function parseDescription(description: unknown): string {
  if (!description) return "";
  if (typeof description === "string") return description;
  // ADF object
  try {
    return adfToText(description).trim();
  } catch {
    return JSON.stringify(description).slice(0, 500);
  }
}

// ─── Fetch a single Jira ticket ───────────────────────────────────────────────

export async function fetchJiraTicket(
  ticketId: string,
  cfg: JiraConfig
): Promise<JiraTicket> {
  const url = `${cfg.url.replace(/\/$/, "")}/rest/api/3/issue/${ticketId}?fields=summary,description,issuetype,status,priority,assignee,labels,subtasks,customfield_10016`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: basicAuth(cfg.email, cfg.apiToken),
        Accept: "application/json",
      },
    });
  } catch (err: unknown) {
    throw new Error(
      `Could not reach Jira at ${cfg.url}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (res.status === 401) {
    throw new Error(
      "Jira authentication failed — check your email and API token in `gitx config set jira`."
    );
  }
  if (res.status === 403) {
    throw new Error(`Jira returned 403 — the account may not have permission to view ${ticketId}.`);
  }
  if (res.status === 404) {
    throw new Error(`Jira ticket "${ticketId}" not found — check the ticket ID and Jira URL.`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Jira API error ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    key: string;
    fields: {
      summary?: string;
      description?: unknown;
      issuetype?: { name?: string };
      status?: { name?: string };
      priority?: { name?: string };
      assignee?: { displayName?: string };
      labels?: string[];
      subtasks?: Array<{
        key: string;
        fields: { summary?: string; status?: { name?: string } };
      }>;
      // Story points (classic) — not used but kept for future
      customfield_10016?: number | null;
    };
  };

  const fields = data.fields;
  const rawDescription = parseDescription(fields.description);

  // Try to extract acceptance criteria section from the description
  let acceptanceCriteria: string | undefined;
  const acMatch = rawDescription.match(/acceptance criteria[:\s]*([\s\S]*?)(?:\n##|\n\*\*|\Z)/i);
  if (acMatch?.[1]?.trim()) {
    acceptanceCriteria = acMatch[1].trim();
  }

  return {
    key: data.key,
    summary: fields.summary ?? "(no summary)",
    description: rawDescription,
    acceptanceCriteria,
    type: fields.issuetype?.name ?? "Task",
    status: fields.status?.name ?? "Unknown",
    priority: fields.priority?.name ?? "Medium",
    assignee: fields.assignee?.displayName,
    labels: Array.isArray(fields.labels) ? fields.labels : [],
    subtasks: (fields.subtasks ?? []).map((s) => ({
      key: s.key,
      summary: s.fields.summary ?? "",
      status: s.fields.status?.name ?? "",
    })),
    url: `${cfg.url.replace(/\/$/, "")}/browse/${data.key}`,
  };
}

// ─── Post a comment on a ticket ───────────────────────────────────────────────

export async function addJiraComment(
  ticketId: string,
  comment: string,
  cfg: JiraConfig
): Promise<void> {
  const url = `${cfg.url.replace(/\/$/, "")}/rest/api/3/issue/${ticketId}/comment`;

  const body = {
    body: {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: comment }],
        },
      ],
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: basicAuth(cfg.email, cfg.apiToken),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to add Jira comment (${res.status}): ${text.slice(0, 200)}`);
  }
}

// ─── Transition a ticket to a named status ────────────────────────────────────

export async function transitionJiraTicket(
  ticketId: string,
  targetStatusName: string,
  cfg: JiraConfig
): Promise<void> {
  // 1. Get available transitions
  const transUrl = `${cfg.url.replace(/\/$/, "")}/rest/api/3/issue/${ticketId}/transitions`;
  const transRes = await fetch(transUrl, {
    headers: {
      Authorization: basicAuth(cfg.email, cfg.apiToken),
      Accept: "application/json",
    },
  });

  if (!transRes.ok) {
    throw new Error(`Could not fetch Jira transitions (${transRes.status})`);
  }

  const transData = (await transRes.json()) as {
    transitions: Array<{ id: string; name: string; to: { name: string } }>;
  };

  // Find a matching transition (case-insensitive)
  const target = targetStatusName.toLowerCase();
  const match = transData.transitions.find(
    (t) =>
      t.name.toLowerCase() === target ||
      t.to.name.toLowerCase() === target
  );

  if (!match) {
    const available = transData.transitions.map((t) => t.to.name).join(", ");
    throw new Error(
      `No transition to "${targetStatusName}" found. Available: ${available}`
    );
  }

  // 2. Execute the transition
  const doRes = await fetch(transUrl, {
    method: "POST",
    headers: {
      Authorization: basicAuth(cfg.email, cfg.apiToken),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ transition: { id: match.id } }),
  });

  if (!doRes.ok && doRes.status !== 204) {
    const text = await doRes.text().catch(() => "");
    throw new Error(`Jira transition failed (${doRes.status}): ${text.slice(0, 200)}`);
  }
}

// ─── Build a task string for the AI from ticket fields ───────────────────────

export function buildTaskFromTicket(ticket: JiraTicket): string {
  const parts: string[] = [];

  parts.push(`[${ticket.key}] ${ticket.summary}`);

  if (ticket.description) {
    parts.push(`\nDescription:\n${ticket.description}`);
  }

  if (ticket.acceptanceCriteria) {
    parts.push(`\nAcceptance Criteria:\n${ticket.acceptanceCriteria}`);
  }

  if (ticket.subtasks.length > 0) {
    const subtaskLines = ticket.subtasks
      .map((s) => `  • [${s.key}] ${s.summary} (${s.status})`)
      .join("\n");
    parts.push(`\nSubtasks:\n${subtaskLines}`);
  }

  if (ticket.labels.length > 0) {
    parts.push(`\nLabels: ${ticket.labels.join(", ")}`);
  }

  return parts.join("\n");
}

// ─── Resolve short ticket IDs ─────────────────────────────────────────────────

/**
 * If the user supplied a bare number ("123") and `config.projectKey` is set,
 * expand it to "PROJ-123". Otherwise return as-is.
 */
export function resolveTicketId(raw: string, cfg: JiraConfig): string {
  if (/^\d+$/.test(raw) && cfg.projectKey) {
    return `${cfg.projectKey}-${raw}`;
  }
  return raw.toUpperCase();
}
