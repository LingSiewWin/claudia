import { blockTitle, splitBlocks } from '../lib/mode';
import { protocolMarkdown, summaryMarkdown } from '../lib/protocol';
import { CopyButton } from './copy-button';

const RAW = ['/llms.txt', '/llms-full.txt', '/.well-known/agent.json'];
const CURL = 'curl -s https://claudy.vercel.app/llms.txt';

/**
 * The landing page for an agent: the two files this site serves to machines, rendered verbatim with a copy button per
 * block. Same bytes as /llms.txt and /llms-full.txt (lib/protocol reads the served files; splitBlocks concatenates back).
 */
export function AgentSurface() {
  const files = [
    { path: '/llms.txt', text: summaryMarkdown() },
    { path: '/llms-full.txt', text: protocolMarkdown() },
  ];
  return (
    <section aria-label="Agent reader" data-testid="agent-surface" className="mt-8 font-mono text-[13.5px] leading-relaxed">
      <p className="flex flex-wrap gap-x-5 gap-y-1">
        {RAW.map((p) => (
          <a key={p} href={p} className="underline underline-offset-4" target="_blank" rel="noreferrer">
            {p}
          </a>
        ))}
      </p>
      <p className="mt-3 flex flex-wrap items-baseline gap-x-3">
        <code className="rounded-[4px] border border-line bg-raised px-2 py-0.5">{CURL}</code>
        <CopyButton text={CURL} label="curl example" />
      </p>
      {files.map((f) => (
        <article key={f.path} data-testid="agent-file" data-path={f.path} className="mt-10 border-t border-line pt-4">
          <p className="flex items-baseline justify-between gap-4">
            <a href={f.path} className="font-bold text-heading underline underline-offset-4" target="_blank" rel="noreferrer">
              {f.path}
            </a>
            <CopyButton text={f.text} label={f.path} />
          </p>
          {splitBlocks(f.text).map((block, i) => (
            <div key={i} data-testid="agent-block" className="group relative mt-4">
              <div className="absolute top-0 right-0">
                <CopyButton text={block} label={blockTitle(block)} />
              </div>
              <pre className="overflow-x-auto pr-16 whitespace-pre-wrap">{block}</pre>
            </div>
          ))}
        </article>
      ))}
    </section>
  );
}
