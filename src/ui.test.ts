import { describe, it, expect, beforeEach } from 'vitest';
import { Agent } from './Agent';
import { renderBox, renderMarkdownToTerminal, renderPlainToTerminal } from './ui';

function stripAnsi(s: string): string {
    return s.replace(/\x1B\[[0-9;]*m/g, '');
}

function maxLineLen(text: string): number {
    return Math.max(...stripAnsi(text).split('\n').map(l => l.length));
}

describe('ui primitives', () => {
    it('renderPlainToTerminal wraps to width', () => {
        const width = 40;
        const text = 'This is a long line that should wrap nicely without exceeding the requested width.';
        const out = renderPlainToTerminal(text, width);
        for (const line of stripAnsi(out).split('\n')) {
            expect(line.length).toBeLessThanOrEqual(width);
        }
    });

    it('renderMarkdownToTerminal wraps paragraphs to width', () => {
        const width = 48;
        const md = `## Heading\n\nThis is a paragraph with **bold**, _italic_, and \`inline code\` that should wrap.\n\n- Item one that is quite long and should wrap\n- Item two`;
        const out = renderMarkdownToTerminal(md, width);

        // Markdown output may include list indentation and styles, but should not exceed width + a small safety margin.
        // (Code blocks add borders; this test contains no fenced code blocks.)
        for (const line of stripAnsi(out).split('\n')) {
            expect(line.length).toBeLessThanOrEqual(width);
        }
    });

    it('renderMarkdownToTerminal keeps fenced code blocks within a bounded width', () => {
        const width = 50;
        const md = [
            'Here is code:',
            '',
            '```ts',
            'const veryLongIdentifierNameThatWillNeedWrapping = 1234567890;',
            'console.log(veryLongIdentifierNameThatWillNeedWrapping);',
            '```',
            '',
            'Done.',
        ].join('\n');
        const out = renderMarkdownToTerminal(md, width);
        const maxLen = maxLineLen(out);

        // Our code block box includes borders and a small header allowance.
        // Keep this loose enough to avoid false positives across terminals/fonts.
        expect(maxLen).toBeLessThanOrEqual(width + 10);
    });

    it('renderBox produces a stable-width box', () => {
        const width = 42;
        const box = renderBox({
            title: 'Test Box',
            width,
            content: [
                'Line one',
                'A second line that is definitely long enough to wrap and should still fit.',
            ],
        });

        const lines = stripAnsi(box).split('\n');
        expect(lines.length).toBeGreaterThanOrEqual(3);

        // Content lines (│ ... │) should be width + 4 chars.
        const contentLines = lines.filter(l => l.startsWith('│ '));
        expect(contentLines.length).toBeGreaterThan(0);
        for (const l of contentLines) {
            expect(l.length).toBe(width + 4);
        }

        // Overall box should not blow out wildly beyond width.
        expect(maxLineLen(box)).toBeLessThanOrEqual(width + 10);
    });
});

describe('Agent UI config', () => {
    let agent: Agent;

    beforeEach(() => {
        agent = new Agent({ apiKey: 'test-key' });
    });

    it('should allow changing UI settings via Agent methods', () => {
        agent.setUiMaxWidth(80);
        agent.setUiMarkdown(false);
        agent.setUiStreaming('final');
        agent.setShowLegendOnStartup(true);

        const ui = agent.getUiConfig();
        expect(ui.maxWidth).toBe(80);
        expect(ui.markdown).toBe(false);
        expect(ui.streaming).toBe('final');
        expect(ui.showLegendOnStartup).toBe(true);
    });

    it('should clamp UI width to safe bounds', () => {
        agent.setUiMaxWidth(10);
        expect(agent.getUiConfig().maxWidth).toBeGreaterThanOrEqual(40);

        agent.setUiMaxWidth(1000);
        expect(agent.getUiConfig().maxWidth).toBeLessThanOrEqual(140);
    });
});

