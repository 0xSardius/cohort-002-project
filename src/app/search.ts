import fs from "fs/promises";
import path from "path";
import BM25 from "okapibm25";

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

export function searchWithBM25(keywords: string[], emails: Email[]) {
  const corpus = emails.map((email) => `${email.subject} ${email.body}`);

  const scores: number[] = (BM25 as any)(corpus, keywords);

  return scores
    .map((score, index) => ({ score, email: emails[index] }))
    .sort((a, b) => b.score - a.score);
}

export async function loadEmails(): Promise<Email[]> {
  const filePath = path.join(process.cwd(), "data", "emails.json");
  const fileContent = await fs.readFile(filePath, "utf-8");
  return JSON.parse(fileContent);
}
