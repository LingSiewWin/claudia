'use client';
import { useState } from 'react';

/** Copies `text` exactly as given. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button
      type="button"
      className="btn-quiet font-mono text-[12px]"
      aria-label={`Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState('copied');
        } catch {
          setState('failed');
        }
        setTimeout(() => setState('idle'), 1500);
      }}
    >
      {state === 'copied' ? 'copied' : state === 'failed' ? 'copy failed' : 'copy'}
    </button>
  );
}
