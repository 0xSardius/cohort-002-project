import fs from "fs/promises";
import path from "path";
import BM25 from "okapibm25";
import { embed, embedMany, cosineSimilarity } from "ai";
import { google } from "@ai-sdk/google";
import {
  ensureEmbeddingsCacheDirectory,
  getCachedEmbedding,
  writeEmbeddingToCache,
} from "@/app/embeddings";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

const CACHE_DIR = path.join(process.cwd(), "data", "embeddings");
const CACHE_KEY = "google-text-embedding-004";
const RRF_K = 60; // rank fusion parameter

export interface Email {
  id: string;
  threadId: string;
  from: string;
  to: string | string[];
  cc?: string[];
  subject: string;
  body: string;
  timestamp: string;
  inReplyTo?: string;
  references?: string[];
  labels?: string[];
  arcId?: string;
  phaseId?: number;
}

export type EmailChunk = {
  id: string;
  subject: string;
  chunk: string;
  index: number;
  totalChunks: number;
  from: string;
  to: string | string[];
  timestamp: string;
};

export const emailChunkToText = (email: EmailChunk) =>
  `${email.subject} ${email.chunk}`;

const textSplitter = new RecursiveCharacterTextSplitter({
  chunkSize: 1000,
  chunkOverlap: 100,
  separators: ["\n\n", "\n", " ", ""],
});

export const chunkEmails = async (emails: Email[]) => {
  const emailsWithChunks: EmailChunk[] = [];
  for (const email of emails) {
    const chunks = await textSplitter.splitText(email.body);

    chunks.forEach((chunk, chunkIndex) => {
      emailsWithChunks.push({
        id: email.id,
        index: chunkIndex,
        subject: email.subject,
        chunk: chunk,
        from: email.from,
        to: email.to,
        timestamp: email.timestamp,
        totalChunks: chunks.length,
      });
    });
  }
  return emailsWithChunks;
};

export async function loadEmails(): Promise<Email[]> {
  const filePath = path.join(process.cwd(), "data", "emails.json");
  const fileContent = await fs.readFile(filePath, "utf-8");
  return JSON.parse(fileContent);
}

export async function loadOrGenerateEmbeddings(
  emailChunks: EmailChunk[]
): Promise<{ id: string; embedding: number[] }[]> {
  const results: { id: string; embedding: number[] }[] = [];
  // CHANGED: uncachedEmails -> uncachedEmailChunks
  // CHANGED: Email[] -> EmailChunk[]
  const uncachedEmailChunks: EmailChunk[] = [];

  // CHANGED: for (const email of emails) -> for (const emailChunk of emailChunks)
  for (const emailChunk of emailChunks) {
    // CHANGED: Use emailChunkToText instead of emailToText
    const cachedEmbedding = await getCachedEmbedding(
      emailChunkToText(emailChunk)
    );
    if (cachedEmbedding) {
      // CHANGED: email.id -> emailChunk.id
      results.push({
        id: emailChunk.id,
        embedding: cachedEmbedding,
      });
    } else {
      uncachedEmailChunks.push(emailChunk);
    }
  }

  // Generate embeddings for uncached emails in batches of 99
  if (uncachedEmailChunks.length > 0) {
    console.log(
      `Generating embeddings for ${uncachedEmailChunks.length} emails`
    );

    const BATCH_SIZE = 99;
    // CHANGED: i < uncachedEmails.length -> i < uncachedEmailChunks.length
    for (let i = 0; i < uncachedEmailChunks.length; i += BATCH_SIZE) {
      // CHANGED: uncachedEmails.slice -> uncachedEmailChunks.slice
      const batch = uncachedEmailChunks.slice(i, i + BATCH_SIZE);
      console.log(
        `Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(
          // CHANGED: uncachedEmails.length -> uncachedEmailChunks.length
          uncachedEmailChunks.length / BATCH_SIZE
        )}`
      );

      const { embeddings } = await embedMany({
        model: google.textEmbeddingModel("text-embedding-004"),
        // CHANGED: batch.map((e) => emailToText(e)) -> batch.map((e) => emailChunkToText(e))
        values: batch.map((e) => emailChunkToText(e)),
      });

      // Write batch to cache
      for (let j = 0; j < batch.length; j++) {
        const email = batch[j];
        const embedding = embeddings[j];

        // CHANGED: emailToText -> emailChunkToText
        await writeEmbeddingToCache(emailChunkToText(email), embedding);

        results.push({ id: email.id, embedding });
      }
    }
  }

  return results;
}

export async function searchWithEmbeddings(
  query: string,
  emailChunks: EmailChunk[]
) {
  // Load cached embeddings
  const emailEmbeddings = await loadOrGenerateEmbeddings(emailChunks);

  // Generate query embedding
  const { embedding: queryEmbedding } = await embed({
    model: google.textEmbeddingModel("text-embedding-004"),
    value: query,
  });

  // calculate simlarity scores
  const results = emailEmbeddings.map(({ id, embedding }) => {
    const email = emailChunks.find((e) => e.id === id)!;
    const score = cosineSimilarity(queryEmbedding, embedding);
    return { score, email };
  });

  return results.sort((a, b) => b.score - a.score);
}

export function reciprocalRankFusion(
  rankings: { email: EmailChunk; score: number }[][]
): { email: EmailChunk; score: number }[] {
  const rrfScores = new Map<string, number>();
  const emailMap = new Map<string, EmailChunk>();

  // Process each ranking list (BM25 or embeddings)
  rankings.forEach((ranking) => {
    ranking.forEach((item, rank) => {
      const emailChunkId = `${item.email.id}-${item.email.index}`;
      const currentScore = rrfScores.get(item.email.id) || 0;

      const contribution = 1 / (RRF_K + rank);
      rrfScores.set(emailChunkId, currentScore + contribution);
      emailMap.set(emailChunkId, item.email);
    });
  });

  return Array.from(rrfScores.entries())
    .sort(([, scoreA], [, scoreB]) => scoreB - scoreA)
    .map(([emailChunkId, score]) => ({
      score,
      email: emailMap.get(emailChunkId)!,
    }));
}

export const searchWithRRF = async (query: string, emails: Email[]) => {
  const emailChunks = await chunkEmails(emails);
  const bm25Ranking = await searchWithBM25(
    query.toLowerCase().split(" "),
    emailChunks
  );
  const embeddingsRanking = await searchWithEmbeddings(query, emailChunks);
  const rrfRanking = reciprocalRankFusion([bm25Ranking, embeddingsRanking]);

  return rrfRanking;
};

export function searchWithBM25(keywords: string[], emailChunks: EmailChunk[]) {
  const corpus = emailChunks.map((emailChunk) => emailChunkToText(emailChunk));

  const scores: number[] = (BM25 as any)(corpus, keywords);

  return scores
    .map((score, idx) => ({ score, email: emailChunks[idx] }))
    .sort((a, b) => b.score - a.score);
}
