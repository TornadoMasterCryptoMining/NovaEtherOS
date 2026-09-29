// Ported from NovaMiningShop's tests/test_storage.py.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_SETTINGS,
  GB,
  MIB,
  MIN_PRUNE_MIB,
  guardDecision,
  performanceProfile,
  planStorage,
  type HardwareScan,
  type StorageSettings,
} from "./storage.js";

function scan(totalGb: number, freeGb: number, bitcoinGb = 0, pruned = false): HardwareScan {
  return {
    disk_total: totalGb * GB,
    disk_free: freeGb * GB,
    bitcoin_used: bitcoinGb * GB,
    blocks_bytes: 0,
    chainstate_bytes: 0,
    datadir_pruned: pruned,
    has_chain: bitcoinGb > 0,
    ram: 4 * 1024 * MIB,
    cpus: 4,
    arch: "x64",
    model: null,
    rotational: null,
  };
}

const settings = (s: Partial<StorageSettings> = {}): StorageSettings => ({ ...DEFAULT_SETTINGS, ...s });

describe("planStorage", () => {
  test("big disk runs a full node", () => {
    const plan = planStorage(scan(2000, 1800), settings());
    assert.equal(plan.status, "ok");
    assert.equal(plan.mode, "full");
    assert.equal(plan.prune_mib, 0);
  });

  test("1 TB disk prunes to fit", () => {
    const plan = planStorage(scan(1000, 900), settings());
    assert.equal(plan.mode, "pruned");
    // budget = 900 - 50 reserve = 850 GB; blocks = (850 - 20) * 0.85
    assert.equal(plan.prune_mib, Math.floor(((850 - 20) * GB * 0.85) / MIB));
  });

  test("old machine with small SSD prunes", () => {
    const plan = planStorage(scan(128, 90), settings());
    assert.equal(plan.mode, "pruned");
    assert.ok(plan.prune_mib >= MIN_PRUNE_MIB);
    assert.ok(plan.prune_mib * MIB + 20 * GB < 90 * GB);
  });

  test("tiny disk waits for space", () => {
    const plan = planStorage(scan(64, 15), settings());
    assert.equal(plan.status, "insufficient");
    assert.match(plan.reasons[0], /Free up/);
  });

  test("existing bitcoin data counts as available", () => {
    const plan = planStorage(scan(1000, 100, 700), settings());
    assert.equal(plan.status, "ok");
    assert.equal(plan.mode, "pruned");
    assert.ok(plan.prune_mib * MIB > 500 * GB);
  });

  test("pruned datadir does not silently resync", () => {
    const plan = planStorage(scan(4000, 3900, 30, true), settings());
    assert.equal(plan.mode, "pruned");
    assert.equal(plan.full_node_possible, true);
    assert.equal(plan.reindex, false);
  });

  test("forced full on pruned datadir needs confirmation", () => {
    let plan = planStorage(scan(4000, 3900, 30, true), settings({ storage_mode: "full" }));
    assert.equal(plan.mode, "pruned");
    plan = planStorage(scan(4000, 3900, 30, true), settings({ storage_mode: "full", confirm_resync: true }));
    assert.equal(plan.mode, "full");
    assert.equal(plan.reindex, true);
  });

  test("manual prune is capped by disk", () => {
    let plan = planStorage(scan(256, 200), settings({ storage_mode: "prune", prune_gb: 500 }));
    assert.ok(plan.prune_mib * MIB < 200 * GB);
    plan = planStorage(scan(256, 200), settings({ storage_mode: "prune", prune_gb: 10 }));
    assert.equal(plan.prune_mib, Math.floor((10 * GB) / MIB));
  });

  test("custom reserve", () => {
    const plan = planStorage(scan(2000, 1000), settings({ reserve_gb: 200 }));
    assert.equal(plan.reserve_bytes, 200 * GB);
    assert.equal(plan.mode, "pruned"); // 800 GB budget < 900 GB
  });

  test("observed chain size raises requirement", () => {
    const plan = planStorage(scan(2000, 1800), settings(), { observed_full_size: 950 * GB });
    assert.equal(plan.required_full_bytes, 1100 * GB);
  });
});

describe("guardDecision", () => {
  test("no action with enough space", () => {
    assert.equal(guardDecision(scan(500, 200, 100), settings(), {}, 100000), null);
  });

  test("shrinks when disk fills", () => {
    const current = Math.floor((300 * GB) / MIB);
    const reason = guardDecision(scan(500, 5, 300), settings(), {}, current);
    assert.match(reason ?? "", /Free space dropped/);
    assert.ok(planStorage(scan(500, 5, 300), settings()).prune_mib < current);
  });

  test("full node switches to pruning when full", () => {
    const state = { observed_full_size: 900 * GB };
    assert.notEqual(guardDecision(scan(1000, 5, 900), settings(), state, 0), null);
    assert.equal(planStorage(scan(1000, 5, 900), settings(), state).mode, "pruned");
  });

  test("forced full is left alone", () => {
    assert.equal(guardDecision(scan(1000, 5, 900), settings({ storage_mode: "full" }), {}, 0), null);
  });
});

describe("performanceProfile", () => {
  test("tiers", () => {
    assert.equal(performanceProfile(1 * 1024 * MIB, true).tier, "minimal");
    assert.equal(performanceProfile(2 * 1024 * MIB, true).tier, "light");
    assert.equal(performanceProfile(4 * 1024 * MIB, true).tier, "standard");
    assert.equal(performanceProfile(8 * 1024 * MIB, true).tier, "performance");
    assert.equal(performanceProfile(16 * 1024 * MIB, true).tier, "high");
  });

  test("dbcache drops after sync and override wins", () => {
    assert.ok(performanceProfile(8 * 1024 * MIB, true).dbcache > performanceProfile(8 * 1024 * MIB, false).dbcache);
    assert.equal(performanceProfile(8 * 1024 * MIB, false, 777).dbcache, 777);
  });
});
