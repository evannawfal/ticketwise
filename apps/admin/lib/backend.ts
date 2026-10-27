import type { AssistantResult, DocumentRecord, Stats } from "@ticketwise/core";

export interface NewDocument {
  title: string;
  content: string;
  url?: string;
  sourceType?: "doc" | "ticket";
}

export interface Backend {
  readonly mode: "demo" | "api";
  ask(question: string): Promise<AssistantResult>;
  draft(ticket: string): Promise<AssistantResult>;
  listDocuments(): Promise<DocumentRecord[]>;
  addDocument(doc: NewDocument): Promise<DocumentRecord>;
  importTickets(csv: string): Promise<{ imported: number; skipped: number }>;
  deleteDocument(id: string): Promise<void>;
  stats(): Promise<Stats>;
}

export class ApiBackend implements Backend {
  readonly mode = "api" as const;
  constructor(
    private apiUrl: string,
    private token: string,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.apiUrl.replace(/\/+$/, "")}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error("Can't reach the API. Check the API URL in Settings.");
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      if (res.status === 401) throw new Error("The admin token was rejected. Update it in Settings.");
      throw new Error(data.error ?? `Request failed (${res.status})`);
    }
    return data as T;
  }

  ask(question: string) {
    return this.call<AssistantResult>("POST", "/ask", { question });
  }
  draft(ticket: string) {
    return this.call<AssistantResult>("POST", "/draft", { ticket });
  }
  async listDocuments() {
    return (await this.call<{ documents: DocumentRecord[] }>("GET", "/documents")).documents;
  }
  async addDocument(doc: NewDocument) {
    return (await this.call<{ document: DocumentRecord }>("POST", "/documents", doc)).document;
  }
  importTickets(csv: string) {
    return this.call<{ imported: number; skipped: number }>("POST", "/documents/tickets", { csv });
  }
  async deleteDocument(id: string) {
    await this.call("DELETE", `/documents/${encodeURIComponent(id)}`);
  }
  stats() {
    return this.call<Stats>("GET", "/stats");
  }
}
