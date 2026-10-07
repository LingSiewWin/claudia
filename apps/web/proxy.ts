import { type NextRequest, NextResponse } from 'next/server';
import { wantsPlain } from './lib/mode';

/** Agents that ask `/` for text, or announce themselves as LLM fetchers, get /llms.txt as text/plain. Browsers get HTML. */
export function proxy(request: NextRequest) {
  if (wantsPlain(request.headers.get('accept'), request.headers.get('user-agent'))) {
    return NextResponse.rewrite(new URL('/llms.txt', request.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ['/'] };
