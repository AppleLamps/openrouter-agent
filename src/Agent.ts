import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import fs from 'fs/promises';
import path from 'path';
import * as readline from 'readline';
import ora, { Ora } from 'ora';
import chalk from 'chalk';
import { highlight } from 'cli-highlight';
import { tools, availableTools, detectProjectType, validateToolArgs, generateProjectMap, readOnlyTools, READ_ONLY_TOOL_NAMES } from './tools';
import { clamp, getTerminalColumns, prefixLines, renderBox, renderMarkdownToTerminal, renderPlainToTerminal } from './ui';

// Configuration
const HISTORY_FILE = path.join(process.cwd(), '.agent_history.json');
const MAX_HISTORY_MESSAGES = 50;
const MAX_CONTEXT_TOKENS = 100000; // Safe limit for context window
const CHARS_PER_TOKEN = 3.5; // Conservative estimate: ~3.5 chars per token (code has more syntax overhead)
const MAX_TOOL_OUTPUT_HISTORY_CHARS = 1200;
const MAX_TOOL_OUTPUT_CONTEXT_CHARS = 6000;

// ============================================================================
// TERMINAL WIDTH + STREAMED OUTPUT WRAPPING
// ============================================================================

type StreamingMode = 'live' | 'final';

interface UiConfig {
    maxWidth: number; // preferred content width (not full terminal width)
    markdown: boolean; // render markdown as rich terminal output
    streaming: StreamingMode; // live in-place updates vs render at end
    showLegendOnStartup: boolean; // show status legend at startup
}

const DEFAULT_UI: UiConfig = {
    maxWidth: 92,
    markdown: true,
    streaming: 'live',
    showLegendOnStartup: false,
};

// Single-agent CLI → module-level config is fine and keeps wiring simple.
let UI: UiConfig = { ...DEFAULT_UI };

/**
 * We intentionally do NOT use the full terminal width for assistant responses.
 * A smaller max line length is easier to read and avoids edge-to-edge "wall of text".
 */
function getPreferredResponseWidth(): number {
    const cols = getTerminalColumns();
    const maxWidth = UI.maxWidth; // readable on wide terminals (user-configurable)
    const sideGutter = 6; // prefix + breathing room
    return clamp(Math.min(maxWidth, cols - sideGutter), 40, maxWidth);
}

function renderAssistantMarkdown(markdown: string): string {
    const width = getPreferredResponseWidth();
    const rendered = UI.markdown ? renderMarkdownToTerminal(markdown, width) : renderPlainToTerminal(markdown, width);
    return prefixLines(rendered, chalk.dim('│ '));
}

/**
 * Live, in-place renderer for streamed assistant markdown.
 * Uses readline cursor movement to redraw the assistant panel without spamming the scrollback.
 *
 * IMPORTANT:
 * - Only enabled when stdout is a TTY.
 * - Throttled to avoid excessive rendering work.
 */
class LiveAssistantRenderer {
    private readonly render: (markdown: string) => string;
    private readonly throttleMs: number;
    private latestMarkdown: string = '';
    private scheduled: NodeJS.Timeout | null = null;
    private lastRenderedLineCount: number = 0;
    private active: boolean = false;
    private lastRenderAt: number = 0;

    constructor(opts: { render: (markdown: string) => string; throttleMs?: number }) {
        this.render = opts.render;
        this.throttleMs = opts.throttleMs ?? 60;
    }

    start(): void {
        if (!process.stdout.isTTY) return;
        this.active = true;
        this.lastRenderedLineCount = 0;
        this.lastRenderAt = 0;
    }

    update(markdown: string): void {
        if (!this.active || !process.stdout.isTTY) return;
        this.latestMarkdown = markdown;

        if (this.scheduled) return;

        const now = Date.now();
        const elapsed = now - this.lastRenderAt;
        const delay = elapsed >= this.throttleMs ? 0 : (this.throttleMs - elapsed);

        this.scheduled = setTimeout(() => {
            this.scheduled = null;
            this.flush();
        }, delay);
    }

    flush(): void {
        if (!this.active || !process.stdout.isTTY) return;

        const output = this.render(this.latestMarkdown || '');
        const lines = output.length ? output.split('\n').length : 1;

        // Rewind cursor to the top of the previous render, then clear down.
        if (this.lastRenderedLineCount > 0) {
            readline.cursorTo(process.stdout, 0);
            // Move up (lineCount - 1) lines to reach the first line of the block.
            readline.moveCursor(process.stdout, 0, -(this.lastRenderedLineCount - 1));
            readline.clearScreenDown(process.stdout);
        }

        process.stdout.write(output);
        this.lastRenderedLineCount = lines;
        this.lastRenderAt = Date.now();
    }

    /**
     * Finalize the render (flush latest content) and leave cursor after the block.
     */
    done(): void {
        if (!this.active) return;

        if (this.scheduled) {
            clearTimeout(this.scheduled);
            this.scheduled = null;
        }

        if (process.stdout.isTTY) {
            this.flush();
            process.stdout.write('\n');
        }

        this.active = false;
        this.lastRenderedLineCount = 0;
        this.latestMarkdown = '';
    }
}

// ============================================================================
// STATUS & UI HELPERS
// ============================================================================

/**
 * Agent states for visual feedback
 */
type AgentState = 'idle' | 'thinking' | 'streaming' | 'tool_calling' | 'executing' | 'waiting' | 'complete' | 'error';

/**
 * Status display manager for rich visual feedback
 */
class StatusDisplay {
    private spinner: Ora | null = null;
    private startTime: number = 0;
    private stepCount: number = 0;
    private totalToolCalls: number = 0;
    private streamingChars: number = 0;
    private currentState: AgentState = 'idle';

    /**
     * Format elapsed time in human readable format
     */
    private formatElapsed(ms: number): string {
        if (ms < 1000) return `${ms}ms`;
        const seconds = Math.floor(ms / 1000);
        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        return `${minutes}m ${remainingSeconds}s`;
    }

    /**
     * Get current elapsed time
     */
    getElapsed(): string {
        if (this.startTime === 0) return '0s';
        return this.formatElapsed(Date.now() - this.startTime);
    }

    /**
     * Start tracking a new request
     */
    startRequest(): void {
        this.startTime = Date.now();
        this.stepCount = 0;
        this.totalToolCalls = 0;
        this.streamingChars = 0;
    }

    /**
     * Increment step counter
     */
    incrementStep(): void {
        this.stepCount++;
    }

    /**
     * Get current step number
     */
    getStep(): number {
        return this.stepCount;
    }

    /**
     * Set the current agent state with visual feedback
     */
    setState(state: AgentState, context?: string): void {
        this.stopSpinner();
        this.currentState = state;

        switch (state) {
            case 'thinking':
                this.spinner = ora({
                    text: chalk.cyan(`🧠 Thinking... ${context ? `(${context})` : ''}`),
                    spinner: 'dots12',
                    color: 'cyan'
                }).start();
                break;

            case 'streaming':
                // Phase 3: the agent can render streaming output inline (no spinner to avoid conflicts).
                this.streamingChars = 0;
                break;

            case 'tool_calling':
                this.spinner = ora({
                    text: chalk.yellow(`🔧 Preparing tool call... ${context ? `(${context})` : ''}`),
                    spinner: 'arc',
                    color: 'yellow'
                }).start();
                break;

            case 'executing':
                this.totalToolCalls++;
                this.spinner = ora({
                    text: chalk.magenta(`⚡ Executing: ${context || 'tool'}...`),
                    spinner: 'bouncingBar',
                    color: 'magenta'
                }).start();
                break;

            case 'waiting':
                this.spinner = ora({
                    text: chalk.cyan(`⏳ Waiting ${context || 'for user input'}...`),
                    spinner: 'dots',
                    color: 'cyan'
                }).start();
                break;

            case 'complete':
                const elapsed = this.getElapsed();
                const toolInfo = this.totalToolCalls > 0 ? ` | ${this.totalToolCalls} tool${this.totalToolCalls > 1 ? 's' : ''} used` : '';
                const stepsInfo = this.stepCount > 1 ? ` | ${this.stepCount} steps` : '';
                console.log(chalk.green(`\n✓ Complete`) + chalk.dim(` (${elapsed}${stepsInfo}${toolInfo})`));
                break;

            case 'error':
                console.log(chalk.red(`\n✗ Error: ${context || 'Unknown error'}`));
                break;
        }
    }

    /**
     * Update streaming status - tracks character count
     */
    updateStreaming(chars: number): void {
        this.streamingChars += chars;
    }

    /**
     * Print streaming indicator at the start
     */
    printStreamStart(): void {
        process.stdout.write(chalk.dim('│ '));
    }

    /**
     * Print streaming complete indicator
     */
    printStreamEnd(): void {
        console.log(chalk.dim(` │ `) + chalk.dim.italic(`${this.streamingChars} chars`));
    }

    /**
     * Stop any running spinner
     */
    stopSpinner(): void {
        if (this.spinner) {
            this.spinner.stop();
            this.spinner = null;
        }
    }

    /**
     * Display a step header
     */
    showStepHeader(): void {
        if (this.stepCount > 1) {
            const cols = getTerminalColumns();
            const contentWidth = Math.max(36, Math.min(UI.maxWidth, cols - 6));
            const label = ` Step ${this.stepCount} `;
            const fill = Math.max(0, contentWidth - label.length);
            console.log(chalk.dim('\n' + '─'.repeat(2) + label + '─'.repeat(fill)));
        }
    }

    /**
     * Show a waiting for user input indicator
     */
    showWaitingForConfirmation(): void {
        this.stopSpinner();
        console.log(chalk.yellow('\n⏳ Waiting for user confirmation...'));
    }

    /**
     * Show user denied message
     */
    showDenied(): void {
        console.log(chalk.red('✗ Operation denied by user'));
    }

    /**
     * Show user approved message
     */
    showApproved(): void {
        console.log(chalk.green('✓ Approved'));
    }
}

// ============================================================================
// OUTPUT FORMATTING HELPERS
// ============================================================================

/**
 * Highlight code blocks in markdown text
 */
function formatResponseWithHighlighting(text: string): string {
    // Match code blocks: ```language\ncode\n```
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;

    return text.replace(codeBlockRegex, (match, lang, code) => {
        try {
            const language = lang || 'plaintext';
            const highlighted = highlight(code.trim(), { language, ignoreIllegals: true });
            return `\n${chalk.dim('┌─')} ${chalk.cyan(language)} ${chalk.dim('─'.repeat(Math.max(0, 50 - language.length)) + '┐')}\n${highlighted}\n${chalk.dim('└' + '─'.repeat(54) + '┘')}\n`;
        } catch {
            // If highlighting fails, return original
            return match;
        }
    });
}

/**
 * Format tool call display - shows concise summary, not raw args
 */
function formatToolCall(name: string, args: any): string {
    let summary = '';

    // Create human-readable summaries for common tools
    switch (name) {
        case 'write_file':
            summary = `  ${chalk.dim('path:')} ${chalk.white('"' + args.path + '"')}\n  ${chalk.dim('size:')} ${chalk.yellow((args.content?.length || 0) + ' characters')}`;
            break;
        case 'edit_file':
            const oldPreview = (args.old_text || '').slice(0, 40).replace(/\n/g, '\\n');
            summary = `  ${chalk.dim('path:')} ${chalk.white('"' + args.path + '"')}\n  ${chalk.dim('find:')} ${chalk.red('"' + oldPreview + (args.old_text?.length > 40 ? '...' : '') + '"')}`;
            break;
        case 'edit_file_by_lines':
            summary = `  ${chalk.dim('path:')} ${chalk.white('"' + args.path + '"')}\n  ${chalk.dim('lines:')} ${chalk.cyan(args.start_line + '-' + args.end_line)}\n  ${chalk.dim('size:')} ${chalk.yellow((args.new_content?.length || 0) + ' chars')}`;
            break;
        case 'execute_command':
            const cmd = args.command?.length > 60 ? args.command.slice(0, 57) + '...' : args.command;
            summary = `  ${chalk.dim('$')} ${chalk.green(cmd)}${args.cwd ? `\n  ${chalk.dim('cwd:')} ${chalk.white(args.cwd)}` : ''}`;
            break;
        case 'read_file':
        case 'read_file_with_lines':
            summary = `  ${chalk.dim('path:')} ${chalk.white('"' + args.path + '"')}${args.start_line ? `\n  ${chalk.dim('lines:')} ${chalk.cyan(args.start_line + '-' + (args.end_line || 'end'))}` : ''}`;
            break;
        case 'list_directory':
            summary = `  ${chalk.dim('dir:')} ${chalk.white('"' + args.directory + '"')}${args.recursive ? chalk.dim(' (recursive)') : ''}`;
            break;
        case 'search_files':
            summary = `  ${chalk.dim('pattern:')} ${chalk.magenta('"' + args.pattern + '"')}\n  ${chalk.dim('dir:')} ${chalk.white('"' + args.directory + '"')}`;
            break;
        case 'find_files':
            summary = `  ${chalk.dim('pattern:')} ${chalk.magenta('"' + args.pattern + '"')}\n  ${chalk.dim('dir:')} ${chalk.white('"' + args.directory + '"')}`;
            break;
        case 'delete_file':
            summary = `  ${chalk.dim('path:')} ${chalk.red('"' + args.path + '"')}${args.recursive ? chalk.red(' (RECURSIVE!)') : ''}`;
            break;
        case 'move_file':
            summary = `  ${chalk.dim('from:')} ${chalk.white('"' + args.source + '"')}\n  ${chalk.dim('  to:')} ${chalk.green('"' + args.destination + '"')}`;
            break;
        default:
            // For other tools, show truncated JSON
            const argsStr = JSON.stringify(args, null, 2);
            const lines = argsStr.split('\n');
            summary = lines.length > 4
                ? lines.slice(0, 4).map(l => l.length > 60 ? l.slice(0, 57) + '...' : l).join('\n') + '\n  ...'
                : lines.map(l => l.length > 60 ? l.slice(0, 57) + '...' : l).join('\n');
    }

    const width = getPreferredResponseWidth();
    return '\n' + renderBox({
        title: `🔧 ${name}`,
        width,
        tint: chalk.dim,
        content: summary.split('\n').map(l => l.trimEnd()),
    });
}

/**
 * Colorize diff output - green for additions, red for deletions
 */
function colorizeDiff(text: string): string {
    return text
        .split('\n')
        .map(line => {
            if (line.startsWith('+') && !line.startsWith('+++')) {
                return chalk.green(line);
            } else if (line.startsWith('-') && !line.startsWith('---')) {
                return chalk.red(line);
            } else if (line.startsWith('@@')) {
                return chalk.cyan(line);
            }
            return line;
        })
        .join('\n');
}

/**
 * Format tool result display
 */
function formatToolResult(output: string, success: boolean = true, maxLength: number = 300): string {
    const truncated = output.length > maxLength
        ? output.slice(0, maxLength) + '\n... (truncated)'
        : output;

    // Apply diff colorization if the output looks like a diff
    const isDiff = truncated.includes('\n+') || truncated.includes('\n-') || truncated.includes('@@');
    const colorizedOutput = isDiff ? colorizeDiff(truncated) : truncated;

    const icon = success ? '📋' : '❌';
    const color = success ? chalk.dim : chalk.red;

    const width = getPreferredResponseWidth();
    return '\n' + renderBox({
        title: `${icon} ${success ? 'Result' : 'Error'}`,
        width,
        tint: color,
        content: String(colorizedOutput).split('\n'),
    });
}

interface TokenUsage {
    input: number;
    output: number;
}

// ============================================================================
// MESSAGE TYPE DEFINITIONS
// ============================================================================

/**
 * Represents a tool/function call requested by the assistant.
 */
interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

/**
 * Conversation message types for the OpenRouter API.
 */
type ConversationMessage =
    | { role: 'system'; content: string }
    | { role: 'user'; content: string }
    | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
    | { role: 'tool'; tool_call_id: string; name: string; content: string };

interface AgentConfig {
    model?: string;
    webSearchEnabled?: boolean;
    apiKey?: string;
    safetyLevel?: 'off' | 'delete-only' | 'full';
    readlineInterface?: readline.Interface;
}

// Safety levels:
// 'full' - prompt for all dangerous operations (default)
// 'delete-only' - only prompt for delete and execute_command (most destructive)
// 'off' - no prompts (dangerous!)

// Critical tools - ALWAYS prompt unless safety is 'off'
const CRITICAL_TOOLS = ['delete_file', 'execute_command'];

// All dangerous tools - prompt in 'full' safety mode
const DANGEROUS_TOOLS = [
    'execute_command',
    'delete_file',
    'write_file',
    'move_file',
    'edit_file',
    'edit_file_by_lines',
    'multi_edit_file',
    'insert_at_line',
];

export class Agent {
    private openai: OpenAI;
    private conversationHistory: ConversationMessage[] = [];
    private totalTokens: TokenUsage = { input: 0, output: 0 };
    private currentModel: string;
    private webSearchEnabled: boolean;
    private projectContext: string = '';
    private projectMap: string = '';
    private _safetyLevel: 'off' | 'delete-only' | 'full';
    private rl: readline.Interface | null = null;
    private status: StatusDisplay = new StatusDisplay();

    // Project map caching
    private projectMapCacheTime: number = 0;
    private readonly PROJECT_MAP_CACHE_TTL = 300000; // 5 minutes

    // Debug mode flag
    private _debug: boolean = false;

    // Planning mode state
    private pendingPlan: string | null = null;
    private pendingPlanTask: string | null = null;

    constructor(config: AgentConfig = {}) {
        this.currentModel = config.model || process.env.OPENROUTER_MODEL || 'mistralai/devstral-2512:free';
        this.webSearchEnabled = config.webSearchEnabled || false;
        this._safetyLevel = config.safetyLevel || 'full';
        this.rl = config.readlineInterface || null;

        this.openai = new OpenAI({
            baseURL: 'https://openrouter.ai/api/v1',
            apiKey: config.apiKey || process.env.OPENROUTER_API_KEY,
        });
    }

    // ============================================================================
    // UI CONFIG
    // ============================================================================

    getUiConfig(): UiConfig {
        return { ...UI };
    }

    resetUiConfig(): UiConfig {
        UI = { ...DEFAULT_UI };
        return this.getUiConfig();
    }

    setUiMaxWidth(width: number): UiConfig {
        const w = clamp(Math.floor(width), 40, 140);
        UI = { ...UI, maxWidth: w };
        return this.getUiConfig();
    }

    setUiMarkdown(enabled: boolean): UiConfig {
        UI = { ...UI, markdown: enabled };
        return this.getUiConfig();
    }

    setUiStreaming(mode: StreamingMode): UiConfig {
        UI = { ...UI, streaming: mode };
        return this.getUiConfig();
    }

    setShowLegendOnStartup(enabled: boolean): UiConfig {
        UI = { ...UI, showLegendOnStartup: enabled };
        return this.getUiConfig();
    }

    // ============================================================================
    // PUBLIC GETTERS/SETTERS
    // ============================================================================

    get model(): string {
        return this.currentModel;
    }

    set model(value: string) {
        this.currentModel = value;
    }

    get webSearch(): boolean {
        return this.webSearchEnabled;
    }

    set webSearch(value: boolean) {
        this.webSearchEnabled = value;
    }

    get tokens(): TokenUsage {
        return { ...this.totalTokens };
    }

    get historyLength(): number {
        return this.conversationHistory.length;
    }

    getProjectContext(): string {
        return this.projectContext;
    }

    get safetyLevel(): 'off' | 'delete-only' | 'full' {
        return this._safetyLevel;
    }

    set safetyLevel(value: 'off' | 'delete-only' | 'full') {
        this._safetyLevel = value;
    }

    /**
     * Cycle through safety levels: full -> delete-only -> off -> full
     */
    cycleSafetyLevel(): 'off' | 'delete-only' | 'full' {
        const levels: Array<'off' | 'delete-only' | 'full'> = ['full', 'delete-only', 'off'];
        const currentIndex = levels.indexOf(this._safetyLevel);
        this._safetyLevel = levels[(currentIndex + 1) % levels.length];
        return this._safetyLevel;
    }

    setReadlineInterface(rl: readline.Interface): void {
        this.rl = rl;
    }

    /**
     * Get the current project map structure
     */
    getProjectMap(): string {
        return this.projectMap;
    }

    /**
     * Toggle debug mode and return new state
     */
    toggleDebug(): boolean {
        this._debug = !this._debug;
        return this._debug;
    }

    /**
     * Get current debug mode state
     */
    get debug(): boolean {
        return this._debug;
    }

    // ============================================================================
    // PLANNING MODE
    // ============================================================================

    /**
     * Check if there's a pending plan waiting to be executed
     */
    get hasPendingPlan(): boolean {
        return this.pendingPlan !== null;
    }

    /**
     * Get the pending plan and task
     */
    getPendingPlan(): { plan: string; task: string } | null {
        if (this.pendingPlan && this.pendingPlanTask) {
            return { plan: this.pendingPlan, task: this.pendingPlanTask };
        }
        return null;
    }

    /**
     * Clear the pending plan
     */
    clearPlan(): void {
        this.pendingPlan = null;
        this.pendingPlanTask = null;
    }

    // ============================================================================
    // USER CONFIRMATION FOR DANGEROUS TOOLS
    // ============================================================================

    private async confirmDangerousAction(toolName: string, args: any): Promise<boolean> {
        // Build a concise, human-readable summary based on tool type
        let operationType = '';
        let targetPath = '';
        let details = '';

        switch (toolName) {
            case 'write_file':
                operationType = '📝 CREATE/OVERWRITE FILE';
                targetPath = args.path || 'unknown';
                const contentLength = args.content?.length || 0;
                details = `${contentLength} characters`;
                break;
            case 'edit_file':
                operationType = '✏️  EDIT FILE';
                targetPath = args.path || 'unknown';
                details = `Replace "${(args.old_text || '').slice(0, 30)}${args.old_text?.length > 30 ? '...' : ''}"`;
                break;
            case 'edit_file_by_lines':
                operationType = '✏️  EDIT FILE (by lines)';
                targetPath = args.path || 'unknown';
                details = `Lines ${args.start_line}-${args.end_line}`;
                break;
            case 'multi_edit_file':
                operationType = '✏️  MULTI-EDIT FILE';
                targetPath = args.path || 'unknown';
                details = `${args.edits?.length || 0} edit(s)`;
                break;
            case 'insert_at_line':
                operationType = '➕ INSERT AT LINE';
                targetPath = args.path || 'unknown';
                details = `Line ${args.line_number} (${args.position || 'after'})`;
                break;
            case 'delete_file':
                operationType = '🗑️  DELETE';
                targetPath = args.path || 'unknown';
                details = args.recursive ? 'Recursive' : 'Single file';
                break;
            case 'move_file':
                operationType = '📦 MOVE/RENAME';
                targetPath = `${args.source} → ${args.destination}`;
                details = '';
                break;
            case 'execute_command':
                operationType = '⚡ EXECUTE COMMAND';
                targetPath = args.cwd || process.cwd();
                // Show the command but truncate if too long
                const cmd = args.command || '';
                details = cmd.length > 50 ? cmd.slice(0, 47) + '...' : cmd;
                break;
            default:
                operationType = `🔧 ${toolName.toUpperCase()}`;
                targetPath = args.path || '';
                details = '';
        }

        const width = getPreferredResponseWidth();
        const lines: string[] = [
            `${chalk.bold('Operation:')} ${operationType}`,
            `${chalk.bold('Target:')}    ${targetPath || '(none)'}`,
        ];
        if (details) lines.push(`${chalk.bold('Details:')}   ${details}`);

        console.log('');
        console.log(renderBox({
            title: '⚠️  Confirmation Required',
            width,
            tint: chalk.dim,
            content: lines,
        }));

        if (!this.rl) throw new Error('Readline interface not initialized');

        return new Promise((resolve) => {
            this.rl!.question('Allow? (y/yes to confirm): ', (answer) => {
                const normalized = (answer || '').toLowerCase().trim();
                const confirmed = normalized === 'y' || normalized === 'yes';
                if (confirmed) {
                    console.log('✓ Approved\n');
                } else {
                    console.log('✗ Denied\n');
                }
                resolve(confirmed);
            });
        });
    }

    /**
     * Ask user if they want to continue after reaching max steps
     */
    private async askContinue(): Promise<boolean> {
        if (!this.rl) throw new Error('Readline interface not initialized');

        return new Promise((resolve) => {
            this.rl!.question(chalk.yellow('Continue? (y/yes to continue): '), (answer) => {
                const normalized = (answer || '').toLowerCase().trim();
                const shouldContinue = normalized === 'y' || normalized === 'yes';
                resolve(shouldContinue);
            });
        });
    }

    /**
     * Ask user a question and return their response.
     * This is called when the LLM uses the ask_user tool.
     */
    private async askUser(question: string): Promise<string> {
        if (!this.rl) throw new Error('Readline interface not initialized');

        // Display the question in a styled box
        console.log('');
        console.log(renderBox({
            title: '❓ Agent Question',
            width: getPreferredResponseWidth(),
            tint: chalk.cyan,
            content: [question],
        }));

        return new Promise((resolve) => {
            this.rl!.question(chalk.cyan('Your response: '), (answer) => {
                console.log(''); // Add some spacing
                resolve((answer || '').trim() || '(no response provided)');
            });
        });
    }

    /**
     * Simple prompt for user input without the styled box.
     * Used as a fallback when we detect the LLM asked a question without using ask_user.
     */
    private async askUserSimple(): Promise<string> {
        if (!this.rl) throw new Error('Readline interface not initialized');

        return new Promise((resolve) => {
            this.rl!.question(chalk.cyan('↩︎ '), (answer) => {
                resolve(answer || '');
            });
        });
    }

    private truncateToolOutputForHistory(toolName: string, output: string): string {
        const suffix = `\n... [Output truncated. Use read_file_with_lines to see more]`;
        if (output.length <= MAX_TOOL_OUTPUT_HISTORY_CHARS) return output;
        return output.slice(0, MAX_TOOL_OUTPUT_HISTORY_CHARS) + suffix;
    }

    private truncateToolOutputForContext(toolName: string, output: string): string {
        const suffix = `\n... [Output truncated. Use read_file_with_lines to see more]`;
        if (output.length <= MAX_TOOL_OUTPUT_CONTEXT_CHARS) return output;
        return output.slice(0, MAX_TOOL_OUTPUT_CONTEXT_CHARS) + suffix;
    }

    // ============================================================================
    // SYSTEM PROMPT
    // ============================================================================

    private buildSystemPrompt(): string {
        return `
You are a highly capable AI coding agent compatible with OpenRouter.
You have access to the file system and can execute shell commands.
Your goal is to help the user with coding tasks, debugging, and general questions.

=== THINKING REQUIREMENT ===
Before calling ANY tool, you MUST first output your reasoning in a <thought> block.
This helps you plan and avoid mistakes. Example:

<thought>
The user wants to add a new function. I should:
1. First read the file to understand the current structure
2. Identify where the new function should be placed
3. Use edit_file_by_lines for precise editing
Let me start by reading the file with line numbers.
</thought>

Always think before acting. Never call a tool without a preceding <thought> block.

=== CRITICAL RULES ===
1. You have NO 'create_file' tool. You MUST use 'write_file'.
2. You have NO 'mkdir' tool. 'write_file' automatically creates directories.
3. Do not assume tools exist if they are not in the "Available Tools" list.
4. Do not talk about actions you will take. If you intend to act, CALL A TOOL.
5. When the user's request is fully satisfied, you MUST call task_complete.

=== PROJECT CONTEXT ===
- Working Directory: ${process.cwd()}
- Project Type: ${this.projectContext || 'Unknown'}

=== PROJECT STRUCTURE ===
${this.projectMap || '(Project map not available)'}

=== AVAILABLE TOOLS ===
File Operations:
- read_file: Read file content (supports line ranges, optional line numbers)
- read_file_with_lines: Read file with line numbers always shown (use BEFORE editing)
- write_file: Write to files (auto-creates directories, creates backup)
- delete_file: Delete files or directories
- move_file: Move or rename files
- get_file_info: Get file metadata (size, line count, dates)

Edit Operations (prefer line-based editing for safety):
- edit_file_by_lines: Replace line range with new content (RECOMMENDED - safest)
- edit_file: Find-and-replace edit (fallback if line numbers unknown)
- multi_edit_file: Multiple find-and-replace edits in one operation
- insert_at_line: Insert content at specific line number

Search & Navigation:
- list_directory: List files (supports recursive, show sizes)
- find_files: Find files by glob pattern (*.ts, test*)
- search_files: Search text in files (supports regex, extension filter)
- get_current_directory: Get current working directory

System:
- execute_command: Run shell commands (supports cwd, timeout)

User Interaction:
- ask_user: Ask the user a question and wait for their response. Use this when you need:
  • Clarification about requirements or preferences
  • Confirmation before performing significant/destructive operations
  • Input that was missing from the original request
  • The user to choose between multiple approaches

Completion:
- task_complete: Call this ONLY when the user's request is fully satisfied.

=== IMPORTANT: USER INTERACTION ===
When you need user input, ALWAYS use the ask_user tool. DO NOT:
- End your response with a question and expect a reply
- Output questions as regular text without calling ask_user

WRONG (this will NOT work - conversation ends immediately):
"Would you like me to proceed with this change?"

CORRECT (use the ask_user tool):
<thought>I should ask the user if they want to proceed.</thought>
[Call ask_user tool with question: "Would you like me to proceed with this change?"]

If you ask a question without using ask_user, the conversation will end and the user won't be able to respond!

=== EDITING WORKFLOW ===
1. Use read_file_with_lines to view the file with line numbers
2. Identify the exact start_line and end_line you need to modify
3. Use edit_file_by_lines with precise line numbers
4. This is SAFER than string matching because it avoids partial matches

=== BEHAVIOR RULES ===
- ALWAYS output a <thought> block before any tool call
- PREFER edit_file_by_lines over edit_file for targeted changes (more reliable)
- Use read_file_with_lines before editing to see line numbers
- Explore the codebase before making changes
- Backups are created automatically - don't worry about data loss
- If a command fails, analyze the error and try to fix it
- ALWAYS use ask_user tool when you need clarification, confirmation, or user choice
- If you want to offer the user options, USE ask_user - don't just list them as text
`;
    }

    // ============================================================================
    // HISTORY MANAGEMENT
    // ============================================================================

    async loadHistory(): Promise<void> {
        try {
            const data = await fs.readFile(HISTORY_FILE, 'utf-8');
            const parsed = JSON.parse(data);
            this.conversationHistory = parsed.messages || [];
            this.totalTokens = parsed.tokens || { input: 0, output: 0 };
            console.log(`Loaded ${this.conversationHistory.length} messages from history.`);
        } catch (err) {
            // Log error in debug mode, but continue with empty history
            if (this._debug) {
                console.error(chalk.dim('[Debug] History load failed:'), err);
            }
            this.conversationHistory = [];
        }
    }

    async saveHistory(): Promise<void> {
        try {
            // Trim by message count first
            let toSave = this.conversationHistory.slice(-MAX_HISTORY_MESSAGES);

            // Then trim by token limit
            toSave = this.trimToTokenLimit(toSave, MAX_CONTEXT_TOKENS);

            await fs.writeFile(HISTORY_FILE, JSON.stringify({ messages: toSave, tokens: this.totalTokens }, null, 2));
        } catch (err) {
            console.error('Failed to save history:', err);
        }
    }

    clearHistory(): void {
        this.conversationHistory = [];
        this.totalTokens = { input: 0, output: 0 };
    }

    // ============================================================================
    // TOKEN ESTIMATION & CONTEXT MANAGEMENT
    // ============================================================================

    /**
     * Estimate the number of tokens in a string.
     * Rough approximation: 4 characters = 1 token
     */
    private estimateTokens(text: string): number {
        return Math.ceil(text.length / CHARS_PER_TOKEN);
    }

    /**
     * Estimate total tokens in a message array
     */
    private estimateMessagesTokens(messages: any[]): number {
        let total = 0;
        for (const msg of messages) {
            if (typeof msg.content === 'string') {
                total += this.estimateTokens(msg.content);
            } else if (msg.content) {
                total += this.estimateTokens(JSON.stringify(msg.content));
            }
            // Add overhead for message structure
            total += 4; // approximate token overhead per message
        }
        return total;
    }

    /**
     * Trim messages to stay under token limit.
     * Removes oldest messages first while preserving recent context.
     * Optimized: calculates how many messages to remove in bulk instead of one-at-a-time.
     */
    private trimToTokenLimit(messages: any[], maxTokens: number): any[] {
        // Reserve tokens for system prompt (estimate ~1500 tokens for safety)
        const systemPromptReserve = 1500;
        const availableTokens = maxTokens - systemPromptReserve;

        const estimatedTokens = this.estimateMessagesTokens(messages);

        if (estimatedTokens <= availableTokens) {
            return messages;
        }

        // Calculate average tokens per message for bulk estimation
        const avgTokensPerMessage = messages.length > 0 ? estimatedTokens / messages.length : 0;

        if (avgTokensPerMessage === 0) {
            return messages;
        }

        // Calculate how many messages to remove
        const excessTokens = estimatedTokens - availableTokens;
        const messagesToRemove = Math.min(
            Math.ceil(excessTokens / avgTokensPerMessage),
            messages.length - 1 // Keep at least 1 message
        );

        // Remove oldest messages in bulk
        const trimmedMessages = messages.slice(messagesToRemove);

        if (messagesToRemove > 0) {
            const finalTokens = this.estimateMessagesTokens(trimmedMessages);
            console.log(`\n[Context Management] Removed ${messagesToRemove} oldest message(s) to stay under token limit.`);
            console.log(`[Context Management] Estimated tokens: ${finalTokens} / ${availableTokens} available`);
        }

        return trimmedMessages;
    }

    /**
     * Prepare messages for API call, ensuring we stay under token limits
     */
    private prepareMessagesForAPI(): ChatCompletionMessageParam[] {
        const systemPrompt: ChatCompletionMessageParam = { role: 'system', content: this.buildSystemPrompt() };

        // Trim conversation history to token limit
        const trimmedHistory = this.trimToTokenLimit(this.conversationHistory, MAX_CONTEXT_TOKENS);

        // Update conversation history if it was trimmed
        if (trimmedHistory.length < this.conversationHistory.length) {
            this.conversationHistory = trimmedHistory;
        }

        return [systemPrompt, ...trimmedHistory];
    }

    // ============================================================================
    // INITIALIZATION
    // ============================================================================

    async initialize(): Promise<void> {
        await this.loadHistory();
        this.projectContext = await detectProjectType();

        // Generate project map for context
        await this.refreshProjectMap();
    }

    /**
     * Regenerate the project map (useful after file changes)
     * @param forceRefresh - If true, ignores cache and regenerates
     */
    async refreshProjectMap(forceRefresh: boolean = false): Promise<void> {
        const now = Date.now();

        // Use cached map if still valid and not forcing refresh
        if (!forceRefresh && this.projectMap && now - this.projectMapCacheTime < this.PROJECT_MAP_CACHE_TTL) {
            console.log('Project structure loaded (cached).');
            return;
        }

        try {
            this.projectMap = await generateProjectMap(process.cwd());
            this.projectMapCacheTime = now;
            console.log('Project structure loaded.');
        } catch (err) {
            console.log('Could not generate project map.');
            if (this._debug && err) {
                console.error(chalk.dim('[Debug] Project map error:'), err);
            }
        }
    }

    // ============================================================================
    // RETRY LOGIC
    // ============================================================================

    private async callWithRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
        for (let i = 0; i < retries; i++) {
            try {
                return await fn();
            } catch (error: any) {
                const isRetryable = error?.status === 429 || error?.status >= 500;
                if (i === retries - 1 || !isRetryable) throw error;
                const delay = 1000 * Math.pow(2, i);
                console.log(`\nRetrying in ${delay}ms... (attempt ${i + 2}/${retries})`);
                await new Promise((r) => setTimeout(r, delay));
            }
        }
        throw new Error('Max retries exceeded');
    }

    // ============================================================================
    // AGENT LOOP
    // ============================================================================

    async run(userInput: string): Promise<void> {
        // Add user message to history
        this.conversationHistory.push({ role: 'user', content: userInput });

        // Build messages with system prompt and apply token limits
        const messages: any[] = this.prepareMessagesForAPI();

        const maxSteps = 15;
        let currentStepInSession = 0;

        // Initialize status tracking for this request
        this.status.startRequest();
        console.log('');

        while (true) {
            currentStepInSession++;
            this.status.incrementStep();

            // Reduce token usage for multi-step runs: truncate older tool outputs in the in-session context.
            // Keep the newest few messages intact so the model can reason over the latest tool results.
            for (let i = 0; i < Math.max(0, messages.length - 8); i++) {
                const msg = messages[i];
                if (msg?.role === 'tool' && typeof msg.content === 'string') {
                    msg.content = this.truncateToolOutputForContext(msg.name || 'tool', msg.content);
                }
            }

            // Check if we've hit max steps for this session
            if (currentStepInSession > maxSteps) {
                console.log(chalk.yellow(`\n⚠️ Reached maximum steps (${maxSteps}). Task may be incomplete.`));
                const shouldContinue = await this.askContinue();
                if (shouldContinue) {
                    console.log(chalk.green('✓ Continuing...\n'));
                    currentStepInSession = 1; // Reset counter for new session
                } else {
                    console.log(chalk.dim('Stopped by user.\n'));
                    break;
                }
            }
            this.status.showStepHeader();

            try {
                // Build model name with :online suffix if web search enabled
                const modelToUse = this.webSearchEnabled ? `${this.currentModel}:online` : this.currentModel;

                // Show thinking state
                const stepInfo = this.status.getStep() > 1 ? `step ${this.status.getStep()}` : undefined;
                this.status.setState('thinking', stepInfo);

                // Debug mode: dump request payload
                if (this._debug) {
                    console.log(chalk.gray('\n🔎 Debug - Request payload:'));
                    console.log(chalk.gray(JSON.stringify({ model: modelToUse, messages: messages.slice(-3) }, null, 2)));
                    console.log(chalk.gray('... (showing last 3 messages)\n'));
                }

                const response = await this.callWithRetry(() =>
                    this.openai.chat.completions.create({
                        model: modelToUse,
                        messages: messages,
                        tools: tools as any,
                        temperature: 0,
                        stream: true,
                    })
                );

                let streamStarted = false;
                let fullContent = '';
                let toolCalls: any[] = [];
                let hasToolCalls = false;
                let assistantContentRendered = false;
                const live = new LiveAssistantRenderer({ render: renderAssistantMarkdown, throttleMs: 60 });

                for await (const chunk of response) {
                    const delta = chunk.choices[0]?.delta;

                    if (delta?.content) {
                        // First content received - transition to streaming state
                        if (!streamStarted) {
                            this.status.setState('streaming');
                            streamStarted = true;
                            if (UI.streaming === 'live') live.start();
                        }

                        fullContent += delta.content;
                        this.status.updateStreaming(delta.content.length);
                        if (UI.streaming === 'live' && process.stdout.isTTY) {
                            // Live re-render the rich markdown panel in place.
                            live.update(fullContent);
                        }
                    }

                    if (delta?.tool_calls) {
                        // Stop any spinners, we're processing tool calls
                        if (!hasToolCalls) {
                            this.status.stopSpinner();
                            hasToolCalls = true;
                            // Freeze the live output before printing tool boxes beneath it.
                            if (UI.streaming === 'live' && streamStarted && process.stdout.isTTY) {
                                live.done();
                                assistantContentRendered = true;
                            } else if (streamStarted && fullContent && !assistantContentRendered) {
                                console.log(renderAssistantMarkdown(fullContent));
                                assistantContentRendered = true;
                            }
                        }

                        for (const tcDelta of delta.tool_calls) {
                            if (tcDelta.index !== undefined) {
                                if (toolCalls.length <= tcDelta.index) {
                                    toolCalls.push({
                                        id: '',
                                        type: 'function',
                                        function: { name: '', arguments: '' },
                                    });
                                }
                                const current = toolCalls[tcDelta.index];
                                if (tcDelta.id) current.id += tcDelta.id;
                                if (tcDelta.function?.name) current.function.name += tcDelta.function.name;
                                if (tcDelta.function?.arguments) current.function.arguments += tcDelta.function.arguments;
                            }
                        }
                    }

                    // Track usage if available
                    if ((chunk as any).usage) {
                        const usage = (chunk as any).usage;
                        this.totalTokens.input += usage.prompt_tokens || 0;
                        this.totalTokens.output += usage.completion_tokens || 0;
                    }
                }

                // If we were streaming, show the end indicator
                if (streamStarted) this.status.stopSpinner();

                const assistantMessage: any = {
                    role: 'assistant',
                    content: fullContent || null,
                };

                if (toolCalls.length > 0) {
                    assistantMessage.tool_calls = toolCalls;
                    messages.push(assistantMessage);
                    this.conversationHistory.push(assistantMessage);

                    let completed = false;
                    let completionSummary: string | null = null;

                    for (const toolCall of toolCalls) {
                        const functionName = toolCall.function.name;
                        let functionArgs: Record<string, unknown> = {};
                        let jsonParseError = false;
                        try {
                            functionArgs = JSON.parse(toolCall.function.arguments || '{}');
                        } catch (parseError: unknown) {
                            jsonParseError = true;
                            const errorMsg = parseError instanceof Error ? parseError.message : 'Unknown parse error';
                            // Report JSON parse error to LLM so it can retry with valid JSON
                            const toolMessage = {
                                role: 'tool' as const,
                                tool_call_id: toolCall.id,
                                name: functionName,
                                content: `Error: Invalid JSON arguments provided. Parse error: ${errorMsg}. Please retry with valid JSON.`,
                            };
                            messages.push(toolMessage);
                            this.conversationHistory.push(toolMessage);
                            console.log(formatToolResult(`JSON parse error: ${errorMsg}`, false));
                            continue;
                        }

                        // Skip if JSON parsing failed (already handled above)
                        if (jsonParseError) continue;

                        console.log(formatToolCall(functionName, functionArgs));

                        let toolOutput: string;
                        let toolSuccess = true;

                        // Validate arguments using Zod schemas
                        const validation = validateToolArgs(functionName, functionArgs);
                        if (!validation.success) {
                            toolOutput = validation.error;
                            toolSuccess = false;
                        } else if (functionName === 'ask_user') {
                            // Special handling for ask_user tool - prompt user for input
                            this.status.setState('waiting', 'for user input');
                            toolOutput = await this.askUser(validation.data.question);
                            this.status.stopSpinner();
                            // Display the user's response
                            console.log(formatToolResult(`User responded: ${toolOutput}`, true));
                        } else if (availableTools[functionName]) {
                            // Determine if we need confirmation based on safety level
                            let needsConfirmation = false;

                            if (this._safetyLevel === 'full' && DANGEROUS_TOOLS.includes(functionName)) {
                                needsConfirmation = true;
                            } else if (this._safetyLevel === 'delete-only' && CRITICAL_TOOLS.includes(functionName)) {
                                needsConfirmation = true;
                            }

                            if (needsConfirmation) {
                                this.status.showWaitingForConfirmation();
                                const confirmed = await this.confirmDangerousAction(functionName, validation.data);
                                if (!confirmed) {
                                    this.status.showDenied();
                                    toolOutput = 'User denied this operation. Please ask for user consent before retrying, or try a different approach.';
                                    toolSuccess = false;
                                } else {
                                    this.status.showApproved();
                                    this.status.setState('executing', functionName);
                                    try {
                                        toolOutput = await availableTools[functionName](validation.data);
                                    } catch (toolError: unknown) {
                                        const errMsg = toolError instanceof Error ? toolError.message : String(toolError);
                                        toolOutput = `Tool execution failed unexpectedly: ${errMsg}`;
                                        toolSuccess = false;
                                    }
                                    this.status.stopSpinner();
                                }
                            } else {
                                // Auto-approved tool execution
                                this.status.setState('executing', functionName);
                                try {
                                    toolOutput = await availableTools[functionName](validation.data);
                                } catch (toolError: unknown) {
                                    const errMsg = toolError instanceof Error ? toolError.message : String(toolError);
                                    toolOutput = `Tool execution failed unexpectedly: ${errMsg}`;
                                    toolSuccess = false;
                                }
                                this.status.stopSpinner();
                            }
                        } else {
                            toolOutput = `Error: Tool ${functionName} not found.`;
                            toolSuccess = false;
                        }

                        // Display formatted result with success/error indication
                        console.log(formatToolResult(toolOutput, toolSuccess));

                        const fullToolMessage = {
                            role: 'tool' as const,
                            tool_call_id: toolCall.id,
                            name: functionName,
                            content: toolOutput,
                        };
                        messages.push(fullToolMessage);

                        const historyToolMessage = {
                            ...fullToolMessage,
                            content: this.truncateToolOutputForHistory(functionName, toolOutput),
                        };
                        this.conversationHistory.push(historyToolMessage);

                        if (functionName === 'task_complete') {
                            completed = true;
                            completionSummary = (validation.success ? validation.data?.summary : null) || toolOutput || null;
                        }
                    }

                    if (completed) {
                        if (completionSummary && this._debug) {
                            console.log(chalk.dim(`\n[Debug] task_complete summary: ${completionSummary}`));
                        }
                        console.log(chalk.dim(`\n📊 Tokens: ${this.totalTokens.input.toLocaleString()} in / ${this.totalTokens.output.toLocaleString()} out`));
                        this.status.setState('complete');
                        break;
                    }
                } else {
                    // No tools called - check if LLM is asking a question (fallback for models that don't use ask_user)
                    messages.push(assistantMessage);
                    this.conversationHistory.push(assistantMessage);

                    // Phase 1 UI cleanup:
                    // We intentionally avoid re-printing the full response after streaming,
                    // since it causes confusing duplicate output (raw streamed text + formatted reprint).
                    if (fullContent && !assistantContentRendered) {
                        if (UI.streaming === 'live' && process.stdout.isTTY && streamStarted) {
                            live.done();
                        } else {
                            console.log(renderAssistantMarkdown(fullContent));
                        }
                        assistantContentRendered = true;
                    }

                    // Check if the response appears to be asking a question or soliciting input
                    // This is a fallback for models that don't properly use the ask_user tool
                    const trimmedContent = (fullContent || '').trim();
                    const lastSentence = trimmedContent.slice(-200); // Check last 200 chars
                    const appearsToAskQuestion =
                        lastSentence.includes('?') ||
                        /would you like/i.test(lastSentence) ||
                        /do you want/i.test(lastSentence) ||
                        /should i/i.test(lastSentence) ||
                        /shall i/i.test(lastSentence) ||
                        /let me know/i.test(lastSentence) ||
                        /please (confirm|respond|reply)/i.test(lastSentence);

                    if (appearsToAskQuestion) {
                        // LLM seems to be asking for input - prompt user to continue
                        console.log(chalk.dim(`\n📊 Tokens: ${this.totalTokens.input.toLocaleString()} in / ${this.totalTokens.output.toLocaleString()} out`));
                        console.log(chalk.cyan('\n💬 The assistant appears to be waiting for your response.'));
                        console.log(chalk.dim('   Type your response below, or press Enter to end the conversation.\n'));

                        // Get user response
                        const userResponse = await this.askUserSimple();

                        if (userResponse.trim()) {
                            // User provided input - add it and continue the loop
                            this.conversationHistory.push({ role: 'user', content: userResponse });
                            messages.push({ role: 'user', content: userResponse });
                            continue; // Continue the agent loop with the new input
                        } else {
                            // Empty response - user wants to end
                            this.status.setState('complete');
                            break;
                        }
                    }

                    // Model produced text but did not call a tool. Do not exit: force explicit completion.
                    messages.push({
                        role: 'system',
                        content: 'You did not call a tool. If you are trying to perform an action, call the appropriate tool. If you are done, call task_complete.'
                    });
                    continue;
                }
            } catch (error: any) {
                this.status.setState('error', error.message || 'Unknown error');
                break;
            }
        }

        await this.saveHistory();
    }

    // ============================================================================
    // PLANNING MODE - Read-only exploration + plan generation
    // ============================================================================

    /**
     * Build the planning-specific system prompt
     */
    private buildPlanningSystemPrompt(task: string): string {
        return `
You are a planning assistant for a coding agent. Your job is to analyze the codebase and create a detailed execution plan.

=== TASK TO PLAN ===
${task}

=== MODE ===
You are in PLANNING MODE. You can ONLY use read-only tools to explore the codebase:
- read_file, read_file_with_lines: Read file contents
- list_directory: List files and folders
- find_files: Find files by pattern
- search_files: Search for text in files
- get_file_info: Get file metadata

You CANNOT modify anything. Use these tools to understand the codebase structure, find relevant files, and understand the existing code.

=== PROJECT CONTEXT ===
- Working Directory: ${process.cwd()}
- Project Type: ${this.projectContext || 'Unknown'}

=== PROJECT STRUCTURE ===
${this.projectMap || '(Project map not available)'}

=== YOUR WORKFLOW ===
1. First, explore the codebase to understand:
   - What files are relevant to the task
   - How the existing code is structured
   - What patterns/conventions are used
   - What dependencies or imports might be needed

2. Then, output a detailed EXECUTION PLAN in this exact format:

📋 EXECUTION PLAN
━━━━━━━━━━━━━━━━━
Task: [Brief description]

Steps:
1. [First step - be specific about which file, what changes]
2. [Second step]
3. [Third step]
...

Files to modify:
- path/to/file1.ts (what changes)
- path/to/file2.ts (what changes)

Files to create:
- path/to/newfile.ts (purpose)

Risks/considerations:
- [Any potential issues to watch for]

Estimated tool calls: [number]

=== IMPORTANT ===
- Be SPECIFIC: mention exact file paths, line numbers if known, function names
- Think about DEPENDENCIES: what needs to happen first
- Consider SAFETY: note any destructive operations
- After exploring, ALWAYS output the execution plan
`;
    }

    /**
     * Create a plan for a task using read-only exploration of the codebase.
     * The LLM explores relevant files and then outputs a structured plan.
     */
    async plan(task: string): Promise<void> {
        console.log('');
        console.log(chalk.cyan.bold('🗺️  Planning Mode') + chalk.dim(' (read-only exploration)'));
        console.log(chalk.dim('─'.repeat(55)));

        // Clear any previous plan
        this.clearPlan();

        // Build messages with planning-specific system prompt
        const systemPrompt: ChatCompletionMessageParam = {
            role: 'system',
            content: this.buildPlanningSystemPrompt(task)
        };

        // Start fresh for planning (don't use conversation history)
        const messages: any[] = [systemPrompt, { role: 'user', content: `Please analyze the codebase and create a plan for: ${task}` }];

        const maxSteps = 10; // Allow exploration steps
        let currentStep = 0;

        this.status.startRequest();

        while (currentStep < maxSteps) {
            currentStep++;

            try {
                const stepInfo = currentStep > 1 ? `exploring step ${currentStep}` : 'analyzing';
                this.status.setState('thinking', stepInfo);

                const modelToUse = this.webSearchEnabled ? `${this.currentModel}:online` : this.currentModel;

                const response = await this.callWithRetry(() =>
                    this.openai.chat.completions.create({
                        model: modelToUse,
                        messages: messages,
                        tools: readOnlyTools as any, // Only read-only tools!
                        temperature: 0,
                        stream: true,
                    })
                );

                let streamStarted = false;
                let fullContent = '';
                let toolCalls: any[] = [];
                let hasToolCalls = false;
                let assistantContentRendered = false;
                const live = new LiveAssistantRenderer({ render: renderAssistantMarkdown, throttleMs: 60 });

                for await (const chunk of response) {
                    const delta = chunk.choices[0]?.delta;

                    if (delta?.content) {
                        if (!streamStarted) {
                            this.status.setState('streaming');
                            streamStarted = true;
                            if (UI.streaming === 'live') live.start();
                        }
                        fullContent += delta.content;
                        this.status.updateStreaming(delta.content.length);
                        if (UI.streaming === 'live' && process.stdout.isTTY) {
                            live.update(fullContent);
                        }
                    }

                    if (delta?.tool_calls) {
                        if (!hasToolCalls) {
                            this.status.stopSpinner();
                            hasToolCalls = true;
                            if (UI.streaming === 'live' && streamStarted && process.stdout.isTTY) {
                                live.done();
                                assistantContentRendered = true;
                            } else if (streamStarted && fullContent && !assistantContentRendered) {
                                console.log(renderAssistantMarkdown(fullContent));
                                assistantContentRendered = true;
                            }
                        }

                        for (const tcDelta of delta.tool_calls) {
                            if (tcDelta.index !== undefined) {
                                if (toolCalls.length <= tcDelta.index) {
                                    toolCalls.push({
                                        id: '',
                                        type: 'function',
                                        function: { name: '', arguments: '' },
                                    });
                                }
                                const current = toolCalls[tcDelta.index];
                                if (tcDelta.id) current.id += tcDelta.id;
                                if (tcDelta.function?.name) current.function.name += tcDelta.function.name;
                                if (tcDelta.function?.arguments) current.function.arguments += tcDelta.function.arguments;
                            }
                        }
                    }

                    if ((chunk as any).usage) {
                        const usage = (chunk as any).usage;
                        this.totalTokens.input += usage.prompt_tokens || 0;
                        this.totalTokens.output += usage.completion_tokens || 0;
                    }
                }

                if (streamStarted && fullContent) {
                    this.status.stopSpinner();
                }

                const assistantMessage: any = {
                    role: 'assistant',
                    content: fullContent || null,
                };

                if (toolCalls.length > 0) {
                    assistantMessage.tool_calls = toolCalls;
                    messages.push(assistantMessage);

                    // Execute read-only tools
                    for (const toolCall of toolCalls) {
                        const functionName = toolCall.function.name;

                        // Double-check it's a read-only tool
                        if (!READ_ONLY_TOOL_NAMES.includes(functionName)) {
                            console.log(chalk.red(`\\n⚠️ Blocked non-read-only tool in planning mode: ${functionName}`));
                            const toolMessage = {
                                role: 'tool' as const,
                                tool_call_id: toolCall.id,
                                name: functionName,
                                content: 'Error: This tool is not available in planning mode. Only read-only tools are allowed.',
                            };
                            messages.push(toolMessage);
                            continue;
                        }

                        let functionArgs: Record<string, unknown> = {};
                        try {
                            functionArgs = JSON.parse(toolCall.function.arguments || '{}');
                        } catch {
                            const toolMessage = {
                                role: 'tool' as const,
                                tool_call_id: toolCall.id,
                                name: functionName,
                                content: 'Error: Invalid JSON arguments',
                            };
                            messages.push(toolMessage);
                            continue;
                        }

                        console.log(formatToolCall(functionName, functionArgs));

                        // Validate and execute
                        const validation = validateToolArgs(functionName, functionArgs);
                        let toolOutput: string;

                        if (!validation.success) {
                            toolOutput = validation.error;
                        } else if (functionName === 'ask_user') {
                            // Special handling for ask_user tool - prompt user for input
                            this.status.setState('waiting', 'for user input');
                            toolOutput = await this.askUser(validation.data.question);
                            this.status.stopSpinner();
                            console.log(formatToolResult(`User responded: ${toolOutput}`, true, 200));
                        } else if (availableTools[functionName]) {
                            this.status.setState('executing', functionName);
                            try {
                                toolOutput = await availableTools[functionName](validation.data);
                            } catch (err: unknown) {
                                const errMsg = err instanceof Error ? err.message : String(err);
                                toolOutput = `Error: ${errMsg}`;
                            }
                            this.status.stopSpinner();
                        } else {
                            toolOutput = `Error: Tool ${functionName} not found`;
                        }

                        console.log(formatToolResult(toolOutput, true, 200)); // Shorter output in planning mode

                        const toolMessage = {
                            role: 'tool' as const,
                            tool_call_id: toolCall.id,
                            name: functionName,
                            content: toolOutput,
                        };
                        messages.push(toolMessage);
                    }
                } else {
                    // No tool calls - LLM has finished and should have output the plan
                    messages.push(assistantMessage);

                    if (fullContent && !assistantContentRendered) {
                        if (UI.streaming === 'live' && process.stdout.isTTY && streamStarted) {
                            live.done();
                        } else {
                            console.log(renderAssistantMarkdown(fullContent));
                        }
                        assistantContentRendered = true;
                    }

                    // Check if the response contains a plan
                    if (fullContent && (fullContent.includes('EXECUTION PLAN') || fullContent.includes('Steps:'))) {
                        // Store the plan
                        this.pendingPlan = fullContent;
                        this.pendingPlanTask = task;

                        console.log('');
                        console.log(chalk.green.bold('✓ Plan created!'));
                        console.log(chalk.dim(`  Type ${chalk.yellow('/run')} to execute this plan`));
                        console.log(chalk.dim(`  Type ${chalk.yellow('/plan <new task>')} to create a different plan`));
                        console.log(chalk.dim(`  Or continue chatting normally`));
                    } else {
                        console.log(chalk.yellow('\\n⚠️ No structured plan detected in response.'));
                    }

                    this.status.setState('complete');
                    break;
                }
            } catch (error: any) {
                this.status.setState('error', error.message || 'Unknown error');
                break;
            }
        }

        if (currentStep >= maxSteps) {
            console.log(chalk.yellow(`\\n⚠️ Reached maximum exploration steps (${maxSteps}).`));
        }
    }

    /**
     * Execute the pending plan with full tool access
     */
    async executePlan(): Promise<void> {
        if (!this.pendingPlan || !this.pendingPlanTask) {
            console.log(chalk.yellow('No pending plan to execute. Use /plan <task> first.'));
            return;
        }

        console.log('');
        console.log(chalk.cyan.bold('⚡ Executing Plan'));
        console.log(chalk.dim('─'.repeat(55)));
        console.log(chalk.dim(`Task: ${this.pendingPlanTask}`));
        console.log('');

        // Construct a prompt that includes the plan
        const executionPrompt = `
Execute the following plan that was created after analyzing the codebase:

=== ORIGINAL TASK ===
${this.pendingPlanTask}

=== APPROVED PLAN ===
${this.pendingPlan}

=== INSTRUCTIONS ===
Execute each step in the plan. You now have access to ALL tools including write, edit, and execute.
Follow the plan closely but adapt if you encounter any unexpected issues.
`;

        // Clear the plan after execution starts
        this.clearPlan();

        // Run with full tools
        await this.run(executionPrompt);
    }
}
