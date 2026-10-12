import { useState, type ReactNode } from "react";
import { api, type AIStatus, type EndpointDraft, type TextEndpoint, type TextResult } from "../api";
import { usePoll } from "../usePoll";
import { CodeBlock } from "./NovaAI";

const when = (t: number | null) => (t ? new Date(t).toLocaleString() : "never");

export function ApiPanel({ status }: { status: AIStatus }) {
  const { data, error, refresh } = usePoll(api.textApi, 10000);
  const [editing, setEditing] = useState<{ draft: EndpointDraft; original?: string } | null>(null);
  const [trying, setTrying] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const base = window.location.origin;

  const act = async (fn: () => Promise<unknown>) => {
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg((e as Error).message);
    }
    refresh();
  };

  if (!data) return <p className="muted center">{error ?? "Loading…"}</p>;

  return (
    <div className="panels">
      <Keys keys={data.keys} onChange={refresh} />

      <section className="panel glass">
        <h2>OpenAI-compatible API</h2>
        <p className="small muted">
          Works with existing tools and SDKs that speak the OpenAI API. Use your API key as the key and this base URL.
          Leave <code>model</code> out to use your default model.
        </p>
        <CodeBlock
          lang="python"
          code={`from openai import OpenAI\n\nclient = OpenAI(base_url="${base}/v1", api_key="nova_...")\nreply = client.chat.completions.create(\n    model="${status.settings.default_model ?? "qwen2.5-coder:3b"}",\n    messages=[{"role": "user", "content": "Write a haiku about Bitcoin"}],\n)\nprint(reply.choices[0].message.content)`}
        />
      </section>

      <section className="panel glass wide">
        <div className="files-head">
          <h2>Text endpoints</h2>
          <button className="btn" onClick={() => setEditing({ draft: { template: "{{text}}", temperature: 0.4, json: false } })}>
            + New endpoint
          </button>
        </div>
        <p className="small muted">
          Each endpoint is its own URL that does one text job with your local AI: send text in, get the result back. The
          instructions and template decide what it does; anything in <code>{"{{double braces}}"}</code> comes from the
          request.
        </p>
        {data.starters.length > 0 && (
          <div className="starters">
            <span className="small muted">Quick add:</span>
            {data.starters.map((s) => (
              <button key={s.slug} className="btn ghost" onClick={() => act(() => api.textApiSave(s))} title={s.description}>
                + {s.name}
              </button>
            ))}
          </div>
        )}
        {msg && <p className="error small">{msg}</p>}

        {editing && (
          <Editor
            initial={editing.draft}
            original={editing.original}
            models={status.models.map((m) => m.name)}
            defaultModel={status.settings.default_model}
            onDone={() => {
              setEditing(null);
              refresh();
            }}
          />
        )}

        {data.endpoints.length === 0 && !editing && <p className="muted small">No endpoints yet. Quick-add one above.</p>}
        <div className="endpoint-list">
          {data.endpoints.map((e) => (
            <div key={e.slug} className="endpoint">
              <div className="endpoint-head">
                <div className="grow">
                  <div><b>{e.name}</b> {e.json && <span className="pill">JSON</span>}</div>
                  <div className="mono small"><span className="method">POST</span> /api/v1/text/{e.slug}</div>
                  {e.description && <div className="small muted">{e.description}</div>}
                  <div className="small muted">
                    Send: {e.variables.map((v) => <code key={v}>{v}</code>).reduce<ReactNode[]>((a, c, i) => (i ? [...a, " ", c] : [c]), [])}
                    {" · "}{e.model ?? `default model (${status.settings.default_model ?? "none"})`} · {e.calls} calls · last {when(e.last_used)}
                  </div>
                </div>
                <div className="actions">
                  <button className="btn ghost" onClick={() => setTrying(trying === e.slug ? null : e.slug)}>{trying === e.slug ? "Close" : "Try it"}</button>
                  <button className="btn ghost" onClick={() => setEditing({ draft: e, original: e.slug })}>Edit</button>
                  <button
                    className="btn ghost"
                    onClick={() => confirm(`Delete the ${e.name} endpoint? Apps calling it will get an error.`) && act(() => api.textApiDelete(e.slug))}
                  >
                    Delete
                  </button>
                </div>
              </div>
              {trying === e.slug && <TryIt endpoint={e} base={base} onRan={refresh} />}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Keys({ keys, onChange }: { keys: { id: string; name: string; hint: string; created_at: number; last_used: number | null; calls: number }[]; onChange: () => void }) {
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);

  async function create() {
    const r = await api.textApiKey(name || "API key");
    setFresh(r.key);
    setName("");
    onChange();
  }

  return (
    <section className="panel glass">
      <h2>API keys</h2>
      <p className="small muted">
        Every API call needs a key: <code>Authorization: Bearer nova_…</code>. Make one per app so you can revoke it on its own.
      </p>
      {fresh && (
        <div className="new-key">
          <b className="small">Copy this key now. It won't be shown again.</b>
          <CodeBlock lang="API key" code={fresh} />
          <button className="link" onClick={() => setFresh(null)}>I've saved it</button>
        </div>
      )}
      {keys.map((k) => (
        <div key={k.id} className="model-row">
          <div className="grow">
            <b>{k.name}</b> <span className="mono small muted">{k.hint}…</span>
            <div className="small muted">{k.calls} calls · last used {when(k.last_used)}</div>
          </div>
          <button
            className="btn ghost"
            onClick={async () => {
              if (!confirm(`Revoke "${k.name}"? Apps using it stop working.`)) return;
              await api.textApiRevoke(k.id);
              onChange();
            }}
          >
            Revoke
          </button>
        </div>
      ))}
      <div className="add-ip">
        <input placeholder="Key name, e.g. My Discord bot" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn" onClick={create}>Create key</button>
      </div>
    </section>
  );
}

function Editor({
  initial,
  original,
  models,
  defaultModel,
  onDone,
}: {
  initial: EndpointDraft;
  original?: string;
  models: string[];
  defaultModel: string | null;
  onDone: () => void;
}) {
  const [d, setD] = useState<EndpointDraft>(initial);
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: EndpointDraft) => setD((cur) => ({ ...cur, ...patch }));

  async function save() {
    setErr(null);
    try {
      await api.textApiSave(d, original);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="endpoint-editor">
      <div className="editor-row">
        <label className="field grow">
          Name
          <input value={d.name ?? ""} placeholder="e.g. Product description" onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className="field grow">
          URL name
          <input value={d.slug ?? ""} placeholder="made from the name" onChange={(e) => set({ slug: e.target.value })} />
        </label>
      </div>
      <label className="field">
        Description (shown to apps listing the endpoints)
        <input value={d.description ?? ""} onChange={(e) => set({ description: e.target.value })} />
      </label>
      <label className="field">
        Instructions: what the AI should do
        <textarea rows={3} value={d.instructions ?? ""} placeholder="e.g. Write a short, friendly product description. Reply with the description only."
          onChange={(e) => set({ instructions: e.target.value })} />
      </label>
      <label className="field">
        Template: the message sent to the AI. <code>{"{{text}}"}</code>, <code>{"{{language}}"}</code>… are filled in from the request.
        <textarea rows={3} className="mono" value={d.template ?? ""} onChange={(e) => set({ template: e.target.value })} />
      </label>
      <div className="editor-row">
        <label className="field grow">
          Model
          <select value={d.model ?? ""} onChange={(e) => set({ model: e.target.value || null })}>
            <option value="">Default ({defaultModel ?? "none"})</option>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="field grow">
          Creativity: {(d.temperature ?? 0.4).toFixed(1)}
          <input type="range" min={0} max={1.5} step={0.1} value={d.temperature ?? 0.4} onChange={(e) => set({ temperature: Number(e.target.value) })} />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={Boolean(d.json)} onChange={(e) => set({ json: e.target.checked })} />
        <span>Answer as JSON (for apps that read fields). Describe the JSON shape in the instructions.</span>
      </label>
      {err && <p className="error small">{err}</p>}
      <div className="actions">
        <button className="btn" onClick={save}>{original ? "Save changes" : "Create endpoint"}</button>
        <button className="btn ghost" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

function TryIt({ endpoint, base, onRan }: { endpoint: TextEndpoint; base: string; onRan: () => void }) {
  const [input, setInput] = useState<Record<string, string>>({});
  const [result, setResult] = useState<TextResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      setResult(await api.textApiTest(endpoint.slug, input));
      onRan();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const example = Object.fromEntries(endpoint.variables.map((v) => [v, input[v] || (v === "text" ? "Your text here" : v === "language" ? "Spanish" : "...")]));
  const curl = `curl -X POST ${base}/api/v1/text/${endpoint.slug} \\\n  -H "Authorization: Bearer nova_..." \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(example).replace(/'/g, "'\\''")}'`;

  return (
    <div className="try-it">
      {endpoint.variables.map((v) => (
        <label key={v} className="field">
          {v}
          {v === "text" ? (
            <textarea rows={4} value={input[v] ?? ""} onChange={(e) => setInput({ ...input, [v]: e.target.value })} />
          ) : (
            <input value={input[v] ?? ""} onChange={(e) => setInput({ ...input, [v]: e.target.value })} />
          )}
        </label>
      ))}
      <button className="btn" disabled={busy} onClick={run}>{busy ? "Running…" : "Run"}</button>
      {err && <p className="error small left">{err}</p>}
      {result && (
        <>
          <CodeBlock lang={`result · ${result.model} · ${result.seconds}s`} code={result.data !== undefined ? JSON.stringify(result.data ?? result.output, null, 2) : result.output} />
        </>
      )}
      <details>
        <summary>Call it from your own code</summary>
        <CodeBlock lang="bash" code={curl} />
        <p className="small muted">
          Response: <code>{`{ "output": "...", ${endpoint.json ? '"data": {...}, ' : ""}"model": "...", "tokens": 0, "seconds": 0 }`}</code>
        </p>
      </details>
    </div>
  );
}
