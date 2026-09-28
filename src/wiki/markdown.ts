import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false });
export interface Heading { title: string; anchor: string; level: number; start: number; end: number }

/** CommonMark: ссылки из кода не становятся рёбрами; reference links разрешает парсер. */
export function markdown(body: string): { headings: Heading[]; links: string[]; text: string } {
  const tokens = md.parse(body, {});
  const lineCount = body.split('\n').length;
  const headings: Heading[] = [];
  const links: string[] = [];
  const used = new Set<string>();
  const texts: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.type === 'heading_open') {
      const inline = tokens[i + 1]!;
      const title = (inline.children ?? []).filter(t => ['text', 'code_inline', 'image'].includes(t.type)).map(t => t.content).join('');
      const base = title.toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-');
      let anchor = base;
      let n = 0;
      while (used.has(anchor)) anchor = `${base}-${++n}`;
      used.add(anchor);
      headings.push({ title, anchor, level: Number(token.tag.slice(1)), start: token.map![0], end: lineCount });
    }
    if (token.type === 'fence' || token.type === 'code_block') texts.push(token.content);
    if (token.type === 'inline') {
      texts.push(token.content);
      for (const child of token.children ?? []) {
        if (child.type === 'link_open') links.push(String(child.attrGet('href') ?? ''));
        if (child.type === 'image') links.push(String(child.attrGet('src') ?? ''));
      }
    }
  }
  for (let i = 0; i < headings.length; i++) {
    headings[i]!.end = headings.slice(i + 1).find(h => h.level <= headings[i]!.level)?.start ?? lineCount;
  }
  return { headings, links, text: texts.join('\n') };
}
