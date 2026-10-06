import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseDrives } from "./drives.js";

// A MacBook Air: internal SSD (EFI, root, swap), empty SD card reader, and a
// fresh 1 TB USB SSD with a single NTFS partition.
const air = JSON.stringify({
  blockdevices: [
    {
      name: "sda", path: "/dev/sda", size: 251000193024, model: "APPLE SSD SM0256G", tran: "sata", type: "disk",
      fstype: null, label: null, mountpoints: [null], rm: false,
      children: [
        { name: "sda1", path: "/dev/sda1", size: 536870912, type: "part", fstype: "vfat", mountpoints: ["/boot/efi"], rm: false },
        { name: "sda2", path: "/dev/sda2", size: 240000000000, type: "part", fstype: "ext4", mountpoints: ["/"], rm: false },
        { name: "sda3", path: "/dev/sda3", size: 8000000000, type: "part", fstype: "swap", mountpoints: ["[SWAP]"], rm: false },
      ],
    },
    { name: "sdb", path: "/dev/sdb", size: 0, model: "SD Card Reader", tran: "usb", type: "disk", mountpoints: [null], rm: "1" },
    {
      name: "sdc", path: "/dev/sdc", size: 1000204886016, model: "Samsung T7 ", tran: "usb", type: "disk",
      mountpoints: [null], rm: "0",
      children: [{ name: "sdc1", path: "/dev/sdc1", size: 1000202788864, type: "part", fstype: "ntfs", label: "T7", mountpoints: [null] }],
    },
    { name: "loop0", path: "/dev/loop0", size: 4096, type: "loop", mountpoints: ["/snap/x"] },
  ],
});

const noSpace = () => ({ free: null, total: null });

describe("parseDrives", () => {
  test("classifies the Air's drives", () => {
    const drives = parseDrives(air, "/var/lib/novaetheros/bitcoin", noSpace);
    assert.deepEqual(drives.map((d) => d.path), ["/dev/sda", "/dev/sdb", "/dev/sdc"]); // loop devices skipped

    const [internal, reader, ssd] = drives;
    assert.equal(internal.system, true);
    assert.equal(internal.bitcoin, true, "data is on / of the internal disk");
    assert.equal(reader.empty, true);
    assert.equal(reader.removable, true);
    assert.equal(ssd.system, false);
    assert.equal(ssd.empty, false);
    assert.equal(ssd.removable, false);
    assert.equal(ssd.model, "Samsung T7");
    assert.equal(ssd.partitions[0].fstype, "ntfs");
  });

  test("finds the Bitcoin data on the external drive after the move", () => {
    const moved = JSON.parse(air);
    moved.blockdevices[2].children[0].mountpoints = ["/mnt/nova-bitcoin"];
    moved.blockdevices[2].children[0].fstype = "ext4";
    const drives = parseDrives(JSON.stringify(moved), "/mnt/nova-bitcoin/bitcoin", () => ({ free: 9e11, total: 1e12 }));
    assert.equal(drives[0].bitcoin, false);
    assert.equal(drives[2].bitcoin, true);
    assert.equal(drives[2].partitions[0].free, 9e11);
  });

  test("root on LVM/encryption still marks the physical disk as system", () => {
    const lvm = JSON.stringify({
      blockdevices: [{
        name: "sda", path: "/dev/sda", size: 256e9, type: "disk", mountpoints: [null],
        children: [{
          name: "sda3", path: "/dev/sda3", size: 250e9, type: "part", mountpoints: [null],
          children: [{ name: "crypt", path: "/dev/mapper/crypt", size: 250e9, type: "crypt", mountpoints: [null],
            children: [{ name: "vg-root", path: "/dev/mapper/vg-root", size: 240e9, type: "lvm", mountpoints: ["/"] }] }],
        }],
      }],
    });
    assert.equal(parseDrives(lvm, "/var/lib/novaetheros/bitcoin", noSpace)[0].system, true);
  });
});
