/*
 * Minimal Markdown -> HTML for the protocol document (public/llms-full.txt), which is written to use only:
 * #/##/### headings, paragraphs, `- ` lists with `1. ` lists, fenced code blocks, inline code, bold, links,
 * and `-> `. Everything is HTML-escaped first; the only HTML that comes out is what this file emits.
 * ponytail: not a general Markdown parser; add constructs here when the document needs them.
 */

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Inline: code spans first (their content is literal), then bold and links on the rest. */
export function inline(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) => {
      if (i % 2 === 1) return `<code>${escape(part.slice(1, -1))}</code>`;
      let html = escape(part);
      html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, href: string) =>
        /^(https?:\/\/|\/|#)/.test(href) ? `<a href="${href}">${label}</a>` : label,
      );
      // Bare URLs become links; the closing paren of "(https://x/)" is not part of the URL.
      html = html.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre: string, url: string) => `${pre}<a href="${url}">${url}</a>`);
      return html;
    })
    .join('');
}

export interface Heading {
  level: number;
  text: string;
  id: string;
}

export function render(md: string): { html: string; headings: Heading[] } {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  const headings: Heading[] = [];
  let i = 0;
  const paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) out.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i] as string;
    const fence = /^```(\w*)$/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== '```') code.push(lines[i] as string), i++;
      i++;
      out.push(`<pre><code${fence[1] ? ` class="lang-${fence[1]}"` : ''}>${escape(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    if (heading) {
      flush();
      const level = (heading[1] as string).length;
      const text = heading[2] as string;
      const id = slug(text);
      headings.push({ level, text: text.replace(/`/g, ''), id });
      out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      i++;
      continue;
    }
    const quote = /^> (.+)$/.exec(line);
    if (quote) {
      flush();
      out.push(`<blockquote><p>${inline(quote[1] as string)}</p></blockquote>`);
      i++;
      continue;
    }
    const list = /^(?:- |(\d+)\. )/.exec(line);
    if (list) {
      flush();
      const ordered = list[1] !== undefined;
      const items: string[] = [];
      while (i < lines.length && /^(?:- |\d+\. )/.test(lines[i] as string)) {
        items.push(`<li>${inline((lines[i] as string).replace(/^(?:- |\d+\. )/, ''))}</li>`);
        i++;
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    if (line.trim() === '') flush();
    else paragraph.push(line.trim());
    i++;
  }
  flush();
  return { html: out.join('\n'), headings };
}
