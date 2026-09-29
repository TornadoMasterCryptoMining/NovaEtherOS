import si from "systeminformation";

export async function getSystemStats() {
  const [load, mem, disks, temp, battery, os, time] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.fsSize(),
    si.cpuTemperature(),
    si.battery(),
    si.osInfo(),
    si.time(),
  ]);

  const root = disks.find((d) => d.mount === "/") ?? disks[0];

  return {
    hostname: os.hostname,
    os: `${os.distro} ${os.release}`,
    uptime: time.uptime,
    cpu: { load: Math.round(load.currentLoad), temp: temp.main ?? null },
    memory: { used: mem.active, total: mem.total },
    storage: root ? { used: root.used, total: root.size } : null,
    // MacBook Air on Debian: battery is read from /sys/class/power_supply
    battery: battery.hasBattery
      ? { percent: battery.percent, charging: battery.isCharging }
      : null,
  };
}
