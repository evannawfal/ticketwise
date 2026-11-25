import {
  readSse,
  type ApprovedAnswer,
  type ApprovedAnswerInput,
  type ApprovedMode,
  type AssistantResult,
  type DocumentRecord,
  type Stats,
  type StreamEvent,
} from "@ticketwise/core";

export interface NewDocument {
  title: string;
  content: string;
  url?: string;
  sourceType?: "doc" | "ticket";
}

export type OnEvent = (e: StreamEvent) => void;

export interface Backend {
  readonly mode: "demo" | "api";
  /** Streams events to onEvent and resolves with the final result. */
  ask(question: string, mode: ApprovedMode, onEvent: OnEvent, signal?: AbortSignal): Promise<AssistantResult>;
  draft(ticket: string, onEvent: OnEvent, signal?: AbortSignal): Promise<AssistantResult>;
  listDocuments(): Promise<DocumentRecord[]>;
  addDocument(doc: NewDocument): Promise<DocumentRecord>;
  importTickets(csv: string): Promise<{ imported: number; skipped: number }>;
  deleteDocument(id: string): Promise<void>;
  listApproved(): Promise<ApprovedAnswer[]>;
  addApproved(input: ApprovedAnswerInput): Promise<ApprovedAnswer>;
  updateApproved(id: string, input: ApprovedAnswerInput): Promise<ApprovedAnswer>;
  deleteApproved(id: string): Promise<void>;
  stats(): Promise<Stats>;
}

const trimSlash = (u: string) => u.replace(/\/+$/, "");

export class ApiBackend implements Backend {
  readonly mode = "api" as const;
  constructor(
    private apiUrl: string,
    private token: string,
    /** Where /ask/stream lives. On AWS it's a separate function URL; locally it's the API itself. */
    private streamUrl = "",
  ) {}

  private async send(url: string, method: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new Error("Can't reach the API. Check the API URL in Settings.");
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 401) throw new Error("The admin token was rejected. Update it in Settings.");
      const wait = res.headers.get("retry-after");
      throw new Error((data.error ?? `Request failed (${res.status})`) + (wait ? ` (try again in ${wait}s)` : ""));
    }
    return res;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.send(`${trimSlash(this.apiUrl)}${path}`, method, body);
    return (await res.json()) as T;
  }

  private async stream(path: string, body: unknown, onEvent: OnEvent, signal?: AbortSignal): Promise<AssistantResult> {
    const res = await this.send(`${trimSlash(this.streamUrl || this.apiUrl)}${path}`, "POST", body, signal);
    if (!res.body) throw new Error("The API returned an empty stream.");
    for await (const data of readSse(res.body)) {
      const ev = JSON.parse(data) as StreamEvent;
      if (ev.type === "error") throw new Error(ev.message);
      onEvent(ev);
      if (ev.type === "done") return ev.result;
    }
    throw new Error("The answer stopped before it finished. Try again.");
  }

  ask(question: string, mode: ApprovedMode, onEvent: OnEvent, signal?: AbortSignal) {
    return this.stream("/ask/stream", { question, mode }, onEvent, signal);
  }
  draft(ticket: string, onEvent: OnEvent, signal?: AbortSignal) {
    return this.stream("/draft/stream", { ticket }, onEvent, signal);
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
  async listApproved() {
    return (await this.call<{ approved: ApprovedAnswer[] }>("GET", "/approved")).approved;
  }
  async addApproved(input: ApprovedAnswerInput) {
    return (await this.call<{ approved: ApprovedAnswer }>("POST", "/approved", input)).approved;
  }
  async updateApproved(id: string, input: ApprovedAnswerInput) {
    return (await this.call<{ approved: ApprovedAnswer }>("PUT", `/approved/${encodeURIComponent(id)}`, input)).approved;
  }
  async deleteApproved(id: string) {
    await this.call("DELETE", `/approved/${encodeURIComponent(id)}`);
  }
  stats() {
    return this.call<Stats>("GET", "/stats");
  }
}
