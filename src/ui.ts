import chalk from 'chalk';
import { marked, type Tokens } from 'marked';
import wrapAnsi from 'wrap-ansi';
import { highlight } from 'cli-highlight';

const ANSI_REGEX = /\x1B\[[0-9;]*m/g;

export function clamp(n: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, n));
}

export function getTerminalColumns(): number {
    const cols = (process.stdout && typeof process.stdout.columns === 'number') ? process.stdout.columns : 80;
    return clamp(cols, 40, 500);
}

function stripAnsi(s: string): string {
    return s.replace(ANSI_REGEX, '');
}

function visibleLength(s: string): number {
    return stripAnsi(s).length;
}

function padAnsiRight(s: string, width: number): string {
    const len = visibleLength(s);
    if (len >= width) return s;
    return s + ' '.repeat(width - len);
}

export function wrapText(s: string, width: number): string[] {
    // wrap-ansi handles ANSI sequences without breaking them
    return wrapAnsi(s, width, { hard: false, trim: false }).split('\n');
}

export function wrapHard(s: string, width: number): string[] {
    return wrapAnsi(s, width, { hard: true, trim: false }).split('\n');
}

function renderInline(tokens: any[] | undefined): string {
    if (!tokens || tokens.length === 0) return '';
    let out = '';

    for (const t of tokens) {
        switch (t.type) {
            case 'text':
                out += t.text ?? '';
                break;
            case 'strong':
                out += chalk.bold(renderInline(t.tokens));
                break;
            case 'em':
                out += chalk.italic(renderInline(t.tokens));
                break;
            case 'codespan':
                // Keep it subtle so long code spans still wrap nicely
                out += chalk.bgBlackBright.white(` ${t.text ?? ''} `);
                break;
            case 'del':
                out += chalk.strikethrough(renderInline(t.tokens));
                break;
            case 'link': {
                const linkText = renderInline(t.tokens) || t.text || t.href || '';
                out += chalk.underline.cyan(linkText);
                if (t.href) out += chalk.dim(` (${t.href})`);
                break;
            }
            case 'br':
                out += '\n';
                break;
            default:
                // Fallback for less common inline tokens
                out += t.raw ?? t.text ?? '';
                break;
        }
    }

    return out;
}

function renderCodeBlock(language: string, code: string, width: number): string[] {
    const lang = (language || 'plaintext').trim() || 'plaintext';

    let highlighted: string;
    try {
        highlighted = highlight(code.trimEnd(), { language: lang, ignoreIllegals: true });
    } catch {
        highlighted = code.trimEnd();
    }

    const contentWidth = Math.max(20, width);

    // Header/footer
    const headerLabel = ` ${lang} `;
    const headerFill = Math.max(0, contentWidth - headerLabel.length);
    const top = chalk.dim('┌') + chalk.dim('─') + chalk.cyan(headerLabel) + chalk.dim('─'.repeat(headerFill) + '┐');
    const bottom = chalk.dim('└' + '─'.repeat(contentWidth + 2) + '┘');

    const out: string[] = [];
    out.push(top);

    const rawLines = highlighted.split('\n');
    for (const line of rawLines) {
        const wrapped = wrapHard(line, contentWidth);
        for (const wl of wrapped) {
            out.push(chalk.dim('│ ') + padAnsiRight(wl, contentWidth) + chalk.dim(' │'));
        }
    }

    out.push(bottom);
    return out;
}

function renderBlockTokens(tokens: any[], width: number, indent: number = 0): string[] {
    const out: string[] = [];
    const pad = ' '.repeat(indent);

    for (const token of tokens) {
        switch (token.type) {
            case 'space':
                // Ignore (we manage spacing explicitly)
                break;

            case 'heading': {
                const level = token.depth ?? 1;
                const text = renderInline(token.tokens) || token.text || '';
                const styled =
                    level === 1 ? chalk.bold.underline(text)
                        : level === 2 ? chalk.bold(text)
                            : chalk.bold(text);
                out.push(pad + styled);
                out.push('');
                break;
            }

            case 'paragraph': {
                const text = renderInline(token.tokens) || token.text || '';
                const lines = wrapText(text, Math.max(10, width - indent));
                out.push(...lines.map(l => pad + l));
                out.push('');
                break;
            }

            case 'blockquote': {
                const inner = renderBlockTokens(token.tokens || [], Math.max(10, width - indent - 2), 0);
                for (const line of inner) {
                    // Keep blank lines inside blockquotes aligned
                    out.push(pad + chalk.dim('│ ') + line);
                }
                out.push('');
                break;
            }

            case 'list': {
                const ordered = Boolean(token.ordered);
                const start = typeof token.start === 'number' ? token.start : 1;
                let idx = 0;

                for (const item of token.items || []) {
                    const marker = ordered ? `${start + idx}.` : '-';
                    idx++;

                    // Render list item blocks. Marked list items provide `tokens` (block-level).
                    const itemLines = renderBlockTokens(item.tokens || [], Math.max(10, width - indent - marker.length - 1), 0);
                    const first = itemLines.findIndex(l => l.trim().length > 0);

                    if (first === -1) {
                        out.push(pad + `${marker}`);
                        continue;
                    }

                    // Print first non-empty line with marker, then subsequent lines aligned.
                    let printedFirst = false;
                    for (const line of itemLines) {
                        if (!printedFirst && line.trim().length > 0) {
                            out.push(pad + `${marker} ${line}`);
                            printedFirst = true;
                        } else {
                            // Maintain spacing for wrapped lines or additional paragraphs
                            const contPad = ' '.repeat(marker.length + 1);
                            out.push(pad + contPad + line);
                        }
                    }
                }

                out.push('');
                break;
            }

            case 'code': {
                const codeLines = renderCodeBlock(token.lang || 'plaintext', token.text || '', Math.max(20, width - indent));
                out.push(...codeLines.map(l => pad + l));
                out.push('');
                break;
            }

            case 'hr': {
                out.push(pad + chalk.dim('─'.repeat(Math.max(10, width - indent))));
                out.push('');
                break;
            }

            default: {
                // Best-effort fallback:
                const raw = (token.raw || token.text || '').trimEnd();
                if (raw) {
                    const lines = wrapText(raw, Math.max(10, width - indent));
                    out.push(...lines.map(l => pad + l));
                    out.push('');
                }
                break;
            }
        }
    }

    // Remove trailing blank lines
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    return out;
}

export function renderMarkdownToTerminal(markdown: string, width: number): string {
    const tokens = marked.lexer(markdown, { gfm: true, breaks: true });
    const lines = renderBlockTokens(tokens as unknown as Tokens.Generic[], width, 0);
    return lines.join('\n');
}

export function renderPlainToTerminal(text: string, width: number): string {
    const normalized = text.replace(/\r\n/g, '\n');
    const out: string[] = [];
    for (const paragraph of normalized.split('\n')) {
        // Preserve explicit line breaks; wrap each line.
        const lines = wrapText(paragraph, width);
        out.push(...lines);
    }
    return out.join('\n');
}

export function prefixLines(text: string, prefix: string): string {
    const lines = text.split('\n');
    return lines.map(l => prefix + l).join('\n');
}

export function renderBox(opts: {
    title: string;
    content: string | string[];
    width: number; // content width (inside the borders)
    tint?: (s: string) => string;
}): string {
    const tint = opts.tint ?? ((s: string) => s);
    const width = Math.max(20, opts.width);

    const contentLines = Array.isArray(opts.content) ? opts.content : opts.content.split('\n');
    const wrappedLines: string[] = [];

    for (const line of contentLines) {
        const pieces = wrapText(line, width);
        wrappedLines.push(...pieces);
    }

    const title = opts.title.trim();
    const fillLen = Math.max(0, width - title.length - 1);

    const top = tint('┌─ ') + chalk.bold(title) + tint(' ' + '─'.repeat(fillLen) + ' ┐');
    const bottom = tint('└' + '─'.repeat(width + 2) + '┘');

    const out: string[] = [];
    out.push(top);
    for (const l of wrappedLines.length ? wrappedLines : ['']) {
        out.push(tint('│ ') + padAnsiRight(l, width) + tint(' │'));
    }
    out.push(bottom);
    return out.join('\n');
}

export function renderBanner(title: string, width: number): string {
    const w = Math.max(30, width);
    const inner = w;
    const t = title.trim();
    const padTotal = Math.max(0, inner - t.length);
    const left = Math.floor(padTotal / 2);
    const right = padTotal - left;
    return renderBox({
        title: '',
        width: w,
        tint: chalk.cyan,
        content: chalk.white.bold(' '.repeat(left) + t + ' '.repeat(right)),
    });
}

