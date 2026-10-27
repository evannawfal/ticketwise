"use client";

import type { AssistantResult, DocumentRecord, Stats } from "@ticketwise/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiBackend, type Backend } from "@/lib/backend";
import { isDemo, loadDeployedConfig, loadSettings, saveSettings, type Settings } from "@/lib/settings";
import { ResultMeta, RichText, Sources, useCiteFlash } from "./Answer";
import { AskIcon, DocsIcon, DraftIcon, SettingsIcon } from "./icons";

type Tab = "ask" | "draft" | "docs" | "settings";

const TABS: { id: Tab; label: string; Icon: () => React.ReactElement }[] = [
  { id: "ask", label: "Ask", Icon: AskIcon },
  { id: "draft", label: "Draft reply", Icon: DraftIcon },
  { id: "docs", label: "Knowledge base", Icon: DocsIcon },
  { id: "settings", label: "Settings", Icon: SettingsIcon },
];

const EXAMPLE_QUESTIONS = [
  "A customer lost their phone and can't get 2FA codes. They're the only owner.",
  "How long does a refund take to show up?",
  "Can we pay by invoice instead of card?",
  "Slack notifications stopped arriving in a channel",
  "Do guests use a paid seat?",
];

const EXAMPLE_TICKET =
  "Hi, our whole workspace suddenly became read-only this morning and nobody can edit boards. We didn't change anything. Can you help? We have a launch tomorrow.";

function useBackend(): { backend: Backend | null; settings: Settings; setSettings: (s: Settings) => void } {
  const [settings, setSettingsState] = useState<Settings>({ apiUrl: "", token: "" });
  const [demo, setDemo] = useState<Backend | null>(null);

  useEffect(() => {
    if (isDemo) {
      import("@/lib/demo-backend").then((m) => setDemo(new m.DemoBackend()));
      return;
    }
    const s = loadSettings();
    loadDeployedConfig().then((cfg) => {
      setSettingsState({ ...s, apiUrl: s.apiUrl || cfg.apiUrl || "" });
    });
  }, []);

  const backend = useMemo(() => {
    if (isDemo) return demo;
    return settings.apiUrl && settings.token ? new ApiBackend(settings.apiUrl, settings.token) : null;
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
              <strong>{stats.documents}</strong> docs · <strong>{stats.tickets}</strong> tickets
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
        {isDemo && (
          <div className="banner">
            <span>
              <b>Live demo.</b> This runs the real retrieval pipeline in your browser on a sample help center for a made-up
              company, Northpine. To keep it free with no API keys, answers are pieced together from the source text instead
              of written by an LLM. The deployed version uses Claude on AWS Bedrock or OpenAI.
            </span>
          </div>
        )}
        {!isDemo && !backend && tab !== "settings" && (
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
        {tab === "docs" && <DocsView backend={backend} stats={stats} onChange={refreshStats} />}
        {tab === "settings" && <SettingsView settings={settings} onSave={setSettings} backend={backend} />}
      </main>
    </div>
  );
}

function useRun(backend: Backend | null, onDone: () => void) {
  const [result, setResult] = useState<AssistantResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const run = async (fn: (b: Backend) => Promise<AssistantResult>) => {
    if (!backend) return setError("Connect to an API in Settings first.");
    setLoading(true);
    setError("");
    try {
      setResult(await fn(backend));
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  return { result, loading, error, run };
}

function Loading() {
  return (
    <div className="card">
      <div className="skeleton" style={{ width: "92%" }} />
      <div className="skeleton" style={{ width: "78%" }} />
      <div className="skeleton" style={{ width: "60%" }} />
    </div>
  );
}

function AskView({ backend, onDone }: { backend: Backend | null; onDone: () => void }) {
  const [question, setQuestion] = useState("");
  const { result, loading, error, run } = useRun(backend, onDone);
  const { flash, onCite } = useCiteFlash();
  const submit = (q = question) => {
    if (q.trim()) run((b) => b.ask(q));
  };

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Ask the knowledge base</h1>
        <p>Answers come only from your help docs and resolved tickets, with a source for every claim.</p>
      </div>
      <div className="card stack">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !loading) submit();
          }}
          placeholder="e.g. How do I reset 2FA for a customer who lost their phone?"
          rows={3}
          aria-label="Question"
        />
        <div className="row">
          <div className="chips grow">
            {EXAMPLE_QUESTIONS.slice(0, 4).map((q) => (
              <button
                key={q}
                className="chip"
                onClick={() => {
                  setQuestion(q);
                  submit(q);
                }}
              >
                {q.length > 46 ? `${q.slice(0, 44)}…` : q}
              </button>
            ))}
          </div>
          <button className="btn primary" onClick={() => submit()} disabled={loading || !question.trim()}>
            {loading ? <span className="spinner" /> : null} Ask
          </button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {loading && <Loading />}
      {result && !loading && (
        <>
          <div className="card stack">
            <RichText text={result.text} citations={result.citations} onCite={onCite} />
            <ResultMeta result={result} />
          </div>
          <Sources citations={result.citations} flash={flash} />
        </>
      )}
    </div>
  );
}

function DraftView({ backend, onDone }: { backend: Backend | null; onDone: () => void }) {
  const [ticket, setTicket] = useState("");
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const { result, loading, error, run } = useRun(backend, onDone);
  const { flash, onCite } = useCiteFlash();

  useEffect(() => {
    if (result) setDraft(result.text);
  }, [result]);

  const copy = async () => {
    const clean = draft.replace(/\s?\[\d+(?:\s*,\s*\d+)*\]/g, "");
    await navigator.clipboard.writeText(clean);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Draft a reply</h1>
        <p>Paste a customer&apos;s message. You get a reply to review, edit and send, with sources to check.</p>
      </div>
      <div className="card stack">
        <textarea
          value={ticket}
          onChange={(e) => setTicket(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && ticket.trim() && !loading) run((b) => b.draft(ticket));
          }}
          placeholder="Paste the customer's message…"
          rows={5}
          aria-label="Customer message"
        />
        <div className="row">
          <button className="chip" onClick={() => setTicket(EXAMPLE_TICKET)}>
            Use an example ticket
          </button>
          <span className="grow" />
          <button className="btn primary" onClick={() => ticket.trim() && run((b) => b.draft(ticket))} disabled={loading || !ticket.trim()}>
            {loading ? <span className="spinner" /> : null} Draft reply
          </button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {loading && <Loading />}
      {result && !loading && (
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
            <ResultMeta result={result} />
          </div>
          <Sources citations={result.citations} flash={flash} />
        </>
      )}
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
  const [token, setToken] = useState(settings.token);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    setApiUrl(settings.apiUrl);
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
    onSave({ apiUrl: apiUrl.trim(), token: token.trim() });
    setStatus(null);
    try {
      const s = await new ApiBackend(apiUrl.trim(), token.trim()).stats();
      setStatus({ ok: true, text: `Connected. ${s.documents} docs and ${s.tickets} tickets indexed.` });
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
