/**
 * Release notes arrive as Markdown (latest.json `notes`, or a GitHub release
 * body), and every update surface shows them — the card injected into the Web
 * UI settings dialog, the client's own connection-settings page, and the
 * update prompt window. Rendering them as plain text prints the source, so
 * the conversion lives here.
 *
 * The notes come off the network, so this is a closed subset with every piece
 * of text escaped: no raw HTML passes through, and only http(s) links become
 * anchors. Anchors carry target=_blank, and EVERY window that renders this
 * HTML answers that with an external open — the settings window included,
 * which is why its window-open handler is no longer a blanket deny.
 *
 * `renderReleaseNotesText`, the plain-text rendering the old native update
 * dialog needed, is kept only for the updater checks (scripts/check-updater.mjs).
 * @module dsh-desktop/release-notes
 */

/** Inline spans, in match order: code, link, bold, strike, italic. */
const INLINE_PATTERN = new RegExp(
  '(`+)([^`]+?)\\1'
  // The href allows one level of nested parentheses, so a wikipedia-style
  // link does not end at the first ')' and spill its tail into the text.
  + '|\\[([^\\]]*)\\]\\(((?:[^()\\s]|\\([^()\\s]*\\))+)\\)'
  // Bold takes single markers inside it — '**a *b* c**' — so the emphasis
  // branch below cannot claim the inner one and split the pair. Both
  // alternatives start with a different character, so there is nothing to
  // backtrack over.
  + '|\\*\\*((?:[^*]|\\*(?!\\*))+?)\\*\\*|__((?:[^_]|_(?!_))+?)__'
  + '|~~([^~]+)~~'
  + '|\\*([^*]+)\\*|(?<![A-Za-z0-9_])_([^_]+)_(?![A-Za-z0-9_])',
  'g',
)

const BULLET = /^\s*[-*+]\s+(.*)$/
const ORDERED = /^\s*\d+[.)]\s+(.*)$/
const HEADING = /^(#{1,6})\s+(.*)$/
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const QUOTE = /^\s*>\s?(.*)$/
const FENCE = /^\s*(?:```|~~~)(.*)$/

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Only web links become anchors; anything else (javascript:, data:) stays text. */
function renderLink(text: string, href: string): string {
  const label = renderInline(text === '' ? href : text)
  const trimmed = href.trim()
  if (!/^https?:\/\//i.test(trimmed)) return label
  return '<a href="' + escapeHtml(trimmed) + '" target="_blank" rel="noreferrer noopener">' + label + '</a>'
}

export function renderInline(text: string): string {
  let out = ''
  let last = 0
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index
    out += escapeHtml(text.slice(last, index))
    last = index + match[0].length
    const code = match[2]
    const linkText = match[3]
    const linkHref = match[4]
    const strong = match[5] ?? match[6]
    const strike = match[7]
    const emphasis = match[8] ?? match[9]
    if (code !== undefined) out += '<code>' + escapeHtml(code.trim()) + '</code>'
    else if (linkHref !== undefined) out += renderLink(linkText ?? '', linkHref)
    else if (strong !== undefined) out += '<strong>' + renderInline(strong) + '</strong>'
    else if (strike !== undefined) out += '<del>' + renderInline(strike) + '</del>'
    else if (emphasis !== undefined) out += '<em>' + renderInline(emphasis) + '</em>'
  }
  return out + escapeHtml(text.slice(last))
}

/** The same inline subset with the markers dropped instead of translated. */
function plainInline(text: string): string {
  let out = ''
  let last = 0
  for (const match of text.matchAll(INLINE_PATTERN)) {
    out += text.slice(last, match.index)
    last = match.index + match[0].length
    const code = match[2]
    const linkText = match[3]
    const linkHref = match[4]
    if (code !== undefined) out += code.trim()
    else if (linkHref !== undefined) out += linkText === undefined || linkText === '' ? linkHref : plainInline(linkText)
    else out += plainInline(match[5] ?? match[6] ?? match[7] ?? match[8] ?? match[9] ?? '')
  }
  return out + text.slice(last)
}

/**
 * Markdown → plain text for a native dialog, which takes no markup: the
 * structure survives as bullets and blank lines, the markers do not.
 */
export function renderReleaseNotesText(markdown: string): string {
  const lines = markdown.trim().split(/\r?\n/)
  const out: string[] = []
  let fenced = false
  for (const line of lines) {
    if (FENCE.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) {
      out.push(line)
      continue
    }
    if (line.trim() === '' || RULE.test(line)) {
      out.push('')
      continue
    }
    const heading = HEADING.exec(line)
    if (heading !== null) {
      out.push('', plainInline(heading[2] ?? ''))
      continue
    }
    const quote = QUOTE.exec(line)
    if (quote !== null) {
      out.push(plainInline(quote[1] ?? ''))
      continue
    }
    const bullet = BULLET.exec(line)
    if (bullet !== null) {
      out.push('• ' + plainInline(bullet[1] ?? ''))
      continue
    }
    if (ORDERED.test(line)) {
      out.push(plainInline(line.trim()))
      continue
    }
    if (isTableDivider(line)) continue
    if (line.includes('|')) {
      out.push(tableCells(line).map(plainInline).join('  '))
      continue
    }
    out.push(plainInline(line.trim()))
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export interface ReleaseNotesTokens {
  /** Body text. */
  text: string
  /** Headings, bold, table headers — the emphasized foreground. */
  strong: string
  /** Rules, table cells, the quote bar. */
  border: string
  /** Code and quote backgrounds. */
  surface: string
}

/**
 * The rules that style `renderReleaseNotes` output, for a given container
 * selector and palette. Both surfaces render the same HTML, so they read the
 * same stylesheet rather than keeping two copies in step by hand.
 */
export function releaseNotesCss(selector: string, tokens: ReleaseNotesTokens): string {
  const each = (...children: string[]): string => children.map((child) => selector + ' ' + child).join(',')
  return [
    selector + '{margin:0 0 10px;font-size:13px;line-height:1.65;color:' + tokens.text + ';max-height:220px;overflow:auto}',
    each('>:first-child') + '{margin-top:0}',
    each('>:last-child') + '{margin-bottom:0}',
    each('h3', 'h4', 'h5', 'h6') + '{margin:12px 0 6px;font-size:13px;font-weight:600;color:' + tokens.strong + '}',
    each('p') + '{margin:0 0 8px}',
    each('ul', 'ol') + '{margin:0 0 8px;padding-left:18px}',
    each('li') + '{margin:2px 0}',
    each('strong') + '{font-weight:600;color:' + tokens.strong + '}',
    each('a') + '{color:inherit;text-decoration:underline}',
    each('code') + '{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;background:' + tokens.surface + ';border-radius:4px;padding:1px 4px}',
    each('pre') + '{margin:0 0 8px;padding:8px 10px;border-radius:8px;background:' + tokens.surface + ';overflow:auto}',
    each('pre code') + '{background:none;padding:0}',
    each('blockquote') + '{margin:0 0 8px;padding:2px 0 2px 10px;border-left:2px solid ' + tokens.border + '}',
    each('hr') + '{border:none;border-top:1px solid ' + tokens.border + ';margin:10px 0}',
    each('table') + '{border-collapse:collapse;margin:0 0 8px;font-size:12px}',
    each('th', 'td') + '{border:1px solid ' + tokens.border + ';padding:4px 8px;text-align:left}',
    each('th') + '{font-weight:600;color:' + tokens.strong + '}',
  ].join('')
}

interface BlockWriter {
  html: string[]
  /** The block currently open, so consecutive lines of one list/quote group. */
  open: 'ul' | 'ol' | 'blockquote' | 'p' | null
  buffer: string[]
}

function closeBlock(writer: BlockWriter): void {
  const lines = writer.buffer
  writer.buffer = []
  const open = writer.open
  writer.open = null
  if (open === null || lines.length === 0) return
  if (open === 'p') {
    writer.html.push('<p>' + lines.join('<br>') + '</p>')
    return
  }
  if (open === 'blockquote') {
    writer.html.push('<blockquote>' + lines.join('<br>') + '</blockquote>')
    return
  }
  writer.html.push('<' + open + '>' + lines.map((item) => '<li>' + item + '</li>').join('') + '</' + open + '>')
}

function pushLine(writer: BlockWriter, kind: BlockWriter['open'], html: string): void {
  if (writer.open !== kind) closeBlock(writer)
  writer.open = kind
  writer.buffer.push(html)
}

/** The `|---|:--:|` row under a pipe table's header. */
function isTableDivider(line: string): boolean {
  const text = line.trim()
  return text.includes('|') && text.includes('-') && /^\|?[\s:|-]+\|?$/.test(text)
}

/** Splits on unescaped pipes only, so a `\|` inside a cell stays in the cell. */
function tableCells(line: string): string[] {
  return line.trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

function startsOtherBlock(line: string): boolean {
  return HEADING.test(line) || RULE.test(line) || FENCE.test(line)
    || QUOTE.test(line) || BULLET.test(line) || ORDERED.test(line)
}

function renderTable(header: string[], rows: string[][]): string {
  const head = '<tr>' + header.map((cell) => '<th>' + renderInline(cell) + '</th>').join('') + '</tr>'
  // A short or long row would otherwise render as a ragged table; the header
  // decides the width.
  const body = rows
    .map((row) => {
      const cells = row.slice(0, header.length)
      while (cells.length < header.length) cells.push('')
      return '<tr>' + cells.map((cell) => '<td>' + renderInline(cell) + '</td>').join('') + '</tr>'
    })
    .join('')
  return '<table><thead>' + head + '</thead><tbody>' + body + '</tbody></table>'
}

/** Markdown → a small, escaped HTML subset. Returns '' for empty notes. */
export function renderReleaseNotes(markdown: string): string {
  const source = markdown.trim()
  if (source === '') return ''
  const writer: BlockWriter = { html: [], open: null, buffer: [] }
  const lines = source.split(/\r?\n/)
  let fenced: string[] | null = null

  for (let cursor = 0; cursor < lines.length; cursor++) {
    const line = lines[cursor] ?? ''
    if (fenced !== null) {
      if (FENCE.test(line)) {
        writer.html.push('<pre><code>' + escapeHtml(fenced.join('\n')) + '</code></pre>')
        fenced = null
        continue
      }
      fenced.push(line)
      continue
    }
    if (FENCE.test(line)) {
      closeBlock(writer)
      fenced = []
      continue
    }
    if (line.trim() === '') {
      closeBlock(writer)
      continue
    }
    if (RULE.test(line)) {
      closeBlock(writer)
      writer.html.push('<hr>')
      continue
    }
    const heading = HEADING.exec(line)
    if (heading !== null) {
      closeBlock(writer)
      // h1/h2 in a release body would tower over the surrounding card, so the
      // whole scale is shifted down two levels and capped at h6.
      const level = Math.min(6, (heading[1]?.length ?? 1) + 2)
      writer.html.push('<h' + String(level) + '>' + renderInline(heading[2] ?? '') + '</h' + String(level) + '>')
      continue
    }
    // A pipe table is the one block that needs the line after it to be
    // recognized at all: the divider row is what separates it from a
    // paragraph that merely contains pipes.
    if (line.includes('|') && isTableDivider(lines[cursor + 1] ?? '')) {
      closeBlock(writer)
      const rows: string[][] = []
      let scan = cursor + 2
      // A pipe can appear in ordinary prose, so the body ends at the first
      // line that opens any other block — not merely at the first blank one.
      while (scan < lines.length) {
        const row = lines[scan] ?? ''
        if (!row.includes('|') || startsOtherBlock(row)) break
        rows.push(tableCells(row))
        scan++
      }
      writer.html.push(renderTable(tableCells(line), rows))
      cursor = scan - 1
      continue
    }
    const quote = QUOTE.exec(line)
    if (quote !== null) {
      pushLine(writer, 'blockquote', renderInline(quote[1] ?? ''))
      continue
    }
    // Indentation is not read, so a nested list flattens into its parent —
    // release notes do not nest, and a wrong level reads better than a
    // half-built tree.
    const bullet = BULLET.exec(line)
    if (bullet !== null) {
      pushLine(writer, 'ul', renderInline(bullet[1] ?? ''))
      continue
    }
    const ordered = ORDERED.exec(line)
    if (ordered !== null) {
      pushLine(writer, 'ol', renderInline(ordered[1] ?? ''))
      continue
    }
    // A wrapped line inside a list item belongs to that item, not to a new
    // paragraph that would break the list in two.
    if ((writer.open === 'ul' || writer.open === 'ol') && /^\s{2,}\S/.test(line)) {
      const index = writer.buffer.length - 1
      const current = writer.buffer[index]
      if (current !== undefined) writer.buffer[index] = current + ' ' + renderInline(line.trim())
      continue
    }
    pushLine(writer, 'p', renderInline(line.trim()))
  }

  if (fenced !== null) writer.html.push('<pre><code>' + escapeHtml(fenced.join('\n')) + '</code></pre>')
  closeBlock(writer)
  return writer.html.join('')
}
