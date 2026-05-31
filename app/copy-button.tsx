'use client';

import { useState } from 'react';

export function CopyButton({ text, label = 'Copy blurb' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked (insecure context / permission) — no-op
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={text}
      className="h-7 rounded border border-zinc-300 bg-zinc-100 px-2 text-xs font-medium text-zinc-700 hover:bg-zinc-200 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
    >
      {copied ? 'Copied ✓' : label}
    </button>
  );
}
