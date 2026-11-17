'use strict';

/*
 * Markdown for assistant answers in Chat: headings, paragraphs, bold/italic, inline and fenced code, lists
 * (nested by indentation), tables, quotes, rules and http(s) links. Parsing produces a plain tree; rendering builds
 * DOM nodes through the caller's element factory, so model text is never interpreted as HTML. Plain browser
 * JavaScript, loaded before chat.js; it exposes window.chatMarkdown.
 */
(() => {
  const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
  const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const QUOTE = /^\s{0,3}>\s?/;
  const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  // Inline patterns, sticky so the scanner never copies the rest of the string.
  const ESCAPE = /\\([\\`*_[\]()#+\-.!|>~])/y;
  const CODE = /(`+)([\s\S]*?[^`])\1(?!`)/y;
  const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/y;
  const BARE_URL = /https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_`]/y;
  const STRONG = /(\*\*|__)(?=\S)([\s\S]*?\S)\1/y;
  const EM = /(\*|_)(?=[^\s*_])([\s\S]*?[^\s*_])\1(?![*_])/y;

  const at = (re, src, i) => {
    re.lastIndex = i;
    return re.exec(src);
  };
  const wordBefore = (src, i) => i > 0 && /\w/.test(src[i - 1]);

  function parseInline(src) {
    const out = [];
    let text = '';
    const flush = () => {
      if (text) out.push({ type: 'text', text });
      text = '';
    };
    for (let i = 0; i < src.length; ) {
      const c = src[i];
      let m;
      if (c === '\\' && (m = at(ESCAPE, src, i))) {
        text += m[1];
        i += m[0].length;
      } else if (c === '`' && (m = at(CODE, src, i))) {
        flush();
        out.push({ type: 'code', text: /^ .+ $/.test(m[2]) ? m[2].slice(1, -1) : m[2] });
        i += m[0].length;
      } else if (c === '[' && (m = at(LINK, src, i))) {
        flush();
        out.push({ type: 'link', href: m[2], children: parseInline(m[1]) });
        i += m[0].length;
      } else if (c === 'h' && !wordBefore(src, i) && (m = at(BARE_URL, src, i))) {
        flush();
        out.push({ type: 'link', href: m[0], children: [{ type: 'text', text: m[0] }] });
        i += m[0].length;
      } else if ((c === '*' || c === '_') && (m = at(STRONG, src, i)) && (c === '*' || !wordBefore(src, i))) {
        flush();
        out.push({ type: 'strong', children: parseInline(m[2]) });
        i += m[0].length;
      } else if (
        (c === '*' || c === '_') &&
        (m = at(EM, src, i)) &&
        (c === '*' || (!wordBefore(src, i) && !/\w/.test(src[i + m[0].length] ?? '')))
      ) {
        flush();
        out.push({ type: 'em', children: parseInline(m[2]) });
        i += m[0].length;
      } else {
        text += c;
        i++;
      }
    }
    flush();
    return out;
  }

  function splitRow(line) {
    const cells = [];
    let cell = '';
    const body = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '\\' && body[i + 1] === '|') {
        cell += '|';
        i++;
      } else if (body[i] === '|') {
        cells.push(cell.trim());
        cell = '';
      } else cell += body[i];
    }
    cells.push(cell.trim());
    return cells;
  }

  const startsBlock = (lines, i) =>
    FENCE.test(lines[i]) || HEADING.test(lines[i]) || RULE.test(lines[i]) || QUOTE.test(lines[i]) || LIST.test(lines[i]) || isTable(lines, i);
  const isTable = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]) && lines[i + 1].includes('-');

  function parseMarkdown(input) {
    const lines = String(input ?? '').replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if (!line.trim()) {
        i++;
      } else if ((m = FENCE.exec(line))) {
        const fence = m[1];
        const body = [];
        i++;
        while (i < lines.length && !lines[i].trimStart().startsWith(fence[0].repeat(fence.length))) body.push(lines[i++]);
        i++; // closing fence; an unclosed fence runs to the end, as in CommonMark
        blocks.push({ type: 'code', lang: m[2] || '', text: body.join('\n') });
      } else if ((m = HEADING.exec(line))) {
        blocks.push({ type: 'heading', level: m[1].length, children: parseInline(m[2]) });
        i++;
      } else if (RULE.test(line)) {
        blocks.push({ type: 'rule' });
        i++;
      } else if (isTable(lines, i)) {
        const header = splitRow(line);
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
        blocks.push({
          type: 'table',
          header: header.map(parseInline),
          rows: rows.map((r) => header.map((_, c) => parseInline(r[c] ?? ''))),
        });
      } else if (QUOTE.test(line)) {
        const body = [];
        while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].replace(QUOTE, ''));
        blocks.push({ type: 'quote', children: parseMarkdown(body.join('\n')) });
      } else if ((m = LIST.exec(line))) {
        const ordered = /\d/.test(m[2]);
        const base = m[1].length;
        const items = [];
        while (i < lines.length) {
          const lm = LIST.exec(lines[i]);
          if (lm && (lm[1].length > base || /\d/.test(lm[2]) === ordered)) {
            items.push({ level: Math.max(0, Math.floor((lm[1].length - base) / 2)), text: lm[3], ordered: /\d/.test(lm[2]) });
            i++;
          } else if (!lm && items.length && lines[i].trim() && /^\s+/.test(lines[i])) {
            items[items.length - 1].text += `\n${lines[i].trim()}`; // continuation line of the item above
            i++;
          } else break;
        }
        blocks.push({
          type: 'list',
          ordered,
          start: ordered ? Number.parseInt(m[2], 10) : undefined,
          items: items.map((it) => ({ level: it.level, ordered: it.ordered, children: parseInline(it.text) })),
        });
      } else {
        const body = [line.trim()];
        i++;
        while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) body.push(lines[i++].trim());
        blocks.push({ type: 'paragraph', children: parseInline(body.join('\n')) });
      }
    }
    return blocks;
  }

  /** Renders parsed blocks with `h(tag, props, ...children)`, which must create elements and text nodes only. */
  function renderMarkdown(input, h) {
    const inline = (tokens) =>
      tokens.flatMap((t) => {
        if (t.type === 'text') return t.text.split('\n').flatMap((part, n) => (n ? [h('br'), part] : [part])).filter((p) => p !== '');
        if (t.type === 'code') return [h('code', {}, t.text)];
        if (t.type === 'strong') return [h('strong', {}, ...inline(t.children))];
        if (t.type === 'em') return [h('em', {}, ...inline(t.children))];
        if (t.type === 'link') return [h('a', { href: t.href, target: '_blank', rel: 'noopener noreferrer' }, ...inline(t.children))];
        return [];
      });
    const list = (items, from, level, ordered, start) => {
      const element = h(ordered ? 'ol' : 'ul', ordered && start && start !== 1 ? { start: String(start) } : {});
      let i = from;
      while (i < items.length && items[i].level >= level) {
        if (items[i].level > level) {
          const [nested, next] = list(items, i, items[i].level, items[i].ordered);
          (element.lastElementChild ?? element.appendChild(h('li'))).appendChild(nested);
          i = next;
        } else {
          element.appendChild(h('li', {}, ...inline(items[i].children)));
          i++;
        }
      }
      return [element, i];
    };
    const block = (b) => {
      if (b.type === 'heading') return h(`h${Math.min(b.level + 2, 6)}`, {}, ...inline(b.children));
      if (b.type === 'paragraph') return h('p', {}, ...inline(b.children));
      if (b.type === 'code') return h('pre', {}, h('code', b.lang ? { 'data-lang': b.lang } : {}, b.text));
      if (b.type === 'rule') return h('hr');
      if (b.type === 'quote') return h('blockquote', {}, ...b.children.map(block));
      if (b.type === 'list') return list(b.items, 0, 0, b.ordered, b.start)[0];
      if (b.type === 'table') {
        return h(
          'div',
          { class: 'md-table' },
          h(
            'table',
            {},
            h('thead', {}, h('tr', {}, ...b.header.map((c) => h('th', {}, ...inline(c))))),
            h('tbody', {}, ...b.rows.map((r) => h('tr', {}, ...r.map((c) => h('td', {}, ...inline(c)))))),
          ),
        );
      }
      return null;
    };
    return parseMarkdown(input).map(block).filter(Boolean);
  }

  window.chatMarkdown = { parseMarkdown, parseInline, renderMarkdown };
})();
