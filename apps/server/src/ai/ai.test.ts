import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Workspace } from "./tools.js";
import { AIWorkstation } from "./workstation.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nova-ai-"));
}

test("workspace refuses paths outside it", () => {
  const ws = new Workspace(tmp(), "nobody");
  assert.throws(() => ws.resolve("../etc/passwd"), /outside the workspace/);
  assert.ok(ws.resolve("/src/app.ts").startsWith(fs.realpathSync(ws.root)));
});

test("workspace edit needs a unique match", async () => {
  const ws = new Workspace(tmp(), "nobody");
  await ws.write("a.txt", "one two two");
  await assert.rejects(ws.edit("a.txt", "two", "three"), /appears 2 times/);
  await ws.edit("a.txt", "one", "zero");
  assert.equal(ws.readText("a.txt"), "zero two two");
  assert.match(ws.search("TWO"), /a\.txt:1:/);
});

// A fake Ollama that asks for one tool call, then answers.
function fakeOllama(script: ((body: any) => object)[]) {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      if (req.url === "/api/version") return res.end(JSON.stringify({ version: "0.0.test" }));
      if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "test-model", size: 1 }] }));
      if (req.url === "/api/chat") {
        const body = JSON.parse(raw);
        requests.push(body);
        const reply = script[Math.min(requests.length - 1, script.length - 1)](body);
        if (body.stream === false) return res.end(JSON.stringify({ ...reply, done: true, eval_count: 5, total_duration: 1e9 }));
        res.write(JSON.stringify({ message: { role: "assistant", content: "" }, done: false }) + "\n");
        res.end(JSON.stringify({ ...reply, done: true, eval_count: 5, eval_duration: 1e9 }) + "\n");
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  return new Promise<{ url: string; requests: any[]; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => (server.closeAllConnections(), server.close()) });
    }),
  );
}

async function until(fn: () => boolean) {
  for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(fn(), "timed out");
}

test("agent loop runs a tool and answers", async () => {
  const ollama = await fakeOllama([
    () => ({ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "write_file", arguments: { path: "hello.py", content: "print('hi')\n" } } }] } }),
    () => ({ message: { role: "assistant", content: "Created hello.py." } }),
  ]);
  try {
    const dir = tmp();
    const ai = new AIWorkstation({ dir, workspace: path.join(dir, "ws"), agentUser: "nobody", protect: [], novaStatus: () => ({}) });
    ai.start();
    ai.saveSettings({ ollama_url: ollama.url });
    const { id } = ai.create("test-model", "agent");
    ai.send(id, "make a hello world script");
    await until(() => !ai.view(id).running);

    const chat = ai.view(id);
    assert.deepEqual(chat.messages.map((m) => m.role), ["user", "assistant", "tool", "assistant"]);
    assert.equal(chat.messages[3].content, "Created hello.py.");
    assert.equal(fs.readFileSync(path.join(dir, "ws", "hello.py"), "utf8"), "print('hi')\n");
    // The second request carries the tool result back to the model, without UI-only fields.
    const sent = ollama.requests[1].messages.at(-1);
    assert.equal(sent.role, "tool");
    assert.equal(sent.tool_name, "write_file");
    assert.equal(sent.args, undefined);
    assert.ok(ollama.requests[0].tools.some((t: any) => t.function.name === "run_command"));
  } finally {
    ollama.close();
  }
});

test("commands wait for approval and can be declined", async () => {
  const ollama = await fakeOllama([
    () => ({ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "run_command", arguments: { command: "rm -rf /" } } }] } }),
    () => ({ message: { role: "assistant", content: "OK, I won't." } }),
  ]);
  try {
    const dir = tmp();
    const ai = new AIWorkstation({ dir, workspace: path.join(dir, "ws"), agentUser: "nobody", protect: [], novaStatus: () => ({}) });
    ai.start();
    ai.saveSettings({ ollama_url: ollama.url });
    const { id } = ai.create("test-model", "agent");
    ai.send(id, "clean up");
    await until(() => Boolean(ai.view(id).pending));
    assert.equal(ai.view(id).pending?.args.command, "rm -rf /");
    ai.approve(id, false);
    await until(() => !ai.view(id).running);
    const chat = ai.view(id);
    assert.match(chat.messages[2].content, /declined/);
    assert.equal(chat.messages.at(-1)?.content, "OK, I won't.");
  } finally {
    ollama.close();
  }
});

test("text API: keys, endpoints and the OpenAI passthrough", async () => {
  const { default: express } = await import("express");
  const { TextAPI, render } = await import("./text-api.js");
  assert.equal(render("Into {{language}}: {{text}}", { language: "Spanish", text: "hi" }), "Into Spanish: hi");
  assert.throws(() => render("{{text}}", {}), /Missing "text"/);

  const seen: any[] = [];
  const ollama = await fakeOllama([
    (body) => {
      seen.push(body);
      return { message: { role: "assistant", content: '{"sentiment":"positive"}' } };
    },
  ]);
  const dir = tmp();
  const ai = new AIWorkstation({ dir, workspace: path.join(dir, "ws"), agentUser: "nobody", protect: [], novaStatus: () => ({}) });
  ai.start();
  ai.saveSettings({ ollama_url: ollama.url, default_model: "test-model" });
  const textApi = new TextAPI(dir, ai);
  const app = express();
  app.use(express.json());
  textApi.routes(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    textApi.saveEndpoint({ name: "Sentiment", template: "{{text}}", json: true, instructions: "Classify." });
    const { key } = textApi.createKey("test");
    assert.ok(!JSON.stringify(textApi.snapshot()).includes(key), "key itself is never stored or listed");

    const call = (p: string, body: object, auth = key) =>
      fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth}` }, body: JSON.stringify(body) });

    assert.equal((await call("/api/v1/text/sentiment", { text: "great" }, "nova_wrong")).status, 401);
    assert.equal((await call("/api/v1/text/sentiment", {})).status, 400);
    assert.equal((await call("/api/v1/text/nope", { text: "x" })).status, 404);

    const res = await call("/api/v1/text/sentiment", { text: "I love it" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.data, { sentiment: "positive" });
    assert.equal(seen[0].format, "json");
    assert.equal(seen[0].model, "test-model");
    assert.deepEqual(seen[0].messages.map((m: any) => m.role), ["system", "user"]);
    assert.equal(textApi.snapshot().keys[0].calls, 1 + 2); // 401 doesn't count; the other calls do

    // OpenAI-compatible routes need the key, then go straight to Ollama (the fake answers 404 here).
    assert.equal((await fetch(`${base}/v1/models`)).status, 401);
    const proxied = await fetch(`${base}/v1/models`, { headers: { "X-API-Key": key } });
    assert.equal(proxied.status, 404);

    // A wrong model name gets a helpful answer listing the installed models.
    const wrong = await call("/v1/chat/completions", { model: "qwen2.5-coder:3b.", messages: [{ role: "user", content: "hi" }] });
    assert.equal(wrong.status, 404);
    assert.match((await wrong.json()).error.message, /Installed: test-model/);
  } finally {
    server.closeAllConnections();
    server.close();
    ollama.close();
  }
});

test("Nova knows which model it runs on", async () => {
  const ollama = await fakeOllama([() => ({ message: { role: "assistant", content: "I am Nova." } })]);
  try {
    const dir = tmp();
    const ai = new AIWorkstation({ dir, workspace: path.join(dir, "ws"), agentUser: "nobody", protect: [], novaStatus: () => ({}) });
    ai.start();
    ai.saveSettings({ ollama_url: ollama.url });
    const { id } = ai.create("qwen2.5-coder:7b", "chat");
    ai.send(id, "Give me your model ID");
    await until(() => !ai.view(id).running);
    const system = ollama.requests[0].messages[0];
    assert.equal(system.role, "system");
    assert.match(system.content, /qwen2\.5-coder:7b/);
    assert.match(system.content, /not GPT-4/);
  } finally {
    ollama.close();
  }
});
