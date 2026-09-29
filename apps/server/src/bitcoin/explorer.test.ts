import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { Explorer, blockSubsidy, identifyPool } from "./explorer.js";
import { RPC } from "./rpc.js";

describe("blockSubsidy", () => {
  test("halvings", () => {
    assert.equal(blockSubsidy(0), 50e8);
    assert.equal(blockSubsidy(840_000), 3.125e8);
    assert.equal(blockSubsidy(1_050_000), 1.5625e8);
  });
});

describe("identifyPool", () => {
  const hex = (s: string) => Buffer.from(s).toString("hex");
  test("known tags", () => {
    assert.equal(identifyPool("03a1b2c3" + hex("/Foundry USA Pool #dropgold/")), "Foundry USA");
    assert.equal(identifyPool(hex("Mined by AntPool")), "AntPool");
    assert.equal(identifyPool(hex("solo.ckpool.org")), "Solo CK");
  });
  test("unknown", () => {
    assert.equal(identifyPool(hex("hello")), "Unknown");
  });
});

// Fake Bitcoin Core: a 3-block chain, a template and a mempool.
const chain = [
  { hash: "c", prev: "b", height: 900_002, pool: "/AntPool/" },
  { hash: "b", prev: "a", height: 900_001, pool: "/Foundry USA Pool/" },
  { hash: "a", prev: undefined, height: 900_000, pool: "/ViaBTC/" },
];
const calls: string[] = [];

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { method, params } = JSON.parse(body);
    calls.push(method);
    const blk = (h: string) => chain.find((b) => b.hash === h)!;
    const results: Record<string, () => unknown> = {
      getbestblockhash: () => "c",
      getblockheader: () => {
        const b = blk(params[0]);
        return { height: b.height, previousblockhash: b.prev, time: 1_790_000_000, nTx: 3000 };
      },
      getblockstats: () => ({
        total_size: 1_600_000, total_weight: 3_990_000, totalfee: 2_000_000, subsidy: 312_500_000,
        feerate_percentiles: [2, 3, 5, 8, 20],
      }),
      getblock: () => ({ tx: [`cb-${params[0]}`], size: 1_600_000, weight: 3_990_000 }),
      getrawtransaction: () => ({
        vin: [{ coinbase: Buffer.from(blk(params[2]).pool).toString("hex") }],
        vout: [{ value: 3.145, scriptPubKey: { address: "bc1qpayout" } }, { value: 0, scriptPubKey: {} }],
      }),
      getmempoolinfo: () => ({
        size: 12_345, bytes: 5_500_000, usage: 30_000_000, maxmempool: 300_000_000,
        total_fee: 0.25, mempoolminfee: 0.00001,
      }),
      getblocktemplate: () => ({
        height: 900_003,
        coinbasevalue: 312_500_000 + 1_500_000,
        transactions: [
          { fee: 1000, weight: 800 }, // 5 sat/vB
          { fee: 4000, weight: 800 }, // 20 sat/vB
          { fee: 400, weight: 800 }, // 2 sat/vB
        ],
      }),
      estimatesmartfee: () => ({ feerate: params[0] === 1 ? 0.0001 : 0.00002 }),
    };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ result: results[method]?.() ?? null, error: null, id: "nova" }));
  });
});

describe("Explorer", () => {
  let explorer: Explorer;

  before(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    explorer = new Explorer(new RPC(`http://127.0.0.1:${port}`, "u", "p"));
    explorer.start();
    // Let the first refresh finish.
    for (let i = 0; i < 50 && explorer.snapshot().blocks.length < 3; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
  });

  after(() => {
    explorer.stop();
    // fetch keeps connections alive; drop them so the test process can exit.
    server.closeAllConnections();
    server.close();
  });

  test("walks the recent chain from the tip", () => {
    const { blocks } = explorer.snapshot();
    assert.deepEqual(blocks.map((b) => b.height), [900_002, 900_001, 900_000]);
    assert.deepEqual(blocks.map((b) => b.pool), ["AntPool", "Foundry USA", "ViaBTC"]);
    assert.equal(blocks[0].reward, 314_500_000);
    assert.equal(blocks[0].median_feerate, 5);
    assert.deepEqual(blocks[0].feerate_range, [2, 20]);
    assert.equal(blocks[0].payout_address, "bc1qpayout");
  });

  test("projects the next block from the template", () => {
    const n = explorer.snapshot().next_block!;
    assert.equal(n.height, 900_003);
    assert.equal(n.tx_count, 3);
    assert.equal(n.total_fee, 1_500_000);
    assert.equal(n.feerate_min, 2);
    assert.equal(n.feerate_median, 5);
    assert.equal(n.feerate_max, 20);
  });

  test("summarises the mempool and fee estimates", () => {
    const { mempool, fees } = explorer.snapshot();
    assert.equal(mempool!.tx_count, 12_345);
    assert.equal(mempool!.blocks_to_clear, 6);
    assert.equal(mempool!.total_fee, 25_000_000);
    assert.equal(mempool!.min_feerate, 1);
    assert.equal(fees.next_block, 10);
    assert.equal(fees.day, 2);
  });

  test("only fetches each block once", async () => {
    const before = calls.filter((c) => c === "getblockstats").length;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.filter((c) => c === "getblockstats").length, before);
    assert.equal(before, 3);
  });
});
