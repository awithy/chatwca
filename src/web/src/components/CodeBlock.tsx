import * as React from "react";
import type { ExtraProps } from "react-markdown";

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Try the legacy path when clipboard permissions are unavailable.
    }
  }

  // Plain HTTP LAN deployments do not have the secure-context Clipboard API.
  const activeElement = document.activeElement;
  const selection = window.getSelection();
  const ranges = selection === null ? [] : Array.from(
    { length: selection.rangeCount }, (_, index) => selection.getRangeAt(index),
  );
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0";
  document.body.append(textarea);
  try {
    textarea.select();
    if (!document.execCommand("copy")) throw new Error("Clipboard unavailable");
  } finally {
    textarea.remove();
    if (activeElement instanceof HTMLElement) activeElement.focus({ preventScroll: true });
    if (selection !== null) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
}

export function CodeBlock({
  children,
  node: _node,
  ...props
}: React.ComponentPropsWithoutRef<"pre"> & ExtraProps) {
  const preRef = React.useRef<HTMLPreElement>(null);
  const [status, setStatus] = React.useState<"idle" | "copied" | "failed">("idle");

  React.useEffect(() => {
    if (status === "idle") return;
    const timer = window.setTimeout(() => setStatus("idle"), 2_000);
    return () => window.clearTimeout(timer);
  }, [status]);

  async function copy() {
    const text = preRef.current?.textContent;
    if (text === undefined || text === null) return;
    try {
      await copyText(text);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  }

  return (
    <div className="code-block">
      <div className="code-block-toolbar">
        <span className="code-copy-status" role="status">
          {status === "copied" ? "Copied!" : status === "failed" ? "Copy failed. Select and copy manually." : ""}
        </span>
        <button type="button" className="code-copy-button" aria-label="Copy code" onClick={() => void copy()}>
          Copy
        </button>
      </div>
      <pre {...props} ref={preRef}>{children}</pre>
    </div>
  );
}
