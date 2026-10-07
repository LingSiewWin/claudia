import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The protocol document. One source: public/llms-full.txt, served raw to agents and rendered at /protocol. */
export const protocolMarkdown = () => readFileSync(join(process.cwd(), 'public', 'llms-full.txt'), 'utf8');
/** The agent summary. One source: public/llms.txt. */
export const summaryMarkdown = () => readFileSync(join(process.cwd(), 'public', 'llms.txt'), 'utf8');
