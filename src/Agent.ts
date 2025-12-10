import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import * as readline from 'readline';
import { tools, availableTools, detectProjectType, validateToolArgs } from './tools';

// Configuration
const HISTORY_FILE = path.join(process.cwd(), '.agent_history.json');
const MAX_HISTORY_MESSAGES = 50;
const MAX_CONTEXT_TOKENS = 100000; // Safe limit for context window
const CHARS_PER_TOKEN = 4; // Rough approximation: 4 characters = 1 token

interface TokenUsage {
    input: number;
    output: number;
}

interface AgentConfig {
    model?: string;
    webSearchEnabled?: boolean;
    apiKey?: string;
    safeMode?: boolean;
    readlineInterface?: readline.Interface;
}

// Tools that require user confirmation in safe mode
const DANGEROUS_TOOLS = ['execute_command', 'delete_file', 'write_file', 'move_file'];

export class Agent {
    private openai: OpenAI;
    private conversationHistory: any[] = [];
    private totalTokens: TokenUsage = { input: 0, output: 0 };
    private currentModel: string;
    private webSearchEnabled: boolean;
    private projectContext: string = '';
    private _safeMode: boolean;
    private rl: readline.Interface | null = null;

    constructor(config: AgentConfig = {}) {
        this.currentModel = config.model || process.env.OPENROUTER_MODEL || 'mistralai/devstral-2512:free';
        this.webSearchEnabled = config.webSearchEnabled || false;
        this._safeMode = config.safeMode !== undefined ? config.safeMode : true;
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

    get safeMode(): boolean {
        return this._safeMode;
    }

    set safeMode(value: boolean) {
        this._safeMode = value;
    }

    setReadlineInterface(rl: readline.Interface): void {
        this.rl = rl;
    }

    // ============================================================================
    // USER CONFIRMATION FOR DANGEROUS TOOLS
    // ============================================================================

    private async confirmDangerousAction(toolName: string, args: any): Promise<boolean> {
        if (!this.rl) {
            console.log('\n[Warning] No readline interface available for confirmation. Denying action.');
            return false;
        }

        return new Promise((resolve) => {
            console.log('\n┌─────────────────────────────────────────────────────────────┐');
            console.log('│  ⚠️  DANGEROUS OPERATION - User Confirmation Required       │');
            console.log('├─────────────────────────────────────────────────────────────┤');
            console.log(`│  Tool: ${toolName.padEnd(52)}│`);
            console.log('│  Arguments:                                                 │');

            // Display args in a readable format
            const argsStr = JSON.stringify(args, null, 2);
            const argsLines = argsStr.split('\n');
            for (const line of argsLines.slice(0, 10)) {
                const truncatedLine = line.length > 57 ? line.slice(0, 54) + '...' : line;
                console.log(`│    ${truncatedLine.padEnd(56)}│`);
            }
            if (argsLines.length > 10) {
                console.log(`│    ... (${argsLines.length - 10} more lines)`.padEnd(62) + '│');
            }

            console.log('└─────────────────────────────────────────────────────────────┘');

            this.rl!.question('Allow this operation? (y/yes to confirm, any other key to deny): ', (answer) => {
                const confirmed = answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
                if (confirmed) {
                    console.log('[✓] Operation approved by user');
                } else {
                    console.log('[✗] Operation denied by user');
                }
                resolve(confirmed);
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

PROJECT CONTEXT:
- Working Directory: ${process.cwd()}
- Project Type: ${this.projectContext || 'Unknown'}

AVAILABLE TOOLS:
File Operations:
- read_file: Read file content (supports line ranges for large files)
- write_file: Write to files (auto-creates directories, creates backup)
- delete_file: Delete files or directories
- move_file: Move or rename files
- get_file_info: Get file metadata (size, line count, dates)

Edit Operations:
- edit_file: Find-and-replace edit (creates backup, shows diff)
- multi_edit_file: Multiple edits in one operation
- insert_at_line: Insert content at specific line number

Search & Navigation:
- list_directory: List files (supports recursive, show sizes)
- find_files: Find files by glob pattern (*.ts, test*)
- search_files: Search text in files (supports regex, extension filter)
- get_current_directory: Get current working directory

System:
- execute_command: Run shell commands (supports cwd, timeout)

BEHAVIOR:
- When editing files, prefer edit_file or multi_edit_file over write_file for targeted changes.
- Use read_file with line ranges for large files.
- Always explore the codebase before making changes.
- Create backups are automatic - don't worry about data loss.
- If a command fails, analyze the error and try to fix it.
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
     */
    private trimToTokenLimit(messages: any[], maxTokens: number): any[] {
        // Reserve tokens for system prompt (estimate ~1500 tokens for safety)
        const systemPromptReserve = 1500;
        const availableTokens = maxTokens - systemPromptReserve;

        let estimatedTokens = this.estimateMessagesTokens(messages);

        if (estimatedTokens <= availableTokens) {
            return messages;
        }

        // Need to trim - remove oldest messages first
        const trimmedMessages = [...messages];
        let removed = 0;

        while (estimatedTokens > availableTokens && trimmedMessages.length > 1) {
            // Remove the oldest message
            trimmedMessages.shift();
            removed++;
            estimatedTokens = this.estimateMessagesTokens(trimmedMessages);
        }

        if (removed > 0) {
            console.log(`\n[Context Management] Removed ${removed} oldest message(s) to stay under token limit.`);
            console.log(`[Context Management] Estimated tokens: ${estimatedTokens} / ${availableTokens} available`);
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

        let step = 0;
        const maxSteps = 15;

        console.log('\nAgent response:');

        while (step < maxSteps) {
            step++;
            try {
                // Build model name with :online suffix if web search enabled
                const modelToUse = this.webSearchEnabled ? `${this.currentModel}:online` : this.currentModel;

                const response = await this.callWithRetry(() =>
                    this.openai.chat.completions.create({
                        model: modelToUse,
                        messages: messages,
                        tools: tools as any,
                        stream: true,
                    })
                );

                let fullContent = '';
                let toolCalls: any[] = [];

                for await (const chunk of response) {
                    const delta = chunk.choices[0]?.delta;

                    if (delta?.content) {
                        process.stdout.write(delta.content);
                        fullContent += delta.content;
                    }

                    if (delta?.tool_calls) {
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

                        console.log(`\n[Tool Call] ${functionName}(${JSON.stringify(functionArgs)})`);

                        let toolOutput: string;

                        // Validate arguments using Zod schemas
                        const validation = validateToolArgs(functionName, functionArgs);
                        if (!validation.success) {
                            toolOutput = validation.error;
                        } else if (availableTools[functionName]) {
                            // Check if this is a dangerous tool and safeMode is enabled
                            if (this._safeMode && DANGEROUS_TOOLS.includes(functionName)) {
                                const confirmed = await this.confirmDangerousAction(functionName, validation.data);
                                if (!confirmed) {
                                    toolOutput = 'User denied this operation. Please ask for user consent before retrying, or try a different approach.';
                                } else {
                                    toolOutput = await availableTools[functionName](validation.data);
                                }
                            } else {
                                toolOutput = await availableTools[functionName](validation.data);
                            }
                        } else {
                            toolOutput = `Error: Tool ${functionName} not found.`;
                        }

                        // Truncate very long outputs for display
                        const displayOutput = toolOutput.length > 200 ? toolOutput.slice(0, 200) + '...' : toolOutput;
                        console.log(`\n[Tool Result] ${displayOutput}`);

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
                    console.log('\n');
                    break;
                }
            } catch (error: any) {
                console.error('\nError during API call:', error.message || error);
                break;
            }
        }

        await this.saveHistory();
    }
}
