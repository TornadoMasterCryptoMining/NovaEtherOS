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
      if (req.url === "/api/chat") {
        const body = JSON.parse(raw);
        requests.push(body);
        const reply = script[Math.min(requests.length - 1, script.length - 1)](body);
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
