// Nova AI's public API: lets your own scripts and apps use the local models.
//
//   POST /api/v1/text/<endpoint>   your own text endpoints (summarize, translate, ...)
//   POST /v1/chat/completions      OpenAI-compatible, for existing tools and SDKs
//   GET  /v1/models
//
// Every call needs an API key (Authorization: Bearer nova_... or X-API-Key).

import crypto from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import type express from "express";
import { JsonStore } from "../bitcoin/store.js";
import type { AIWorkstation } from "./workstation.js";

export interface ApiKey {
  id: string;
  name: string;
  hint: string; // first characters, to recognise it
  hash: string; // sha256 of the key; the key itself is never stored
  created_at: number;
  last_used: number | null;
  calls: number;
}

export interface TextEndpoint {
  slug: string;
  name: string;
  description: string;
  model: string | null; // null: the default model
  instructions: string; // system prompt
  template: string; // user message; {{text}} and other {{variables}} come from the request
  json: boolean; // answer as JSON
  temperature: number;
  created_at: number;
  calls: number;
  last_used: number | null;
}

export type EndpointInput = Partial<Omit<TextEndpoint, "created_at" | "calls" | "last_used">>;

export const STARTERS: EndpointInput[] = [
  {
    slug: "summarize", name: "Summarize", description: "Short summary of any text.",
    instructions: "Summarize the user's text in 3-5 concise bullet points. Reply with the summary only.",
    template: "{{text}}", json: false, temperature: 0.3,
  },
  {
    slug: "translate", name: "Translate", description: "Translate text into another language (send \"language\").",
    instructions: "Translate the user's text. Reply with the translation only, keeping the formatting.",
    template: "Translate into {{language}}:\n\n{{text}}", json: false, temperature: 0.2,
  },
  {
    slug: "rewrite", name: "Rewrite", description: "Fix grammar and make text clearer (optional \"tone\").",
    instructions: "Rewrite the user's text with correct grammar and clear wording, keeping its meaning. Reply with the rewritten text only.",
    template: "Tone: {{tone}}\n\n{{text}}", json: false, temperature: 0.4,
  },
  {
    slug: "sentiment", name: "Sentiment", description: "Classify text as positive, negative or neutral (JSON).",
    instructions: 'Classify the sentiment of the user\'s text. Answer only with JSON: {"sentiment": "positive" | "negative" | "neutral", "confidence": 0-1, "reason": "short reason"}',
    template: "{{text}}", json: true, temperature: 0,
  },
  {
    slug: "extract", name: "Extract keywords", description: "Pull out keywords, people, places and dates (JSON).",
    instructions: 'Extract information from the user\'s text. Answer only with JSON: {"keywords": [], "people": [], "places": [], "dates": []}',
    template: "{{text}}", json: true, temperature: 0,
  },
];

const VAR = /\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g;
const OPTIONAL_DEFAULTS: Record<string, string> = { tone: "neutral" };

export function templateVars(template: string) {
  return [...new Set([...template.matchAll(VAR)].map((m) => m[1]))];
}

export function render(template: string, input: Record<string, unknown>) {
  const missing = templateVars(template).filter((v) => input[v] == null && !(v in OPTIONAL_DEFAULTS));
  if (missing.length) throw new ApiError(400, `Missing ${missing.map((m) => `"${m}"`).join(", ")} in the request body.`);
  return template.replace(VAR, (_, v: string) => {
    const value = input[v] ?? OPTIONAL_DEFAULTS[v];
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export class TextAPI {
  private store: JsonStore<{ keys: ApiKey[]; endpoints: TextEndpoint[] }>;

  constructor(dir: string, private ai: AIWorkstation) {
    // 0600: key hashes and your prompts are nobody else's business.
    this.store = new JsonStore(path.join(dir, "api.json"), { keys: [], endpoints: [] }, 0o600);
  }

  // ----- dashboard management -----

  snapshot() {
    return {
      keys: this.store.get("keys").map(({ hash: _hash, ...k }) => k),
      endpoints: this.store.get("endpoints").map((e) => ({ ...e, variables: templateVars(e.template) })),
      starters: STARTERS.filter((s) => !this.store.get("endpoints").some((e) => e.slug === s.slug)),
    };
  }

  createKey(name: string) {
    const key = `nova_${crypto.randomBytes(24).toString("base64url")}`;
    const entry: ApiKey = {
      id: crypto.randomBytes(4).toString("hex"),
      name: name.trim().slice(0, 60) || "API key",
      hint: key.slice(0, 9),
      hash: sha256(key),
      created_at: Date.now(),
      last_used: null,
      calls: 0,
    };
    this.store.update({ keys: [...this.store.get("keys"), entry] });
    return { id: entry.id, key }; // shown once
  }

  revokeKey(id: string) {
    this.store.update({ keys: this.store.get("keys").filter((k) => k.id !== id) });
  }

  saveEndpoint(input: EndpointInput, originalSlug?: string) {
    const endpoints = this.store.get("endpoints");
    const existing = originalSlug ? endpoints.find((e) => e.slug === originalSlug) : undefined;
    if (originalSlug && !existing) throw new Error("Endpoint not found.");
    const name = String(input.name ?? existing?.name ?? "").trim().slice(0, 60);
    if (!name) throw new Error("Give the endpoint a name.");
    const slug = String(input.slug ?? existing?.slug ?? name)
      .toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    if (!slug) throw new Error("The endpoint's URL name must contain letters or numbers.");
    if (slug !== originalSlug && endpoints.some((e) => e.slug === slug)) throw new Error(`An endpoint called "${slug}" already exists.`);
    const template = String(input.template ?? existing?.template ?? "{{text}}");
    if (!templateVars(template).length) throw new Error("The template needs at least one {{variable}}, e.g. {{text}}.");
    const entry: TextEndpoint = {
      slug,
      name,
      description: String(input.description ?? existing?.description ?? "").slice(0, 200),
      model: (input.model ?? existing?.model) || null,
      instructions: String(input.instructions ?? existing?.instructions ?? "").slice(0, 8000),
      template: template.slice(0, 8000),
      json: Boolean(input.json ?? existing?.json ?? false),
      temperature: Math.min(Math.max(Number(input.temperature ?? existing?.temperature ?? 0.4) || 0, 0), 2),
      created_at: existing?.created_at ?? Date.now(),
      calls: existing?.calls ?? 0,
      last_used: existing?.last_used ?? null,
    };
    this.store.update({ endpoints: [...endpoints.filter((e) => e.slug !== originalSlug && e.slug !== slug), entry] });
    return entry;
  }

  deleteEndpoint(slug: string) {
    this.store.update({ endpoints: this.store.get("endpoints").filter((e) => e.slug !== slug) });
  }

  // ----- running -----

  async run(slug: string, input: Record<string, unknown>, signal?: AbortSignal) {
    const ep = this.store.get("endpoints").find((e) => e.slug === slug);
    if (!ep) throw new ApiError(404, `No text endpoint called "${slug}". GET /api/v1/text lists them.`);
    const model = ep.model || this.ai.defaultModel;
    if (!model) throw new ApiError(503, "No AI model is set up yet (Nova AI -> Models).");
    const prompt = render(ep.template, input);
    let result;
    try {
      result = await this.ai.ollama.complete({
        model,
        messages: [...(ep.instructions ? [{ role: "system" as const, content: ep.instructions }] : []), { role: "user", content: prompt }],
        options: { temperature: ep.temperature, num_ctx: this.ai.contextSize },
        json: ep.json,
        signal,
      });
    } catch (err) {
      throw new ApiError(503, `The AI engine failed: ${(err as Error).message}`);
    }
    this.store.update({
      endpoints: this.store.get("endpoints").map((e) => (e.slug === slug ? { ...e, calls: e.calls + 1, last_used: Date.now() } : e)),
    });
    let data: unknown;
    if (ep.json) {
      try {
        data = JSON.parse(result.content);
      } catch {
        data = null;
      }
    }
    return {
      endpoint: slug,
      model,
      output: result.content,
      ...(ep.json ? { data } : {}),
      tokens: result.tokens,
      seconds: Math.round(result.seconds * 100) / 100,
    };
  }

  // ----- HTTP -----

  private authenticate(req: express.Request) {
    const header = req.get("authorization") ?? "";
    const key = header.match(/^Bearer\s+(\S+)$/i)?.[1] ?? req.get("x-api-key") ?? "";
    if (!key) throw new ApiError(401, "Missing API key. Send: Authorization: Bearer nova_...");
    const hash = sha256(key);
    const found = this.store.get("keys").find((k) => crypto.timingSafeEqual(Buffer.from(k.hash), Buffer.from(hash)));
    if (!found) throw new ApiError(401, "Invalid API key.");
    this.store.update({
      keys: this.store.get("keys").map((k) => (k.id === found.id ? { ...k, calls: k.calls + 1, last_used: Date.now() } : k)),
    });
  }

  private static fail(res: express.Response, err: unknown) {
    const status = err instanceof ApiError ? err.status : 500;
    res.status(status).json({ error: { message: (err as Error).message, status } });
  }

  routes(app: express.Express) {
    // Callable from browser apps on other origins too (the key is the protection).
    app.use(["/v1", "/api/v1"], (req, res, next) => {
      res.set({
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, X-API-Key",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      });
      if (req.method === "OPTIONS") return void res.sendStatus(204);
      try {
        this.authenticate(req);
        next();
      } catch (err) {
        TextAPI.fail(res, err);
      }
    });

    app.get("/api/v1/text", (_req, res) => {
      res.json({
        endpoints: this.store.get("endpoints").map((e) => ({
          endpoint: e.slug, name: e.name, description: e.description, variables: templateVars(e.template), json: e.json,
          url: `/api/v1/text/${e.slug}`,
        })),
      });
    });

    app.post("/api/v1/text/:slug", async (req, res) => {
      const abort = new AbortController();
      res.on("close", () => !res.writableFinished && abort.abort());
      try {
        const body = typeof req.body === "object" && req.body ? req.body : {};
        res.json(await this.run(String(req.params.slug), body, abort.signal));
      } catch (err) {
        TextAPI.fail(res, err);
      }
    });

    // OpenAI-compatible: passed through to Ollama's own /v1 API.
    const proxy = async (req: express.Request, res: express.Response) => {
      const abort = new AbortController();
      res.on("close", () => !res.writableFinished && abort.abort());
      try {
        let body: string | undefined;
        if (req.method === "POST") {
          const payload = { ...(req.body ?? {}) };
          if (!payload.model) payload.model = this.ai.defaultModel;
          body = JSON.stringify(payload);
        }
        const up = await this.ai.ollama.raw(req.originalUrl, {
          method: req.method,
          headers: body ? { "Content-Type": "application/json" } : undefined,
          body,
          signal: abort.signal,
        });
        res.status(up.status);
        res.set("Content-Type", up.headers.get("content-type") ?? "application/json");
        if (up.body) Readable.fromWeb(up.body as import("node:stream/web").ReadableStream).pipe(res);
        else res.end();
      } catch (err) {
        if (!abort.signal.aborted) TextAPI.fail(res, new ApiError(503, `The AI engine isn't reachable: ${(err as Error).message}`));
      }
    };
    app.get("/v1/models", proxy);
    app.post("/v1/chat/completions", proxy);
    app.post("/v1/completions", proxy);
    app.post("/v1/embeddings", proxy);

    app.use(["/v1", "/api/v1"], (_req, res) => {
      res.status(404).json({ error: { message: "Unknown API route. See /api/v1/text and /v1/chat/completions.", status: 404 } });
    });
  }
}
