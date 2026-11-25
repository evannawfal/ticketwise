"use client";

import type { ApprovedAnswer, ApprovedMode, AssistantResult, DocumentRecord, SourcePreview, Stats, StreamEvent } from "@ticketwise/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiBackend, type Backend, type OnEvent } from "@/lib/backend";
import { isDemo, loadDeployedConfig, loadSettings, saveSettings, type Settings } from "@/lib/settings";
import { ApprovedSources, ApprovedText, GroundingNote, ResultMeta, RichText, SourcePreviews, Sources, useCiteFlash } from "./Answer";
import { EvalsView } from "./Evals";
import { ApprovedIcon, AskIcon, DocsIcon, DraftIcon, EvalsIcon, SettingsIcon } from "./icons";

type Tab = "ask" | "draft" | "approved" | "docs" | "evals" | "settings";

const TABS: { id: Tab; label: string; Icon: () => React.ReactElement }[] = [
  { id: "ask", label: "Ask", Icon: AskIcon },
  { id: "draft", label: "Draft reply", Icon: DraftIcon },
  { id: "approved", label: "Approved answers", Icon: ApprovedIcon },
  { id: "docs", label: "Knowledge base", Icon: DocsIcon },
  { id: "evals", label: "Evals", Icon: EvalsIcon },
  { id: "settings", label: "Settings", Icon: SettingsIcon },
];

const EXAMPLE_QUESTIONS = [
  "What happens if our card payment fails?",
  "Can we pay by invoice instead of card?",
  "How long does a refund take to show up?",
  "Is support open on Christmas day?",
];

const EXAMPLE_TICKET =
  "Hi, our whole workspace suddenly became read-only this morning and nobody can edit boards. We didn't change anything. Can you help? We have a launch tomorrow.";

const MODES: { id: ApprovedMode; label: string; hint: string }[] = [
  { id: "prefer", label: "Approved first", hint: "Use an approved answer when one matches, otherwise write one from the docs." },
  { id: "only", label: "Approved only", hint: "Only approved answers. Anything else goes to a human." },
  { id: "off", label: "Always generate", hint: "Ignore approved answers and write every answer from the docs." },
];

const stripMarkers = (t: string) => t.replace(/\s?\[\d+(?:\s*,\s*\d+)*\]/g, "");

function useBackend(): { backend: Backend | null; settings: Settings; setSettings: (s: Settings) => void } {
  const [settings, setSettingsState] = useState<Settings>({ apiUrl: "", token: "", streamUrl: "" });
  const [demo, setDemo] = useState<Backend | null>(null);

  useEffect(() => {
    if (isDemo) {
      import("@/lib/demo-backend").then((m) => setDemo(new m.DemoBackend()));
      return;
    }
    const s = loadSettings();
    loadDeployedConfig().then((cfg) => {
      setSettingsState({ ...s, apiUrl: s.apiUrl || cfg.apiUrl || "", streamUrl: s.streamUrl || cfg.streamUrl || "" });
    });
  }, []);

  const backend = useMemo(() => {
    if (isDemo) return demo;
    return settings.apiUrl && settings.token ? new ApiBackend(settings.apiUrl, settings.token, settings.streamUrl) : null;
  }, [demo, settings]);

  const setSettings = (s: Settings) => {
    saveSettings(s);
    setSettingsState(s);
  };
  return { backend, settings, setSettings };
}

export default function AdminApp() {
  const [tab, setTab] = useState<Tab>("ask");
  const { backend, settings, setSettings } = useBackend();
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    const fromHash = () => {
      const h = window.location.hash.slice(1) as Tab;
      if (TABS.some((t) => t.id === h)) setTab(h);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);

  const refreshStats = useCallback(() => {
    backend?.stats().then(setStats).catch(() => setStats(null));
  }, [backend]);
  useEffect(refreshStats, [refreshStats]);

  const go = (t: Tab) => {
    setTab(t);
    history.replaceState(null, "", `#${t}`);
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">T</div>
          Ticketwise
        </div>
        {TABS.map(({ id, label, Icon }) => (
          <button key={id} className={`nav-item ${tab === id ? "active" : ""}`} onClick={() => go(id)}>
            <Icon />
            {label}
          </button>
        ))}
        <div className="sidebar-foot">
          {stats ? (
            <>
              <strong>{stats.documents}</strong> docs, <strong>{stats.tickets}</strong> tickets
              <br />
              <strong>{stats.approvedAnswers}</strong> approved answers
              <br />
              <strong>{stats.questionsLast7Days}</strong> questions this week
            </>
          ) : (
            "Not connected"
          )}
          <br />
          <span style={{ opacity: 0.8 }}>{isDemo ? "Demo mode (runs in your browser)" : "Connected to your API"}</span>
        </div>
      </aside>

      <main className="main">
        {isDemo && tab !== "evals" && (
          <div className="banner">
            <span>
              <b>Live demo.</b> This runs the real pipeline in your browser on a sample help center for a made-up company,
              Northpine: retrieval, exact quotes, grounding checks, approved answers and the request queue. To keep it free
              with no API keys, answers are assembled from source sentences instead of written by an LLM. The deployed
              version uses Claude on AWS Bedrock or OpenAI.
            </span>
          </div>
        )}
        {!isDemo && !backend && tab !== "settings" && tab !== "evals" && (
          <div className="banner">
            <span>
              <b>Not connected.</b> Add your API URL and admin token in{" "}
              <a href="#settings" onClick={() => go("settings")}>
                Settings
              </a>
              .
            </span>
          </div>
        )}
        {tab === "ask" && <AskView backend={backend} onDone={refreshStats} />}
        {tab === "draft" && <DraftView backend={backend} onDone={refreshStats} />}
        {tab === "approved" && <ApprovedView backend={backend} onChange={refreshStats} />}
        {tab === "docs" && <DocsView backend={backend} stats={stats} onChange={refreshStats} />}
        {tab === "evals" && <EvalsView />}
        {tab === "settings" && <SettingsView settings={settings} onSave={setSettings} backend={backend} />}
      </main>
    </div>
  );
}

interface StreamState {
  text: string;
  sources: SourcePreview[];
  status: string;
  result: AssistantResult | null;
  loading: boolean;
  error: string;
}

const EMPTY: StreamState = { text: "", sources: [], status: "", result: null, loading: false, error: "" };

/** Runs one streamed request at a time; a new one cancels the last. */
function useStream(backend: Backend | null, onDone: () => void) {
  const [state, setState] = useState<StreamState>(EMPTY);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const run = async (fn: (b: Backend, onEvent: OnEvent, signal: AbortSignal) => Promise<AssistantResult>) => {
    if (!backend) return setState({ ...EMPTY, error: "Connect to an API in Settings first." });
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setState({ ...EMPTY, loading: true, status: "Searching the knowledge base" });
    const onEvent = (e: StreamEvent) => {
      if (ac.signal.aborted) return;
      setState((s) => {
        if (e.type === "sources") return { ...s, sources: e.sources, status: "Writing" };
        if (e.type === "status") return { ...s, status: e.message };
        if (e.type === "delta") return { ...s, text: s.text + e.text, status: "" };
        return s;
      });
    };
    try {
      const result = await fn(backend, onEvent, ac.signal);
      if (!ac.signal.aborted) setState((s) => ({ ...s, result, text: result.text, loading: false, status: "" }));
      onDone();
    } catch (e) {
      if (!ac.signal.aborted) setState((s) => ({ ...s, loading: false, status: "", error: (e as Error).message }));
    }
  };
  return { ...state, run };
}

function StreamingBody({ state, onCite }: { state: StreamState; onCite: (n: number) => void }) {
  if (!state.loading) return null;
  return (
    <>
      {state.text ? (
        <div className="card stack">
          <RichText text={state.text} citations={[]} validNumbers={state.sources.map((s) => s.n)} onCite={onCite} streaming />
          {state.status && <div className="meta-line">{state.status}</div>}
        </div>
      ) : (
        <div className="card">
          <div className="status-line">
            <span className="spinner" /> {state.status || "Working"}
          </div>
        </div>
      )}
      {state.sources.length > 0 && <SourcePreviews sources={state.sources} />}
    </>
  );
}

function AskView({ backend, onDone }: { backend: Backend | null; onDone: () => void }) {
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState("");
  const [mode, setMode] = useState<ApprovedMode>("prefer");
  const s = useStream(backend, onDone);
  const { flash, onCite } = useCiteFlash();
  const submit = (q = question) => {
    if (!q.trim()) return;
    setAsked(q);
    s.run((b, onEvent, signal) => b.ask(q, mode, onEvent, signal));
  };
  const result = s.result;

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Ask the knowledge base</h1>
        <p>Answers come only from your help docs and resolved tickets. Each sentence links to the passage it was taken from.</p>
      </div>
      <div className="card stack">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !s.loading) submit();
          }}
          placeholder="e.g. How do I reset 2FA for a customer who lost their phone?"
          rows={3}
          aria-label="Question"
        />
        <div className="row">
          <div className="segmented" role="radiogroup" aria-label="Approved answers">
            {MODES.map((m) => (
              <button key={m.id} role="radio" aria-checked={mode === m.id} className={mode === m.id ? "on" : ""} title={m.hint} onClick={() => setMode(m.id)}>
                {m.label}
              </button>
            ))}
          </div>
          <span className="grow meta-line">{MODES.find((m) => m.id === mode)!.hint}</span>
          <button className="btn primary" onClick={() => submit()} disabled={s.loading || !question.trim()}>
            {s.loading ? <span className="spinner" /> : null} Ask
          </button>
        </div>
        <div className="chips">
          {EXAMPLE_QUESTIONS.map((q) => (
            <button
              key={q}
              className="chip"
              onClick={() => {
                setQuestion(q);
                submit(q);
              }}
            >
              {q}
            </button>
          ))}
        </div>
      </div>
      {s.error && <div className="error">{s.error}</div>}
      <StreamingBody state={s} onCite={onCite} />
      {result && !s.loading && (
        <>
          <div className="card stack">
            {result.mode === "approved" ? (
              <>
                <ApprovedText text={result.text} />
                <ApprovedSources result={result} />
              </>
            ) : (
              <>
                <RichText text={result.text} citations={result.citations} onCite={onCite} />
                <GroundingNote grounding={result.grounding} />
              </>
            )}
            <ResultMeta result={result} />
            {result.mode === "generated" && <ApproveForm backend={backend} question={asked} result={result} onSaved={onDone} />}
          </div>
          <Sources citations={result.citations} flash={flash} />
        </>
      )}
    </div>
  );
}

/** Turn a generated answer into an approved one, after a person reviews and edits it. */
function ApproveForm({ backend, question, result, onSaved }: { backend: Backend | null; question: string; result: AssistantResult; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(question);
  const [answer, setAnswer] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    setOpen(false);
    setMsg(null);
  }, [result]);

  if (!open) {
    return (
      <div className="row">
        <button
          className="btn small"
          onClick={() => {
            setQ(question);
            setAnswer(stripMarkers(result.text));
            setOpen(true);
          }}
        >
          Save as approved answer
        </button>
        {msg && <span className={msg.ok ? "success" : "error"}>{msg.text}</span>}
      </div>
    );
  }
  const sources = [...new Map(result.citations.map((c) => [c.title, { title: c.title, url: c.url }])).values()];
  const save = async () => {
    try {
      await backend!.addApproved({ question: q, answer, sources });
      setOpen(false);
      setMsg({ ok: true, text: "Saved. Matching questions now get this text word for word." });
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };
  return (
    <div className="approve-form stack">
      <div className="section-title" style={{ margin: 0 }}>
        New approved answer
      </div>
      <div>
        <label htmlFor="ap-q">Question it answers</label>
        <input id="ap-q" type="text" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div>
        <label htmlFor="ap-a">Answer, exactly as customers should see it</label>
        <textarea id="ap-a" value={answer} onChange={(e) => setAnswer(e.target.value)} rows={5} />
        <div className="hint">Sources kept with it: {sources.map((s) => s.title).join(", ") || "none"}.</div>
      </div>
      <div className="row">
        <button className="btn primary small" onClick={save} disabled={!q.trim() || !answer.trim()}>
          Save
        </button>
        <button className="btn small" onClick={() => setOpen(false)}>
          Cancel
        </button>
        {msg && <span className="error">{msg.text}</span>}
      </div>
    </div>
  );
}

function DraftView({ backend, onDone }: { backend: Backend | null; onDone: () => void }) {
  const [ticket, setTicket] = useState("");
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const s = useStream(backend, onDone);
  const { flash, onCite } = useCiteFlash();
  const result = s.result;

  useEffect(() => {
    if (result) setDraft(result.text);
  }, [result]);

  const copy = async () => {
    await navigator.clipboard.writeText(stripMarkers(draft));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const submit = () => ticket.trim() && !s.loading && s.run((b, onEvent, signal) => b.draft(ticket, onEvent, signal));

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Draft a reply</h1>
        <p>Paste a customer&apos;s message. You get a reply to review, edit and send, with the passages it relies on.</p>
      </div>
      <div className="card stack">
        <textarea
          value={ticket}
          onChange={(e) => setTicket(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
          placeholder="Paste the customer's message"
          rows={5}
          aria-label="Customer message"
        />
        <div className="row">
          <button className="chip" onClick={() => setTicket(EXAMPLE_TICKET)}>
            Use an example ticket
          </button>
          <span className="grow" />
          <button className="btn primary" onClick={submit} disabled={s.loading || !ticket.trim()}>
            {s.loading ? <span className="spinner" /> : null} Draft reply
          </button>
        </div>
      </div>
      {s.error && <div className="error">{s.error}</div>}
      <StreamingBody state={s} onCite={onCite} />
      {result && !s.loading && (
        <>
          <div className="card stack">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div className="section-title" style={{ margin: 0 }}>
                Draft (editable)
              </div>
              <button className="btn small" onClick={copy}>
                {copied ? "Copied" : "Copy without [n] markers"}
              </button>
            </div>
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.min(16, draft.split("\n").length + 2)} aria-label="Draft reply" />
            <div className="section-title" style={{ margin: 0 }}>
              Preview
            </div>
            <RichText text={draft} citations={result.citations} onCite={onCite} />
            <GroundingNote grounding={result.grounding} />
            <ResultMeta result={result} />
          </div>
          <Sources citations={result.citations} flash={flash} />
        </>
      )}
    </div>
  );
}

function ApprovedView({ backend, onChange }: { backend: Backend | null; onChange: () => void }) {
  const [items, setItems] = useState<ApprovedAnswer[]>([]);
  const [editing, setEditing] = useState<ApprovedAnswer | "new" | null>(null);
  const [q, setQ] = useState("");
  const [a, setA] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    backend?.listApproved().then(setItems).catch((e) => setMsg({ ok: false, text: e.message }));
  }, [backend]);
  useEffect(load, [load]);

  const edit = (item: ApprovedAnswer | "new") => {
    setEditing(item);
    setQ(item === "new" ? "" : item.question);
    setA(item === "new" ? "" : item.answer);
    setMsg(null);
  };
  const act = async (fn: () => Promise<string>) => {
    if (!backend) return setMsg({ ok: false, text: "Connect to an API in Settings first." });
    setBusy(true);
    try {
      setMsg({ ok: true, text: await fn() });
      load();
      onChange();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    act(async () => {
      if (editing === "new") await backend!.addApproved({ question: q, answer: a });
      else if (editing) await backend!.updateApproved(editing.id, { question: q, answer: a, sources: editing.sources });
      setEditing(null);
      return "Saved.";
    });
  const remove = (item: ApprovedAnswer) => {
    if (!window.confirm(`Delete the approved answer for "${item.question}"?`)) return;
    act(async () => {
      await backend!.deleteApproved(item.id);
      return "Deleted.";
    });
  };

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Approved answers</h1>
        <p>
          Answers a support lead signed off on. When a question matches one, the stored text is returned word for word,
          with no model call. Save one from any answer on the Ask page, or write one here.
        </p>
      </div>
      <div className="row">
        <button className="btn primary" onClick={() => edit("new")} disabled={busy}>
          New approved answer
        </button>
        {msg && <span className={msg.ok ? "success" : "error"}>{msg.text}</span>}
      </div>
      {editing && (
        <div className="card stack">
          <div>
            <label htmlFor="aq">Question</label>
            <input id="aq" type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Can we pay by invoice?" />
            <div className="hint">Questions that ask the same thing in other words also match.</div>
          </div>
          <div>
            <label htmlFor="aa">Answer, exactly as customers should see it</label>
            <textarea id="aa" value={a} onChange={(e) => setA(e.target.value)} rows={5} />
          </div>
          <div className="row">
            <button className="btn primary small" onClick={save} disabled={busy || !q.trim() || !a.trim()}>
              Save
            </button>
            <button className="btn small" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Question</th>
              <th>Answer</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td className="cell-title">{item.question}</td>
                <td className="cell-answer">{item.answer}</td>
                <td className="meta-line">{new Date(item.updatedAt).toLocaleDateString()}</td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  <button className="btn small" onClick={() => edit(item)} disabled={busy}>
                    Edit
                  </button>{" "}
                  <button className="btn small danger" onClick={() => remove(item)} disabled={busy}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {!items.length && (
              <tr>
                <td colSpan={4} className="meta-line">
                  No approved answers yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

function DocsView({ backend, stats, onChange }: { backend: Backend | null; stats: Stats | null; onChange: () => void }) {
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [content, setContent] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const csvInput = useRef<HTMLInputElement>(null);
  const mdInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    backend?.listDocuments().then(setDocs).catch((e) => setMsg({ ok: false, text: e.message }));
  }, [backend]);
  useEffect(load, [load]);

  const act = async (fn: () => Promise<string>) => {
    if (!backend) return setMsg({ ok: false, text: "Connect to an API in Settings first." });
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await fn() });
      load();
      onChange();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const addDoc = () =>
    act(async () => {
      const d = await backend!.addDocument({ title, content, url: url || undefined });
      setTitle("");
      setUrl("");
      setContent("");
      return `Added "${d.title}" (${d.chunkCount} chunks).`;
    });

  const uploadMarkdown = (files: FileList | null) =>
    files &&
    act(async () => {
      let n = 0;
      for (const f of Array.from(files)) {
        const text = await readFile(f);
        const heading = /^#\s+(.+)$/m.exec(text)?.[1];
        await backend!.addDocument({ title: heading ?? f.name.replace(/\.(md|txt|markdown)$/i, ""), content: text });
        n++;
      }
      return `Added ${n} document${n === 1 ? "" : "s"}.`;
    });

  const uploadCsv = (files: FileList | null) =>
    files?.[0] &&
    act(async () => {
      const r = await backend!.importTickets(await readFile(files[0]));
      return `Imported ${r.imported} resolved tickets (${r.skipped} open or unanswered skipped).`;
    });

  const remove = (d: DocumentRecord) => {
    if (!window.confirm(`Delete "${d.title}"? This can't be undone.`)) return;
    act(async () => {
      await backend!.deleteDocument(d.id);
      return `Deleted "${d.title}".`;
    });
  };

  const shown = docs.filter((d) => d.title.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Knowledge base</h1>
        <p>Help docs and resolved tickets the assistant answers from. Changes are searchable right away.</p>
      </div>
      <div className="stats">
        <div className="stat"><div className="stat-v">{stats?.documents ?? "–"}</div><div className="stat-l">Help docs</div></div>
        <div className="stat"><div className="stat-v">{stats?.tickets ?? "–"}</div><div className="stat-l">Resolved tickets</div></div>
        <div className="stat"><div className="stat-v">{stats?.chunks ?? "–"}</div><div className="stat-l">Searchable chunks</div></div>
        <div className="stat"><div className="stat-v">{stats?.questionsLast7Days ?? "–"}</div><div className="stat-l">Questions (7 days)</div></div>
      </div>

      <div className="two-col">
        <div className="card stack">
          <div className="section-title" style={{ margin: 0 }}>Upload files</div>
          <div>
            <button className="btn" onClick={() => mdInput.current?.click()} disabled={busy}>Upload help docs (.md, .txt)</button>
            <input ref={mdInput} type="file" accept=".md,.markdown,.txt" multiple hidden onChange={(e) => { uploadMarkdown(e.target.files); e.target.value = ""; }} />
            <div className="hint">Markdown headings are used to split docs into sections.</div>
          </div>
          <div>
            <button className="btn" onClick={() => csvInput.current?.click()} disabled={busy}>Import tickets (.csv)</button>
            <input ref={csvInput} type="file" accept=".csv,text/csv" hidden onChange={(e) => { uploadCsv(e.target.files); e.target.value = ""; }} />
            <div className="hint">Zendesk/Freshdesk-style export with a customer message and an agent reply column. Only solved tickets are imported.</div>
          </div>
        </div>
        <div className="card stack">
          <div className="section-title" style={{ margin: 0 }}>Or paste a doc</div>
          <input type="text" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
          <input type="url" placeholder="Link (optional), e.g. https://help.yoursite.com/refunds" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="URL" />
          <textarea placeholder="Content (Markdown or plain text)" value={content} onChange={(e) => setContent(e.target.value)} rows={4} aria-label="Content" />
          <div><button className="btn primary" onClick={addDoc} disabled={busy || !title.trim() || !content.trim()}>Add document</button></div>
        </div>
      </div>
      {msg && <div className={msg.ok ? "success" : "error"}>{msg.text}</div>}

      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <div className="section-title grow" style={{ margin: 0 }}>{docs.length} items</div>
          <input type="text" placeholder="Filter by title" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ maxWidth: 240 }} aria-label="Filter" />
        </div>
        <table>
          <thead>
            <tr><th>Title</th><th>Type</th><th>Chunks</th><th>Added</th><th /></tr>
          </thead>
          <tbody>
            {shown.map((d) => (
              <tr key={d.id}>
                <td className="cell-title">{d.url ? <a href={d.url} target="_blank" rel="noreferrer">{d.title}</a> : d.title}</td>
                <td><span className={`badge ${d.sourceType}`}>{d.sourceType === "ticket" ? "Ticket" : "Doc"}</span></td>
                <td>{d.chunkCount}</td>
                <td className="meta-line">{new Date(d.createdAt).toLocaleDateString()}</td>
                <td style={{ textAlign: "right" }}><button className="btn small danger" onClick={() => remove(d)} disabled={busy}>Delete</button></td>
              </tr>
            ))}
            {!shown.length && (
              <tr><td colSpan={5} className="meta-line">Nothing here yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SettingsView({ settings, onSave, backend }: { settings: Settings; onSave: (s: Settings) => void; backend: Backend | null }) {
  const [apiUrl, setApiUrl] = useState(settings.apiUrl);
  const [streamUrl, setStreamUrl] = useState(settings.streamUrl);
  const [token, setToken] = useState(settings.token);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    setApiUrl(settings.apiUrl);
    setStreamUrl(settings.streamUrl);
    setToken(settings.token);
  }, [settings]);

  if (isDemo) {
    return (
      <div className="stack">
        <div className="page-head">
          <h1>Settings</h1>
          <p>The demo runs entirely in your browser, so there is nothing to configure.</p>
        </div>
        <div className="card">
          Deploy your own copy to AWS with one command and connect Slack. Instructions are in the{" "}
          <a href="https://github.com/evannawfal/ticketwise#deploy-to-aws" target="_blank" rel="noreferrer">README</a>.
        </div>
      </div>
    );
  }

  const test = async () => {
    const next = { apiUrl: apiUrl.trim(), token: token.trim(), streamUrl: streamUrl.trim() };
    onSave(next);
    setStatus(null);
    try {
      const s = await new ApiBackend(next.apiUrl, next.token, next.streamUrl).stats();
      setStatus({ ok: true, text: `Connected. ${s.documents} docs, ${s.tickets} tickets and ${s.approvedAnswers} approved answers.` });
    } catch (e) {
      setStatus({ ok: false, text: (e as Error).message });
    }
  };

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Settings</h1>
        <p>Saved in this browser only.</p>
      </div>
      <div className="card stack" style={{ maxWidth: 560 }}>
        <div>
          <label htmlFor="api">API URL</label>
          <input id="api" type="url" value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="https://abc123.execute-api.us-east-1.amazonaws.com" />
          <div className="hint">The ApiUrl output from the deploy, or http://localhost:8787 for local dev.</div>
        </div>
        <div>
          <label htmlFor="stream">Streaming URL (optional)</label>
          <input id="stream" type="url" value={streamUrl} onChange={(e) => setStreamUrl(e.target.value)} placeholder="https://abc123.lambda-url.us-east-1.on.aws" />
          <div className="hint">The StreamUrl output from the deploy. Leave empty for local dev.</div>
        </div>
        <div>
          <label htmlFor="token">Admin token</label>
          <input id="token" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="ADMIN_TOKEN from your secret" autoComplete="off" />
        </div>
        <div className="row">
          <button className="btn primary" onClick={test} disabled={!apiUrl.trim() || !token.trim()}>Save and test</button>
          {backend && !status && <span className="meta-line">Saved</span>}
        </div>
        {status && <div className={status.ok ? "success" : "error"}>{status.text}</div>}
      </div>
    </div>
  );
}
