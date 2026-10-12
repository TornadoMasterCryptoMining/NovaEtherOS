// Minimal client for the Ollama HTTP API (https://github.com/ollama/ollama/blob/main/docs/api.md).

export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface InstalledModel {
  name: string;
  size: number;
  modified_at: string;
  details?: { family?: string; parameter_size?: string; quantization_level?: string };
}

export interface LoadedModel {
  name: string;
  size: number;
  size_vram: number;
  expires_at: string;
}

export interface PullProgress {
  status: string;
  total?: number;
  completed?: number;
}

export class OllamaError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// Read a newline-delimited JSON stream, one object at a time.
async function* ndjson<T>(res: Response): AsyncGenerator<T> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield JSON.parse(line) as T;
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer) as T;
}

export class Ollama {
  constructor(private baseUrl: () => string) {}

  private url(p: string) {
    return this.baseUrl().replace(/\/+$/, "") + p;
  }

  private async request(p: string, init: RequestInit & { timeoutMs?: number } = {}) {
    const { timeoutMs, ...rest } = init;
    const signals = [rest.signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : null].filter(Boolean) as AbortSignal[];
    const res = await fetch(this.url(p), {
      ...rest,
      headers: rest.body ? { "Content-Type": "application/json" } : undefined,
      signal: signals.length ? AbortSignal.any(signals) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let message = text || res.statusText;
      try {
        message = JSON.parse(text).error ?? message;
      } catch {
        // plain-text error
      }
      throw new OllamaError(message, res.status);
    }
    return res;
  }

  async version(): Promise<string | null> {
    try {
      const res = await this.request("/api/version", { timeoutMs: 2500 });
      return ((await res.json()) as { version: string }).version;
    } catch {
      return null;
    }
  }

  async models(): Promise<InstalledModel[]> {
    const res = await this.request("/api/tags", { timeoutMs: 5000 });
    return ((await res.json()) as { models?: InstalledModel[] }).models ?? [];
  }

  async loaded(): Promise<LoadedModel[]> {
    const res = await this.request("/api/ps", { timeoutMs: 5000 });
    return ((await res.json()) as { models?: LoadedModel[] }).models ?? [];
  }

  async remove(model: string) {
    await this.request("/api/delete", { method: "DELETE", body: JSON.stringify({ model }), timeoutMs: 30_000 });
  }

  async pull(model: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal) {
    const res = await this.request("/api/pull", { method: "POST", body: JSON.stringify({ model, stream: true }), signal });
    for await (const line of ndjson<PullProgress & { error?: string }>(res)) {
      if (line.error) throw new OllamaError(line.error, 500);
      onProgress(line);
    }
  }

  // One-shot, non-streamed chat (for the text API). `json` makes the model answer in JSON.
  async complete(opts: {
    model: string;
    messages: ChatMessage[];
    options?: Record<string, unknown>;
    json?: boolean;
    signal?: AbortSignal;
  }): Promise<{ content: string; tokens: number; seconds: number }> {
    const res = await this.request("/api/chat", {
      method: "POST",
      signal: opts.signal,
      timeoutMs: 10 * 60_000,
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        options: opts.options,
        format: opts.json ? "json" : undefined,
        stream: false,
        keep_alive: "15m",
      }),
    });
    const body = (await res.json()) as { message?: ChatMessage; eval_count?: number; total_duration?: number };
    const content = (body.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    return { content, tokens: body.eval_count ?? 0, seconds: (body.total_duration ?? 0) / 1e9 };
  }

  // Raw request to Ollama's OpenAI-compatible API (/v1/...), for proxying.
  raw(p: string, init: RequestInit) {
    return fetch(this.url(p), init);
  }

  // Streamed chat. `onDelta` gets the text and thinking as they arrive; the
  // returned message is the complete reply, including any tool calls.
  async chat(opts: {
    model: string;
    messages: ChatMessage[];
    tools?: ToolSpec[];
    options?: Record<string, unknown>;
    signal?: AbortSignal;
    onDelta?: (delta: { content: string; thinking: string }) => void;
  }): Promise<{ message: ChatMessage; stats: { tokens: number; seconds: number } }> {
    const res = await this.request("/api/chat", {
      method: "POST",
      signal: opts.signal,
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        tools: opts.tools?.length ? opts.tools : undefined,
        options: opts.options,
        stream: true,
        keep_alive: "15m",
      }),
    });
    const message: ChatMessage = { role: "assistant", content: "", thinking: "", tool_calls: [] };
    let stats = { tokens: 0, seconds: 0 };
    type Chunk = { message?: Partial<ChatMessage>; done?: boolean; error?: string; eval_count?: number; eval_duration?: number };
    for await (const chunk of ndjson<Chunk>(res)) {
      if (chunk.error) throw new OllamaError(chunk.error, 500);
      const m = chunk.message;
      if (m) {
        message.content += m.content ?? "";
        message.thinking += m.thinking ?? "";
        if (m.tool_calls?.length) message.tool_calls!.push(...m.tool_calls);
        if (m.content || m.thinking) opts.onDelta?.({ content: m.content ?? "", thinking: m.thinking ?? "" });
      }
      if (chunk.done) stats = { tokens: chunk.eval_count ?? 0, seconds: (chunk.eval_duration ?? 0) / 1e9 };
    }
    if (!message.thinking) delete message.thinking;
    if (!message.tool_calls!.length) delete message.tool_calls;
    return { message, stats };
  }
}
