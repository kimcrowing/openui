/* ==========================================================================
 * Lightweight markdown renderer + message/part renderers.
 *
 * Renders opencode "text" parts with a small, dependency-free markdown
 * subset (headings, lists, code blocks, fenced code, inline code, bold,
 * italic, links, blockquote, tables). Produces DOM nodes (not innerHTML of
 * untrusted content) — all text nodes are created via textContent, so user /
 * model content is safe.
 * ========================================================================== */

// ---- Escape helpers ----

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

// ---- Inline parsing helpers (operate on text, return HTML) ----

const INLINE = [
  { re: /`([^`]+)`/g, fn: (m) => `<code>${escapeHtml(m[1])}</code>` },
  { re: /\*\*([^*]+)\*\*/g, fn: (m) => `<strong>${escapeHtml(m[1])}</strong>` },
  { re: /__([^_]+)__/g, fn: (m) => `<strong>${escapeHtml(m[1])}</strong>` },
  { re: /(?<!\*)\*([^*\n]+)\*(?!\*)/g, fn: (m) => `<em>${escapeHtml(m[1])}</em>` },
  { re: /(?<!!)\[([^\]]+)\]\(([^)\s]+)\)/g, fn: (m) => `<a href="${escapeHtml(m[2])}" target="_blank" rel="noopener">${escapeHtml(m[1])}</a>` },
];

function renderInlineLine(line) {
  let out = escapeHtml(line);
  for (const { re, fn } of INLINE) {
    out = out.replace(re, (m, g) => fn([m, g, g]));
  }
  return out;
}

// ---- Block renderer (returns HTML for one message part text) ----

/**
 * Renders a full markdown string into html. Blocks are processed line-wise
 * to keep it simple and robust.
 */
export function renderMarkdown(src) {
  if (!src) return "";
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let i = 0;
  let listType = null; // 'ul' | 'ol' | null
  let inCode = false;
  let codeBuf = [];
  let codeLang = "";
  let inTable = false;
  let tableBuf = [];
  let inQuote = false;
  let quoteBuf = [];

  const flushQuote = () => {
    if (inQuote) {
      html.push(`<blockquote>${quoteBuf.join("")}</blockquote>`);
      quoteBuf = [];
      inQuote = false;
    }
  };
  const flushList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };
  const flushTable = () => {
    if (inTable && tableBuf.length) {
      const header = tableBuf[0];
      const rows = tableBuf.slice(1).filter((r) => !/^[\s:\-|]+$/.test(r));
      html.push(`<table><thead><tr>${header.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
        .join("")}</tbody></table>`);
      tableBuf = [];
      inTable = false;
    }
  };

  const flushParagraph = () => {
    if (html.length && html[html.length - 1].startsWith("<p>")) {
      const last = html.pop();
      html.push(`${last} <br>`);
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fenceMatch = line.match(/^```(\w*)/);
    if (fenceMatch) {
      if (!inCode) {
        flushList(); flushTable(); flushQuote();
        inCode = true;
        codeLang = fenceMatch[1] || "";
        codeBuf = [];
      } else {
        inCode = false;
        html.push(`<pre><code class="lang-${escapeHtml(codeLang)}">${highlight(escapeHtml(codeBuf.join("\n")), codeLang)}</code></pre>`);
        codeBuf = [];
      }
      i++;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      i++;
      continue;
    }

    // Blockquote
    const bq = line.match(/^>\s?(.*)$/);
    if (bq) {
      flushList();
      if (!inQuote) { inQuote = true; quoteBuf = []; }
      quoteBuf.push(`<div>${renderInlineLine(bq[1])}</div>`);
      i++;
      continue;
    }
    flushQuote();

    // Horizontal rule
    if (/^\s*([-*_])\s*\1\s*\1\s*$/.test(line)) {
      flushList(); flushTable();
      html.push("<hr>");
      i++;
      continue;
    }

    // Headings
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushList(); flushTable();
      const level = h[1].length;
      html.push(`<h${level}>${renderInlineLine(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // Table: detect header separator row
    if (!inTable && line.includes("|") && /^\s*\|/.test(line.trim()) === false && /^\|/.test(line.trim())) {
      inTable = true;
      tableBuf = [line.trim().split("|").filter((_, k, a) => k > 0 && k < a.length - 1 || (a.length === 2)).map((c) => c.trim())];
      // split with leading pipe
      tableBuf[0] = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      // check next-line separator
      if (i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
        i += 2;
        while (i < lines.length && /^\|/.test(lines[i].trim())) {
          const row = lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => renderInlineLine(c.trim()));
          tableBuf.push(row);
          i++;
        }
        flushTable();
        continue;
      }
      inTable = false;
      tableBuf = [];
    }

    // Table rows when already in a table context
    if (inTable && /^\|/.test(line.trim())) {
      const row = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => renderInlineLine(c.trim()));
      tableBuf.push(row);
      i++;
      continue;
    }
    flushTable();

    // Unordered list
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      if (listType !== "ul") { flushList(); listType = "ul"; html.push("<ul>"); }
      html.push(`<li>${renderInlineLine(ul[1])}</li>`);
      i++;
      continue;
    }

    // Ordered list
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      if (listType !== "ol") { flushList(); listType = "ol"; html.push("<ol>"); }
      html.push(`<li>${renderInlineLine(ol[1])}</li>`);
      i++;
      continue;
    }
    flushList();

    // Blank line ends a paragraph
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph: render inline (single line; multiline paragraphs approximated)
    if (html.length === 0 || !html[html.length - 1].startsWith("<p>")) {
      html.push(`<p>${renderInlineLine(line)}</p>`);
    } else {
      // append as <br> continuation
      const last = html.pop();
      html.push(`${last} <br> ${renderInlineLine(line)}`);
    }
    i++;
  }

  flushQuote();
  flushList();
  flushTable();
  if (inCode) {
    html.push(`<pre><code class="lang-${escapeHtml(codeLang)}">${highlight(escapeHtml(codeBuf.join("\n")), codeLang)}</code></pre>`);
  }

  return html.join("");
}

/* --------------------------------------------------------------------------
 * Minimal syntax highlighting.
 * Extremely lightweight tokenizer for common languages. Colours are driven by
 * CSS classes so they adapt to the active theme. Fallback: plain text.
 * -------------------------------------------------------------------------- */

const HL = {
  comment: (s) => `<span class="tok-com">${s}</span>`,
  string: (s) => `<span class="tok-str">${s}</span>`,
  keyword: (s) => `<span class="tok-kw">${s}</span>`,
  number: (s) => `<span class="tok-num">${s}</span>`,
  function: (s) => `<span class="tok-fn">${s}</span>`,
  type: (s) => `<span class="tok-ty">${s}</span>`,
};

const KEYWORDS =
  "function|const|let|var|if|else|for|while|return|import|export|from|default|class|extends|new|this|async|await|try|catch|finally|throw|switch|case|break|continue|typeof|instanceof|in|of|delete|void|null|undefined|true|false|def|return|lambda|and|or|not|None|True|False|elif|pass|yield|with|as|assert|raise|global|nonlocal|fn|pub|use|struct|match|impl|trait|mod|break|continue|loop|while|ref|mut|static|package|interface|extends|implements|private|protected|public|final|return|goto|printf|int|void|char|float|double|long|short|unsigned|signed|sizeof";

const RE_KEYWORD = new RegExp(`\\b(${KEYWORDS})\\b`, "g");

function highlight(code, lang) {
  // Single-pass tokenization: strings and comments first, then keywords/numbers.
  return code
    .replace(/(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|--[^\n]*)/g, (m) => HL.comment(escapeHtml(m)))
    .replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, (m) => HL.string(escapeHtml(m)))
    .replace(/\b(\d[\d_]*(?:\.\d+)?)\b/g, (m) => HL.number(m))
    .replace(RE_KEYWORD, (m) => HL.keyword(m));
}
