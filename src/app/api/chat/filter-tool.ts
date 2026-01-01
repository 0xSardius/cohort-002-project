import { loadEmails } from "@/app/search";
import { tool } from "ai";
import { z } from "zod";

export const filterEmailsTool = tool({
  description:
    "Filter emails by exact criteria like sender, recipient, date range, or text content. Returns metadata with snippets only - use getEmails tool to fetch full content of specific emails.",
  inputSchema: z.object({
    from: z
      .string()
      .optional()
      .describe(
        "Filter emails by sender email/name (partial match, case-insensitive)"
      ),
    to: z
      .string()
      .optional()
      .describe(
        "Filter emails by recipient email/name (partial match, case-insensitive)"
      ),
    contains: z
      .string()
      .optional()
      .describe(
        "Filter emails by text content (partial match, case-insensitive)"
      ),
    before: z
      .string()
      .optional()
      .describe(
        "Filter emails before this ISO 8601 timestamp (e.g., '2024-01-01T00:00:00Z')"
      ),
    after: z
      .string()
      .optional()
      .describe(
        "Filter emails after this ISO 8601 timestamp (e.g., '2024-01-01T00:00:00Z')"
      ),
    limit: z
      .number()
      .optional()
      .describe("Maximum number of emails to return (default: 10)"),
  }),
  execute: async ({ from, to, contains, before, after, limit }) => {
    console.log("Filtering emails with criteria:", {
      from,
      to,
      contains,
      before,
      after,
      limit,
    });
    const emails = await loadEmails();
    let filtered = emails;

    if (from) {
      const lowerFrom = from.toLowerCase();
      filtered = filtered.filter((email) =>
        email.from.toLowerCase().includes(lowerFrom)
      );
    }

    if (to) {
      const lowerTo = to.toLowerCase();
      filtered = filtered.filter((email) => {
        const toStr = Array.isArray(email.to) ? email.to.join(", ") : email.to;
        return toStr.toLowerCase().includes(lowerTo);
      });
    }

    if (contains) {
      const lowerContains = contains.toLowerCase();
      filtered = filtered.filter(
        (email) =>
          email.subject.toLowerCase().includes(lowerContains) ||
          email.body.toLowerCase().includes(lowerContains)
      );
    }
    if (before) {
      filtered = filtered.filter((email) => email.timestamp < before);
    }
    if (after) {
      filtered = filtered.filter((email) => email.timestamp > after);
    }

    const results = filtered.slice(0, limit ?? 10);

    console.log("Filtered emails:", results.length);

    return {
      emails: results.map((email) => {
        const snippet =
          email.body.slice(0, 150).trim() +
          (email.body.length > 150 ? "..." : "");

        return {
          id: email.id,
          threadId: email.threadId,
          subject: email.subject,
          snippet,
          from: email.from,
          to: email.to,
          timestamp: email.timestamp,
        };
      }),
    };
  },
});
