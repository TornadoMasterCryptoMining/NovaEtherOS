import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { addressToScript } from "./address.js";
import {
  bitsToTarget,
  buildHeader,
  fromDisplayHex,
  merkleRoot,
  merkleRootFromSteps,
  merkleSteps,
  reverse,
  scriptNumPush,
  sha256d,
} from "./bitcoin-utils.js";
import { SoloPool } from "./pool.js";
import { RPC } from "../bitcoin/rpc.js";

describe("header hashing", () => {
  // Mainnet block 125552, the classic worked example of Bitcoin's header hash.
  test("reproduces a real block hash", () => {
    const header = buildHeader({
      version: 1,
      prevHash: fromDisplayHex("00000000000008a3a41b85b8b29ad444def299fee21793cd8b9e567eab02cd81"),
      merkleRoot: fromDisplayHex("2b12fcf1b09288fcaff797d71e950e71ae42b91e8bdb2304758dfcffc2b620e3"),
      time: 1305998791,
      bits: 0x1a44b9f2,
      nonce: 2504433986,
    });
    const hash = sha256d(header);
    assert.equal(reverse(hash).toString("hex"), "00000000000000001e8d6829a8a21adc5d38d0a473b144b6765798e61f98bd1d");
    assert.ok(BigInt("0x" + reverse(hash).toString("hex")) <= bitsToTarget(0x1a44b9f2));
  });

  test("merkle steps give the same root as the full tree", () => {
    for (let n = 0; n <= 9; n++) {
      const coinbase = crypto.randomBytes(32);
      const txs = Array.from({ length: n }, () => crypto.randomBytes(32));
      assert.ok(merkleRootFromSteps(coinbase, merkleSteps(txs)).equals(merkleRoot([coinbase, ...txs])), `n=${n}`);
    }
  });

  test("BIP34 height encoding", () => {
    assert.equal(scriptNumPush(918_433).toString("hex"), "03a1030e");
    assert.equal(scriptNumPush(128).toString("hex"), "028000");
    assert.equal(scriptNumPush(255).toString("hex"), "02ff00");
    assert.equal(scriptNumPush(256).toString("hex"), "020001");
    assert.equal(scriptNumPush(8_388_608).toString("hex"), "0400008000");
  });
});

describe("addresses", () => {
  const hex = (a: string, n: "main" | "test" = "main") => addressToScript(a, n)?.toString("hex") ?? null;

  test("segwit v0 (bech32)", () => {
    assert.equal(hex("BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4"), "0014751e76e8199196d454941c45d1b3a323f1433bd6");
    assert.equal(hex("bc1q2f8twt99as72gcrzq4rn9jklp5sk0v2esvj8d4")?.slice(0, 4), "0014");
  });

  test("taproot (bech32m)", () => {
    assert.equal(
      hex("bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0"),
      "512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    );
  });

  test("legacy base58", () => {
    assert.equal(hex("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"), "76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac");
    assert.match(hex("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy") ?? "", /^a914[0-9a-f]{40}87$/);
  });

  test("rejects bad or wrong-network addresses", () => {
    assert.equal(hex("bc1q2f8twt99as72gcrzq4rn9jklp5sk0v2esvj8d5"), null); // bad checksum
    assert.equal(hex("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb"), null);
    assert.equal(hex("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"), null); // testnet on mainnet
    assert.equal(hex("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", "test"), "0014751e76e8199196d454941c45d1b3a323f1433bd6");
    assert.equal(hex("hello"), null);
  });
});

// --- end-to-end: a simulated miner mines a block through the pool ------------

const PAYOUT = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
const PAYOUT_SCRIPT = "0014751e76e8199196d454941c45d1b3a323f1433bd6";
const COMMITMENT = "6a24aa21a9ed" + "ab".repeat(32);

function fakeTx(seed: string) {
  const data = Buffer.concat([Buffer.from("02000000", "hex"), crypto.createHash("sha256").update(seed).digest()]);
  const txid = reverse(sha256d(data)).toString("hex");
  return { data: data.toString("hex"), txid, hash: txid, fee: 1000, weight: 400 };
}

const template = {
  version: 0x20000000,
  previousblockhash: "0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206",
  transactions: [fakeTx("a"), fakeTx("b"), fakeTx("c")],
  coinbasevalue: 5_000_003_000,
  bits: "207fffff", // regtest: almost every hash is a valid block
  height: 250,
  curtime: Math.floor(Date.now() / 1000),
  mintime: Math.floor(Date.now() / 1000) - 3600,
  default_witness_commitment: COMMITMENT,
};

const submitted: string[] = [];
const proposals: string[] = [];

const rpcServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { method, params } = JSON.parse(body);
    let result: unknown = null;
    if (method === "getbestblockhash") result = template.previousblockhash;
    if (method === "getblocktemplate") {
      if (params?.[0]?.mode === "proposal") proposals.push(params[0].data);
      else result = template;
    }
    if (method === "submitblock") submitted.push(params[0]);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ result, error: null, id: "nova" }));
  });
});

// Minimal stratum client, written from the protocol spec independently of the pool.
class TestMiner {
  private socket!: net.Socket;
  private buffer = "";
  private nextId = 1;
  private waiting = new Map<number, (msg: any) => void>();
  notifications: any[] = [];

  async connect(port: number) {
    this.socket = net.connect(port, "127.0.0.1");
    await new Promise((r) => this.socket.once("connect", r));
    this.socket.on("data", (d) => {
      this.buffer += d.toString();
      let nl;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const msg = JSON.parse(this.buffer.slice(0, nl));
        this.buffer = this.buffer.slice(nl + 1);
        if (msg.method) this.notifications.push(msg);
        else this.waiting.get(msg.id)?.(msg);
      }
    });
  }

  call(method: string, params: unknown[]): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.socket.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  async waitFor(method: string) {
    for (let i = 0; i < 200; i++) {
      const n = this.notifications.find((m) => m.method === method);
      if (n) return n;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no ${method}`);
  }

  close() {
    this.socket.destroy();
  }
}

// Stratum prevhash (word-swapped) -> internal byte order.
function prevFromStratum(hex: string) {
  const b = Buffer.from(hex, "hex");
  const out = Buffer.alloc(32);
  for (let i = 0; i < 32; i += 4) out.writeUInt32LE(b.readUInt32BE(i), i);
  return out;
}

function readVarint(buf: Buffer, pos: number): [number, number] {
  const first = buf[pos];
  if (first < 0xfd) return [first, pos + 1];
  if (first === 0xfd) return [buf.readUInt16LE(pos + 1), pos + 3];
  return [buf.readUInt32LE(pos + 1), pos + 5];
}

describe("solo pool end to end", () => {
  let pool: SoloPool;
  let dataDir: string;

  before(async () => {
    await new Promise<void>((r) => rpcServer.listen(0, "127.0.0.1", r));
    const { port } = rpcServer.address() as AddressInfo;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-pool-"));
    pool = new SoloPool({
      rpc: new RPC(`http://127.0.0.1:${port}`, "u", "p"),
      isNodeReady: () => true,
      dataDir,
      port: 0,
      host: "127.0.0.1",
      network: "test",
      log: () => undefined,
    });
    await pool.start();
    for (let i = 0; i < 100 && !pool.snapshot().ready; i++) await new Promise((r) => setTimeout(r, 20));
  });

  after(async () => {
    await pool.stop();
    rpcServer.closeAllConnections();
    rpcServer.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test("rejects a username that isn't a valid address", async () => {
    const miner = new TestMiner();
    await miner.connect(pool.port);
    await miner.call("mining.subscribe", ["test/1.0"]);
    const res = await miner.call("mining.authorize", ["not-an-address.rig", "x"]);
    assert.equal(res.result, null);
    assert.equal(res.error[0], 24);
    miner.close();
  });

  test("mines a block that decodes to exactly what Bitcoin expects", async () => {
    const miner = new TestMiner();
    await miner.connect(pool.port);

    const conf = await miner.call("mining.configure", [["version-rolling"], { "version-rolling.mask": "ffffffff" }]);
    const mask = parseInt(conf.result["version-rolling.mask"], 16);
    assert.equal(mask, 0x1fffe000);

    const sub = await miner.call("mining.subscribe", ["test/1.0"]);
    const extranonce1 = Buffer.from(sub.result[1], "hex");
    assert.equal(sub.result[2], 4);
    await miner.call("mining.suggest_difficulty", [0.0001]);
    const auth = await miner.call("mining.authorize", [`${PAYOUT}.rig1`, "x"]);
    assert.equal(auth.result, true);

    const notify = await miner.waitFor("mining.notify");
    const [jobId, prevhash, coinb1, coinb2, branches, versionHex, nbitsHex, ntimeHex] = notify.params;

    // Mine: find a nonce whose hash meets the (easy) network target.
    const extranonce2 = Buffer.from("0000002a", "hex");
    const coinbase = Buffer.concat([Buffer.from(coinb1, "hex"), extranonce1, extranonce2, Buffer.from(coinb2, "hex")]);
    let root = sha256d(coinbase);
    for (const b of branches) root = sha256d(Buffer.concat([root, Buffer.from(b, "hex")]));
    const versionBits = 0x00002000 << 3; // roll a bit inside the mask
    const version = (parseInt(versionHex, 16) & ~mask) | (versionBits & mask);
    const bits = parseInt(nbitsHex, 16);
    const ntime = parseInt(ntimeHex, 16);
    let nonce = 0;
    let header: Buffer;
    for (;; nonce++) {
      header = buildHeader({ version, prevHash: prevFromStratum(prevhash), merkleRoot: root, time: ntime, bits, nonce });
      if (BigInt("0x" + reverse(sha256d(header)).toString("hex")) <= bitsToTarget(bits)) break;
    }

    const params = ["rig1", jobId, extranonce2.toString("hex"), ntimeHex, nonce.toString(16).padStart(8, "0"),
      (versionBits & mask).toString(16).padStart(8, "0")];
    const res = await miner.call("mining.submit", params);
    assert.equal(res.error, null);
    assert.equal(res.result, true);
    assert.equal(submitted.length, 1);

    // --- decode the submitted block independently ---
    const block = Buffer.from(submitted[0], "hex");
    assert.ok(block.subarray(0, 80).equals(header!), "header matches what the miner hashed");
    let pos = 80;
    let txCount;
    [txCount, pos] = readVarint(block, pos);
    assert.equal(txCount, 4);

    // Coinbase with witness: version | 00 01 | inputs | outputs | witness | locktime
    const cbStart = pos;
    assert.equal(block.readUInt32LE(pos), 2);
    assert.equal(block.subarray(pos + 4, pos + 6).toString("hex"), "0001", "segwit marker");
    pos += 6;
    let n;
    [n, pos] = readVarint(block, pos);
    assert.equal(n, 1);
    assert.ok(block.subarray(pos, pos + 32).equals(Buffer.alloc(32)));
    pos += 36;
    let scriptLen;
    [scriptLen, pos] = readVarint(block, pos);
    const scriptSig = block.subarray(pos, pos + scriptLen);
    assert.equal(scriptSig.subarray(0, 3).toString("hex"), "02fa00", "BIP34 height 250");
    assert.ok(scriptSig.includes(Buffer.concat([extranonce1, extranonce2])));
    assert.ok(scriptLen >= 2 && scriptLen <= 100);
    pos += scriptLen + 4;
    [n, pos] = readVarint(block, pos);
    assert.equal(n, 2);
    const value = block.readBigUInt64LE(pos);
    assert.equal(value, BigInt(template.coinbasevalue));
    pos += 8;
    [scriptLen, pos] = readVarint(block, pos);
    assert.equal(block.subarray(pos, pos + scriptLen).toString("hex"), PAYOUT_SCRIPT, "pays the miner's address");
    pos += scriptLen;
    assert.equal(block.readBigUInt64LE(pos), 0n);
    pos += 8;
    [scriptLen, pos] = readVarint(block, pos);
    assert.equal(block.subarray(pos, pos + scriptLen).toString("hex"), COMMITMENT, "witness commitment");
    pos += scriptLen;
    assert.equal(block.subarray(pos, pos + 34).toString("hex"), "0120" + "00".repeat(32), "witness reserved value");
    pos += 34;
    assert.equal(block.readUInt32LE(pos), 0, "locktime");
    pos += 4;
    const cbWithWitness = block.subarray(cbStart, pos);

    // The rest is the template's transactions, unchanged.
    assert.equal(block.subarray(pos).toString("hex"), template.transactions.map((t) => t.data).join(""));

    // txid = hash of the coinbase without witness; the merkle root must match.
    const stripped = Buffer.concat([
      cbWithWitness.subarray(0, 4),
      cbWithWitness.subarray(6, cbWithWitness.length - 4 - 34),
      cbWithWitness.subarray(cbWithWitness.length - 4),
    ]);
    const root2 = merkleRoot([sha256d(stripped), ...template.transactions.map((t) => fromDisplayHex(t.txid))]);
    assert.ok(block.subarray(36, 68).equals(root2), "merkle root commits to every transaction");

    const snap = pool.snapshot();
    assert.equal(snap.found.length, 1);
    assert.equal(snap.found[0].accepted, true);
    assert.equal(snap.found[0].address, PAYOUT);

    // Same share again is a duplicate; an unknown job is stale.
    const dup = await miner.call("mining.submit", params);
    assert.equal(dup.error[0], 22);
    const stale = await miner.call("mining.submit", ["rig1", "zzz", "00000000", ntimeHex, "00000000"]);
    assert.equal(stale.error[0], 21);
    miner.close();
  });

  test("self-test sends Bitcoin Core a proposal block", () => {
    assert.ok(proposals.length >= 1);
    const proposal = Buffer.from(proposals[0], "hex");
    assert.equal(proposal.length > 80, true);
    assert.equal(pool.snapshot().selftest?.ok, true);
  });
});
