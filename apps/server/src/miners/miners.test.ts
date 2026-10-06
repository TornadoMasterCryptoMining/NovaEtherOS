import assert from "node:assert/strict";
import type os from "node:os";
import { describe, test } from "node:test";
import { isMinerInfo, scanTargets, settingsBody, summarize } from "./miners.js";

// Trimmed from a real NovaForge (Bitaxe Gamma 601) /api/system/info response.
const nova = {
  power: 28.75, temp: 56.25, vrTemp: 57.75, hashRate: 1312.08, hashRate_1h: 1264.49,
  bestDiff: 164551315.9, bestSessionDiff: 164551315.9, sharesAccepted: 5936, sharesRejected: 5,
  coreVoltage: 1250, coreVoltageActual: 1244.1, coreVoltageRunning: 1250, frequency: 625, frequencySetting: 625,
  fanspeed: 100, fanrpm: 8244, autofanspeed: 0, manualFanSpeed: 100, temptarget: 60, overheat_mode: 0,
  uptimeSeconds: 81208, ASICModel: "BM1370", deviceModel: "Gamma", boardVersion: "601", asicCount: 1,
  firmware: "NovaForge Mining", version: "2.9.0", state: "mining", poolConnected: true, isUsingFallbackStratum: 0,
  stratumURL: "stratum+tcp://192.168.0.116", stratumPort: 2018, stratumUser: "bc1qexample.rig",
  fallbackStratumURL: "public-pool.io", fallbackStratumPort: 21496,
  hostname: "NovaForge", nickname: "NovaMiner", macAddr: "90:70:69:33:46:2C",
  ssid: "CrazyHorse", webhookMention: "secret", commitActive: false,
};

const iface = (cidr: string): NodeJS.Dict<os.NetworkInterfaceInfo[]> => ({
  docker0: [{ address: "172.17.0.1", netmask: "255.255.0.0", family: "IPv4", mac: "", internal: false, cidr: "172.17.0.1/16" }],
  wlp3s0: [{ address: cidr.split("/")[0], netmask: "", family: "IPv4", mac: "", internal: false, cidr }],
});

describe("miners", () => {
  test("recognises AxeOS-style info", () => {
    assert.equal(isMinerInfo(nova), true);
    assert.equal(isMinerInfo({ hello: "world" }), false);
    assert.equal(isMinerInfo(null), false);
  });

  test("summarises stats without leaking private settings", () => {
    const s = summarize(nova);
    assert.equal(s.hashrate, 1312.08e9);
    assert.equal(s.model, "Gamma 601");
    assert.equal(s.asic, "BM1370");
    assert.ok(Math.abs(s.efficiency! - 28.75 / 1.31208) < 1e-9); // J/TH
    assert.equal(s.frequency, 625);
    assert.equal(s.auto_fan, false);
    assert.equal(s.pool.url, "stratum+tcp://192.168.0.116");
    const json = JSON.stringify(s);
    assert.ok(!json.includes("CrazyHorse") && !json.includes("secret"));
  });

  test("validates settings against the firmware's limits", () => {
    assert.deepEqual(settingsBody({ frequency: 600, coreVoltage: 1200 }), { frequency: 600, coreVoltage: 1200 });
    assert.deepEqual(settingsBody({ autofanspeed: false, manualFanSpeed: 80 }), {
      autofanspeed: 0, manualFanSpeed: 80, fanspeed: 80,
    });
    assert.throws(() => settingsBody({ frequency: 900 }), /frequency must be between 350 and 750/);
    assert.throws(() => settingsBody({ coreVoltage: 1400 }), /coreVoltage/);
    assert.throws(() => settingsBody({ temptarget: 90 }), /temptarget/);
    assert.throws(() => settingsBody({}), /Nothing to change/);
  });

  test("scans the LAN subnet, not Docker's", () => {
    const hosts22 = scanTargets(iface("192.168.0.116/22"));
    assert.equal(hosts22.length, 1021); // 1024 - network - broadcast - ourselves
    assert.equal(hosts22[0], "192.168.0.1");
    assert.equal(hosts22.at(-1), "192.168.3.254");
    assert.ok(!hosts22.includes("192.168.0.116"));
    assert.ok(hosts22.includes("192.168.0.109"));

    const hosts16 = scanTargets(iface("10.0.5.20/16")); // too big: only our /24
    assert.equal(hosts16.length, 253);
    assert.equal(hosts16[0], "10.0.5.1");
  });
});
