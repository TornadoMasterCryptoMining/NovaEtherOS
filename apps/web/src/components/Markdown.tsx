import { Fragment, useState, type ReactNode } from "react";

// Chat-message rendering for Nova AI: fenced code blocks with copy, inline code and bold.

export function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  // The dashboard is plain http on the LAN, where the clipboard API is off.
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
  return Promise.resolve();
}

export function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{lang || "code"}</span>
        <button className="link" onClick={() => copyText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

function inline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>;
    return part;
  });
}

export function Markdown({ text }: { text: string }) {
  // Odd parts are inside ``` fences (an unclosed fence while streaming counts as code).
  const parts = text.split("```");
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 1) {
          const nl = part.indexOf("\n");
          const lang = nl >= 0 ? part.slice(0, nl).trim() : "";
          const code = nl >= 0 ? part.slice(nl + 1) : part;
          return <CodeBlock key={i} lang={lang} code={code.replace(/\n$/, "")} />;
        }
        const body = part.replace(/^\n+|\n+$/g, "");
        if (!body) return null;
        return (
          <div key={i} className="md-text">
            {body.split("\n").map((line, j) => (
              <Fragment key={j}>
                {j > 0 && "\n"}
                {/^#{1,6}\s/.test(line) ? <strong className="md-h">{inline(line.replace(/^#+\s/, ""))}</strong> : inline(line)}
              </Fragment>
            ))}
          </div>
        );
      })}
    </>
  );
}
