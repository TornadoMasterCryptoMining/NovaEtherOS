export interface SystemStats {
  hostname: string;
  os: string;
  uptime: number;
  cpu: { load: number; temp: number | null };
  memory: { used: number; total: number };
  storage: { used: number; total: number } | null;
  battery: { percent: number; charging: boolean } | null;
}

export interface StoreApp {
  id: string;
  name: string;
  tagline: string;
  category: string;
  port: number;
  icon: string;
  installed: boolean;
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body;
}

export const api = {
  system: () => fetch("/api/system").then((r) => json<SystemStats>(r)),
  apps: () => fetch("/api/apps").then((r) => json<StoreApp[]>(r)),
  install: (id: string) => fetch(`/api/apps/${id}/install`, { method: "POST" }).then(json),
  uninstall: (id: string) => fetch(`/api/apps/${id}/uninstall`, { method: "POST" }).then(json),
};

export function formatBytes(n: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i > 2 ? 1 : 0)} ${units[i]}`;
}
