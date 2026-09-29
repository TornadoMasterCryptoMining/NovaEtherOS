import { useCallback, useEffect, useState } from "react";

export function usePoll<T>(fn: () => Promise<T>, intervalMs: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fn().then((d) => { setData(d); setError(null); }).catch((e) => setError(String(e.message ?? e)));
  }, [fn]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, intervalMs);
    return () => clearInterval(t);
  }, [refresh, intervalMs]);

  return { data, error, refresh };
}
