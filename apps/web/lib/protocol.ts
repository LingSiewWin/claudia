import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The protocol document. One source: public/llms-full.txt, served raw to agents and rendered at /protocol. */
export const protocolMarkdown = () => readFileSync(join(process.cwd(), 'public', 'llms-full.txt'), 'utf8');
