import {
  loadEmails,
  chunkEmails,
  reciprocalRankFusion,
  searchWithBM25,
  searchWithEmbeddings,
} from "@/app/search";
import { tool, convertToModelMessages, UIMessage } from "ai";
import { rerankEmails } from "@/app/rerank";
import { z } from "zod";

const NUMBER_PASSED_TO_RERANKER = 30;

export const searchTool = (messages: UIMessage[]) =>
  tool({
    description:
      "Search emails using both keyword and semantic search. Returns metadata with snippets only - use getEmails tool to fetch full content of specific emails.",
    inputSchema: z.object({
      keywords: z
        .array(z.string())
        .describe(
          "Exact keywords for BM25 search (names, amounts, specific terms)"
        )
        .optional(),
      searchQuery: z
        .string()
        .describe(
          "Natural language query for semantic search (broader concepts)"
        )
        .optional(),
    }),
    execute: async ({ keywords, searchQuery }) => {
      console.log("Keywords:", keywords);
      console.log("Search Query:", searchQuery);

      const emails = await loadEmails();

      const emailChunks = await chunkEmails(emails);

      const bm25Results = keywords
        ? await searchWithBM25(keywords, emailChunks)
        : [];

      const embeddingsResults = searchQuery
        ? await searchWithEmbeddings(searchQuery, emailChunks)
        : [];

      const rrfResults = reciprocalRankFusion([
        bm25Results.slice(0, NUMBER_PASSED_TO_RERANKER),
        embeddingsResults.slice(0, NUMBER_PASSED_TO_RERANKER),
      ]);

      const conversationHistory = convertToModelMessages(messages).filter(
        (m) => m.role === "user" || m.role === "assistant"
      );

      const query = [keywords?.join(" "), searchQuery]
        .filter(Boolean)
        .join(" ");

      const rerankedResults = await rerankEmails(
        rrfResults.slice(0, NUMBER_PASSED_TO_RERANKER),
        query,
        conversationHistory
      );

      // Return full email objects
      const topEmails = rerankedResults.map((r) => ({
        id: r.email.id,
        subject: r.email.subject,
        body: r.email.chunk,
        score: r.score,
        from: r.email.from,
        to: r.email.to,
      }));

      console.log("Top emails:", topEmails.length);

      return {
        emails: topEmails,
      };
    },
  });
