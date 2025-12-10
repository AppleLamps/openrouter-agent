import 'dotenv/config';
import OpenAI from 'openai';
import * as readline from 'readline';
import fs from 'fs/promises';
import path from 'path';
import { tools, availableTools, detectProjectType } from './tools';

// Configuration
const HISTORY_FILE = path.join(process.cwd(), '.agent_history.json');
const MAX_HISTORY_MESSAGES = 50;

// State
let currentModel = process.env.OPENROUTER_MODEL || 'mistralai/devstral-2512:free';
let webSearchEnabled = false;
let conversationHistory: any[] = [];
let totalTokens = { input: 0, output: 0 };
let projectContext = '';

const openai = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
});

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

function buildSystemPrompt(): string {
    return `
You are a highly capable AI coding agent compatible with OpenRouter.
You have access to the file system and can execute shell commands.
Your goal is to help the user with coding tasks, debugging, and general questions.

PROJECT CONTEXT:
- Working Directory: ${process.cwd()}
- Project Type: ${projectContext || 'Unknown'}

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

// History persistence
async function loadHistory() {
    try {
        const data = await fs.readFile(HISTORY_FILE, 'utf-8');
        const parsed = JSON.parse(data);
        conversationHistory = parsed.messages || [];
        totalTokens = parsed.tokens || { input: 0, output: 0 };
        console.log(`Loaded ${conversationHistory.length} messages from history.`);
    } catch {
        conversationHistory = [];
    }
}

async function saveHistory() {
    try {
        // Keep only recent messages
        const toSave = conversationHistory.slice(-MAX_HISTORY_MESSAGES);
        await fs.writeFile(HISTORY_FILE, JSON.stringify({ messages: toSave, tokens: totalTokens }, null, 2));
    } catch (err) {
        console.error('Failed to save history:', err);
    }
}

// Retry with exponential backoff
async function callWithRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
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

// Agent loop
async function runAgent(userInput: string) {
    // Add user message to history
    conversationHistory.push({ role: 'user', content: userInput });

    // Build messages with system prompt
    const messages: any[] = [
        { role: 'system', content: buildSystemPrompt() },
        ...conversationHistory,
    ];

    let step = 0;
    const maxSteps = 15;

    console.log('\nAgent response:');

    while (step < maxSteps) {
        step++;
        try {
            // Build model name with :online suffix if web search enabled
            const modelToUse = webSearchEnabled ? `${currentModel}:online` : currentModel;

            const response = await callWithRetry(() =>
                openai.chat.completions.create({
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
                    totalTokens.input += usage.prompt_tokens || 0;
                    totalTokens.output += usage.completion_tokens || 0;
                }
            }

            const assistantMessage: any = {
                role: 'assistant',
                content: fullContent || null,
            };

            if (toolCalls.length > 0) {
                assistantMessage.tool_calls = toolCalls;
                messages.push(assistantMessage);
                conversationHistory.push(assistantMessage);

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
                    if (availableTools[functionName]) {
                        toolOutput = await availableTools[functionName](functionArgs);
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
                    conversationHistory.push(toolMessage);
                }
            } else {
                // No tools called, we are done
                messages.push(assistantMessage);
                conversationHistory.push(assistantMessage);
                console.log('\n');
                break;
            }
        } catch (error: any) {
            console.error('\nError during API call:', error.message || error);
            break;
        }
    }

    await saveHistory();
}

// Command handlers
function handleCommand(input: string): boolean {
    const parts = input.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
        case '/model':
            if (parts[1]) {
                currentModel = parts[1];
                console.log(`Model changed to: ${currentModel}`);
            } else {
                console.log(`Current model: ${currentModel}`);
            }
            return true;

        case '/web':
            webSearchEnabled = !webSearchEnabled;
            console.log(`Web search: ${webSearchEnabled ? 'ENABLED' : 'DISABLED'}`);
            return true;

        case '/tokens':
            console.log(`Session tokens - Input: ${totalTokens.input}, Output: ${totalTokens.output}`);
            console.log(`Estimated cost varies by model. Check OpenRouter pricing.`);
            return true;

        case '/clear':
            conversationHistory = [];
            totalTokens = { input: 0, output: 0 };
            saveHistory();
            console.log('Conversation history cleared.');
            return true;

        case '/help':
            console.log(`
Available commands:
  /model [name]  - Show or set current model (e.g., /model openai/gpt-4o)
  /web           - Toggle web search (appends :online to model)
  /tokens        - Show token usage for this session
  /clear         - Clear conversation history
  /help          - Show this help message
  exit           - Quit the agent
      `);
            return true;

        default:
            return false;
    }
}

async function startREPL() {
    await loadHistory();
    projectContext = await detectProjectType();

    console.log('--- OpenRouter CLI Agent (Enhanced) ---');
    console.log(`Model: ${currentModel}`);
    console.log(`Project: ${projectContext}`);
    console.log(`Directory: ${process.cwd()}`);
    console.log('Type /help for commands. Type "exit" to quit.\n');

    const promptUser = () => {
        rl.question('> ', async (input) => {
            const trimmed = input.trim();

            if (trimmed.toLowerCase() === 'exit') {
                await saveHistory();
                rl.close();
                return;
            }

            if (trimmed.startsWith('/')) {
                handleCommand(trimmed);
            } else if (trimmed) {
                await runAgent(trimmed);
            }

            promptUser();
        });
    };

    promptUser();
}

startREPL();
