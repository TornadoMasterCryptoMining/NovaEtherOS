// Minimal Bitcoin Core JSON-RPC client.

export const RPC_IN_WARMUP = -28;

export class RPCError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

// Bitcoin Core isn't listening (not started yet, or stopped).
export class RPCUnavailable extends Error {}

export class RPC {
  private auth: string;

  constructor(private url: string, user: string, pass: string) {
    this.auth = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  }

  async call<T = any>(method: string, params: unknown[] = [], timeoutMs = 10_000): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: this.auth },
        body: JSON.stringify({ jsonrpc: "1.0", id: "nova", method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new RPCUnavailable((err as Error).message);
    }
    if (res.status === 401 || res.status === 403) throw new RPCError(res.status, "RPC authentication failed");
    let body: { result?: T; error?: { code: number; message: string } | null };
    try {
      body = await res.json();
    } catch {
      throw new RPCUnavailable(`Unexpected RPC response (HTTP ${res.status})`);
    }
    if (body.error) throw new RPCError(body.error.code, body.error.message);
    return body.result as T;
  }
}
