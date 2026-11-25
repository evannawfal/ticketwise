import { timingSafeEqual } from "node:crypto";
import {
  APPROVED_MODES,
  ProviderError,
  QueueFullError,
  QueueTimeoutError,
  sseEvent,
  ticketsFromCsv,
  type ApprovedMode,
  type ApprovedSource,
  type SupportAssistant,
  type VectorStore,
} from "@ticketwise/core";

export interface HttpRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body?: string | null;
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export interface RouterDeps {
  assistant: SupportAssistant;
  store: VectorStore;
  adminToken: string;
  allowedOrigin: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_BODY = 1_000_000;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function header(req: HttpRequest, name: string): string | undefined {
  const key = Object.keys(req.headers).find((k) => k.toLowerCase() === name);
  return key ? req.headers[key] : undefined;
}

function parseJson(req: HttpRequest): Record<string, unknown> {
  if (!req.body) throw new HttpError(400, "request body is required");
  if (req.body.length > MAX_BODY) throw new HttpError(413, "request body is too large (max 1 MB)");
  try {
    const v = JSON.parse(req.body);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "body must be a JSON object");
  }
}

function str(body: Record<string, unknown>, key: string, required = true): string | undefined {
  const v = body[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, `"${key}" is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new HttpError(400, `"${key}" must be a string`);
  return v;
}

/** Map any error to an HTTP status and a message that is safe to show. */
export function describeError(err: unknown): { status: number; message: string; retryAfterMs?: number } {
  if (err instanceof HttpError) return { status: err.status, message: err.message };
  if (err instanceof QueueFullError) return { status: 429, message: err.message, retryAfterMs: err.retryAfterMs };
  if (err instanceof QueueTimeoutError) return { status: 503, message: err.message, retryAfterMs: 5000 };
  if (err instanceof ProviderError) {
    console.error("model provider error", err.message);
    return err.status === 429
      ? { status: 503, message: "The model provider is busy. Try again in a moment.", retryAfterMs: err.retryAfterMs ?? 5000 }
      : { status: 502, message: "The model provider returned an error. Try again in a moment." };
  }
  const message = (err as Error)?.message ?? "error";
  // Input validation errors thrown by the core library.
  if (/is required|too long/.test(message)) return { status: 400, message };
  console.error("unhandled error", err);
  return { status: 500, message: "internal error" };
}

function approvedMode(body: Record<string, unknown>): ApprovedMode | undefined {
  const mode = str(body, "mode", false);
  if (mode !== undefined && !(APPROVED_MODES as readonly string[]).includes(mode)) {
    throw new HttpError(400, `"mode" must be one of ${APPROVED_MODES.join(", ")}`);
  }
  return mode as ApprovedMode | undefined;
}

function approvedBody(body: Record<string, unknown>) {
  const raw = body.sources ?? [];
  if (!Array.isArray(raw) || raw.length > 20) throw new HttpError(400, `"sources" must be a list of up to 20 { title, url }`);
  const sources: ApprovedSource[] = raw.map((s) => {
    const o = s as Record<string, unknown>;
    if (!o || typeof o.title !== "string" || !o.title.trim()) throw new HttpError(400, "each source needs a title");
    if (o.url !== undefined && o.url !== null && (typeof o.url !== "string" || !/^https?:\/\//i.test(o.url))) {
      throw new HttpError(400, "source urls must start with http:// or https://");
    }
    return { title: o.title, url: (o.url as string | undefined) ?? null };
  });
  return { question: str(body, "question")!, answer: str(body, "answer")!, sources };
}

function corsHeaders(allowedOrigin: string): Record<string, string> {
  return {
    "access-control-allow-origin": allowedOrigin,
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-max-age": "600",
  };
}

function checkAdmin(req: HttpRequest, adminToken: string) {
  const auth = header(req, "authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !safeEqual(token, adminToken)) throw new HttpError(401, "missing or invalid admin token");
}

export function createRouter(deps: RouterDeps) {
  const cors = corsHeaders(deps.allowedOrigin);
  const json = (statusCode: number, data: unknown): HttpResponse => ({
    statusCode,
    headers: { "content-type": "application/json", ...cors },
    body: JSON.stringify(data),
  });

  const requireAdmin = (req: HttpRequest) => checkAdmin(req, deps.adminToken);

  async function route(req: HttpRequest): Promise<HttpResponse> {
    const method = req.method.toUpperCase();
    const path = req.path.replace(/\/+$/, "") || "/";

    if (method === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
    if (method === "GET" && path === "/health") return json(200, { ok: true });

    requireAdmin(req);

    if (method === "GET" && path === "/documents") {
      return json(200, { documents: await deps.store.listDocuments() });
    }
    if (method === "POST" && path === "/documents") {
      const body = parseJson(req);
      const sourceType = str(body, "sourceType", false) ?? "doc";
      if (sourceType !== "doc" && sourceType !== "ticket") throw new HttpError(400, `"sourceType" must be doc or ticket`);
      const url = str(body, "url", false);
      if (url && !/^https?:\/\//i.test(url)) throw new HttpError(400, `"url" must start with http:// or https://`);
      const doc = await deps.assistant.ingest({
        title: str(body, "title")!,
        content: str(body, "content")!,
        url,
        sourceType,
      });
      return json(201, { document: doc });
    }
    if (method === "POST" && path === "/documents/tickets") {
      const body = parseJson(req);
      let parsed;
      try {
        parsed = ticketsFromCsv(str(body, "csv")!);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      if (parsed.documents.length > 2000) throw new HttpError(413, "too many tickets in one upload (max 2000)");
      const created = [];
      for (const d of parsed.documents) created.push(await deps.assistant.ingest(d));
      return json(201, { imported: created.length, skipped: parsed.skipped });
    }
    const del = /^\/documents\/([^/]+)$/.exec(path);
    if (method === "DELETE" && del) {
      const ok = await deps.store.deleteDocument(decodeURIComponent(del[1]));
      if (!ok) throw new HttpError(404, "document not found");
      return json(200, { deleted: true });
    }
    if (method === "POST" && path === "/ask") {
      const body = parseJson(req);
      return json(200, await deps.assistant.ask(str(body, "question")!, "web", approvedMode(body)));
    }
    if (method === "GET" && path === "/approved") {
      return json(200, { approved: await deps.store.listApproved() });
    }
    if (method === "POST" && path === "/approved") {
      return json(201, { approved: await deps.assistant.approve(approvedBody(parseJson(req))) });
    }
    const approvedPath = /^\/approved\/([^/]+)$/.exec(path);
    if (method === "PUT" && approvedPath) {
      const updated = await deps.assistant.updateApproved(decodeURIComponent(approvedPath[1]), approvedBody(parseJson(req)));
      if (!updated) throw new HttpError(404, "approved answer not found");
      return json(200, { approved: updated });
    }
    if (method === "DELETE" && approvedPath) {
      if (!(await deps.store.deleteApproved(decodeURIComponent(approvedPath[1])))) throw new HttpError(404, "approved answer not found");
      return json(200, { deleted: true });
    }
    if (method === "POST" && path === "/draft") {
      const body = parseJson(req);
      return json(200, await deps.assistant.draftReply(str(body, "ticket")!, "web"));
    }
    if (method === "GET" && path === "/stats") {
      return json(200, await deps.store.stats());
    }
    throw new HttpError(404, `no route for ${method} ${path}`);
  }

  return async function handle(req: HttpRequest): Promise<HttpResponse> {
    try {
      return await route(req);
    } catch (err) {
      const { status, message, retryAfterMs } = describeError(err);
      const res = json(status, { error: message });
      if (retryAfterMs) res.headers["retry-after"] = String(Math.ceil(retryAfterMs / 1000));
      return res;
    }
  };
}

export interface StreamingResponse {
  statusCode: 200;
  headers: Record<string, string>;
  /** Server-Sent Events, already formatted. */
  body: AsyncIterable<string>;
}

export const STREAM_PATHS = ["/ask/stream", "/draft/stream"];

/**
 * POST /ask/stream {question, mode?} and POST /draft/stream {ticket} as
 * Server-Sent Events. Auth and validation happen before the stream opens, so
 * those failures still get a normal HTTP status. A failure after that (say the
 * provider gives up mid-answer) arrives as an {type:"error"} event.
 */
export function createStreamHandler(deps: Pick<RouterDeps, "assistant" | "adminToken" | "allowedOrigin">) {
  const cors = corsHeaders(deps.allowedOrigin);
  return async function open(req: HttpRequest, signal?: AbortSignal): Promise<HttpResponse | StreamingResponse> {
    const fail = (err: unknown): HttpResponse => {
      const { status, message, retryAfterMs } = describeError(err);
      const headers: Record<string, string> = { "content-type": "application/json", ...cors };
      if (retryAfterMs) headers["retry-after"] = String(Math.ceil(retryAfterMs / 1000));
      return { statusCode: status, headers, body: JSON.stringify({ error: message }) };
    };
    const path = req.path.replace(/\/+$/, "");
    if (req.method.toUpperCase() === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
    try {
      if (req.method.toUpperCase() !== "POST" || !STREAM_PATHS.includes(path)) throw new HttpError(404, `no route for ${req.method} ${path}`);
      checkAdmin(req, deps.adminToken);
      const body = parseJson(req);
      const task = path === "/ask/stream" ? "answer" : "draft";
      const text = str(body, task === "answer" ? "question" : "ticket")!;
      const mode = task === "answer" ? approvedMode(body) : undefined;
      const events = deps.assistant.stream(task, text, { channel: "web", approvedMode: mode, signal });
      // Pull the first event before committing to a 200, so input errors become 400s.
      const first = await events.next();
      async function* sse(): AsyncIterable<string> {
        try {
          if (!first.done) yield sseEvent(first.value);
          for await (const ev of events) yield sseEvent(ev);
        } catch (err) {
          if (signal?.aborted) return;
          const { status, message } = describeError(err);
          yield sseEvent({ type: "error", status, message });
        }
      }
      return {
        statusCode: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no", ...cors },
        body: sse(),
      };
    } catch (err) {
      return fail(err);
    }
  };
}
