import { Fragment, useCallback, useEffect, useState } from "react";
import { api, formatBytes, type WorkspaceListing } from "../api";
import { Icon } from "./Icons";
import { CodeBlock } from "./Markdown";

export function FilesView() {
  const [dir, setDir] = useState(".");
  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [file, setFile] = useState<{ path: string; content: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    api.aiWorkspace(dir).then((l) => { setListing(l); setErr(null); }).catch((e) => setErr((e as Error).message));
  }, [dir]);
  useEffect(load, [load]);

  const join = (name: string) => (dir === "." ? name : `${dir}/${name}`);
  const crumbs = dir === "." ? [] : dir.split("/");

  async function open(name: string) {
    const p = join(name);
    try {
      setFile({ path: p, content: (await api.aiWorkspaceFile(p)).content });
    } catch (e) {
      setFile({ path: p, content: (e as Error).message });
    }
  }

  return (
    <div className="panels">
      <section className="panel">
        <div className="files-head">
          <div className="crumbs">
            <button className="link" onClick={() => { setDir("."); setFile(null); }}>workspace</button>
            {crumbs.map((c, i) => (
              <Fragment key={i}>
                {" / "}
                <button className="link" onClick={() => { setDir(crumbs.slice(0, i + 1).join("/")); setFile(null); }}>{c}</button>
              </Fragment>
            ))}
          </div>
          <button className="link" onClick={load}>Refresh</button>
        </div>
        {err && <p className="error small">{err}</p>}
        {listing && listing.entries.length === 0 && <p className="muted small">Empty. Ask Nova to build something and its files show up here.</p>}
        <ul className="file-list">
          {listing?.entries.map((e) => (
            <li key={e.name}>
              <button
                className={`file-item ${file?.path === join(e.name) ? "on" : ""}`}
                onClick={() => (e.dir ? (setDir(join(e.name)), setFile(null)) : open(e.name))}
              >
                <Icon name={e.dir ? "folder" : "file"} size={16} />
                <span className="grow mono small">{e.name}</span>
                {!e.dir && <span className="small muted">{formatBytes(e.size)}</span>}
              </button>
            </li>
          ))}
        </ul>
      </section>
      {file && (
        <section className="panel">
          <div className="files-head">
            <b className="mono small">{file.path}</b>
            <button className="link" onClick={() => setFile(null)}>Close</button>
          </div>
          <CodeBlock lang={file.path.split(".").pop() ?? ""} code={file.content} />
        </section>
      )}
    </div>
  );
}
