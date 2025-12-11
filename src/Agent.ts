import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import * as readline from 'readline';
import ora, { Ora } from 'ora';
import chalk from 'chalk';
import { highlight } from 'cli-highlight';
import { tools, availableTools, detectProjectType, validateToolArgs, generateProjectMap } from './tools';

// Configuration
const HISTORY_FILE = path.join(process.cwd(), '.agent_history.json');
const MAX_HISTORY_MESSAGES = 50;
const MAX_CONTEXT_TOKENS = 100000; // Safe limit for context window
const CHARS_PER_TOKEN = 4; // Rough approximation: 4 characters = 1 token

// ============================================================================
// STATUS & UI HELPERS
// ============================================================================

/**
 * Agent states for visual feedback
 */
type AgentState = 'idle' | 'thinking' | 'streaming' | 'tool_calling' | 'executing' | 'complete' | 'error';

/**
 * Status display manager for rich visual feedback
 */
class StatusDisplay {
    private spinner: Ora | null = null;
    private startTime: number = 0;
    private stepCount: number = 0;
    private totalToolCalls: number = 0;
    private streamingChars: number = 0;

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

        switch (state) {
            case 'thinking':
                this.spinner = ora({
                    text: chalk.cyan(`🧠 Thinking... ${context ? `(${context})` : ''}`),
                    spinner: 'dots12',
                    color: 'cyan'
                }).start();
                break;

            case 'streaming':
                // Don't use spinner for streaming - we'll update inline
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
            console.log(chalk.dim(`\n─── Step ${this.stepCount} ───────────────────────────────────────────`));
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

    return `\n${chalk.dim('┌─')} ${chalk.yellow('🔧 ' + name)} ${chalk.dim('─'.repeat(Math.max(0, 45 - name.length)) + '┐')}\n${summary}\n${chalk.dim('└' + '─'.repeat(54) + '┘')}`;
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

    return `\n${color('┌─')} ${icon} ${success ? chalk.dim('Result') : chalk.red('Error')} ${color('─'.repeat(43) + '┐')}\n${colorizedOutput}\n${color('└' + '─'.repeat(54) + '┘')}`
}

interface TokenUsage {
    input: number;
    output: number;
}

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
    private conversationHistory: any[] = [];
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

        console.log('');
        console.log('┌────────────────────────────────────────────────────────────┐');
        console.log('│  ⚠️   DANGEROUS OPERATION - Confirmation Required          │');
        console.log('├────────────────────────────────────────────────────────────┤');
        console.log(`│  Operation: ${operationType.padEnd(46)}│`);

        // Handle long paths by truncating
        const displayPath = targetPath.length > 50
            ? '...' + targetPath.slice(-47)
            : targetPath;
        console.log(`│  Target:    ${displayPath.padEnd(46)}│`);

        if (details) {
            const displayDetails = details.length > 46
                ? details.slice(0, 43) + '...'
                : details;
            console.log(`│  Details:   ${displayDetails.padEnd(46)}│`);
        }

        console.log('└────────────────────────────────────────────────────────────┘');

        // Pause the main readline if it exists to prevent double input
        if (this.rl) {
            this.rl.pause();
        }

        // Create a fresh readline interface for the confirmation prompt
        return new Promise((resolve) => {
            const confirmRl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
                terminal: false, // Disable terminal features to prevent echo issues
            });

            process.stdout.write('Allow? (y/yes to confirm): ');

            confirmRl.once('line', (answer) => {
                confirmRl.close();

                // Resume the main readline
                if (this.rl) {
                    this.rl.resume();
                }

                const confirmed = answer.toLowerCase().trim() === 'y' || answer.toLowerCase().trim() === 'yes';
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
        // Pause the main readline if it exists to prevent double input
        if (this.rl) {
            this.rl.pause();
        }

        return new Promise((resolve) => {
            const confirmRl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
                terminal: false,
            });

            process.stdout.write(chalk.yellow('Continue? (y/yes to continue): '));

            confirmRl.once('line', (answer) => {
                confirmRl.close();

                // Resume the main readline
                if (this.rl) {
                    this.rl.resume();
                }

                const shouldContinue = answer.toLowerCase().trim() === 'y' || answer.toLowerCase().trim() === 'yes';
                resolve(shouldContinue);
            });
        });
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
        } catch {
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
    private prepareMessagesForAPI(): any[] {
        const systemPrompt = { role: 'system', content: this.buildSystemPrompt() };

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
                        stream: true,
                    })
                );

                let streamStarted = false;
                let fullContent = '';
                let toolCalls: any[] = [];
                let hasToolCalls = false;

                for await (const chunk of response) {
                    const delta = chunk.choices[0]?.delta;

                    if (delta?.content) {
                        // First content received - transition to streaming state
                        if (!streamStarted) {
                            this.status.setState('streaming');
                            this.status.printStreamStart();
                            streamStarted = true;
                        }

                        process.stdout.write(delta.content);
                        fullContent += delta.content;
                        this.status.updateStreaming(delta.content.length);
                    }

                    if (delta?.tool_calls) {
                        // Stop any spinners, we're processing tool calls
                        if (!hasToolCalls) {
                            this.status.stopSpinner();
                            hasToolCalls = true;
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
                if (streamStarted && fullContent) {
                    this.status.printStreamEnd();
                }

                const assistantMessage: any = {
                    role: 'assistant',
                    content: fullContent || null,
                };

                if (toolCalls.length > 0) {
                    assistantMessage.tool_calls = toolCalls;
                    messages.push(assistantMessage);
                    this.conversationHistory.push(assistantMessage);

                    for (const toolCall of toolCalls) {
                        const functionName = toolCall.function.name;
                        let functionArgs: any = {};
                        try {
                            functionArgs = JSON.parse(toolCall.function.arguments || '{}');
                        } catch {
                            functionArgs = {};
                        }

                        console.log(formatToolCall(functionName, functionArgs));

                        let toolOutput: string;
                        let toolSuccess = true;

                        // Validate arguments using Zod schemas
                        const validation = validateToolArgs(functionName, functionArgs);
                        if (!validation.success) {
                            toolOutput = validation.error;
                            toolSuccess = false;
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
                                    toolOutput = await availableTools[functionName](validation.data);
                                    this.status.stopSpinner();
                                }
                            } else {
                                // Auto-approved tool execution
                                this.status.setState('executing', functionName);
                                toolOutput = await availableTools[functionName](validation.data);
                                this.status.stopSpinner();
                            }
                        } else {
                            toolOutput = `Error: Tool ${functionName} not found.`;
                            toolSuccess = false;
                        }

                        // Display formatted result with success/error indication
                        console.log(formatToolResult(toolOutput, toolSuccess));

                        const toolMessage = {
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            name: functionName,
                            content: toolOutput,
                        };
                        messages.push(toolMessage);
                        this.conversationHistory.push(toolMessage);
                    }
                } else {
                    // No tools called, we are done
                    messages.push(assistantMessage);
                    this.conversationHistory.push(assistantMessage);

                    // Apply syntax highlighting to code blocks in final response
                    if (fullContent) {
                        const hasCodeBlocks = fullContent.includes('```');
                        if (hasCodeBlocks) {
                            console.log('\n' + formatResponseWithHighlighting(fullContent));
                        }
                    }

                    // Display token usage for this session
                    console.log(chalk.dim(`\n📊 Tokens: ${this.totalTokens.input.toLocaleString()} in / ${this.totalTokens.output.toLocaleString()} out`));

                    // Show completion status
                    this.status.setState('complete');
                    break;
                }
            } catch (error: any) {
                this.status.setState('error', error.message || 'Unknown error');
                break;
            }
        }

        await this.saveHistory();
    }
}
