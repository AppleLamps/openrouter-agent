import 'dotenv/config';
import * as readline from 'readline';
import { Agent } from './Agent';

// Create readline interface
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

// Create the Agent instance and pass the readline interface
const agent = new Agent();
agent.setReadlineInterface(rl);

// ============================================================================
// COMMAND HANDLERS
// ============================================================================

function handleCommand(input: string): boolean {
    const parts = input.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
        case '/model':
            if (parts[1]) {
                agent.model = parts[1];
                console.log(`Model changed to: ${agent.model}`);
            } else {
                console.log(`Current model: ${agent.model}`);
            }
            return true;

        case '/web':
            agent.webSearch = !agent.webSearch;
            console.log(`Web search: ${agent.webSearch ? 'ENABLED' : 'DISABLED'}`);
            return true;

        case '/tokens':
            const tokens = agent.tokens;
            console.log(`Session tokens - Input: ${tokens.input}, Output: ${tokens.output}`);
            console.log(`Estimated cost varies by model. Check OpenRouter pricing.`);
            return true;

        case '/clear':
            agent.clearHistory();
            agent.saveHistory();
            console.log('Conversation history cleared.');
            return true;

        case '/safe':
            agent.safeMode = !agent.safeMode;
            console.log(`Safe mode: ${agent.safeMode ? 'ENABLED (will prompt for dangerous operations)' : 'DISABLED'}`);
            return true;

        case '/help':
            console.log(`
Available commands:
  /model [name]  - Show or set current model (e.g., /model openai/gpt-4o)
  /web           - Toggle web search (appends :online to model)
  /safe          - Toggle safe mode (prompts before dangerous operations)
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

// ============================================================================
// REPL LOOP
// ============================================================================

async function startREPL() {
    await agent.initialize();

    console.log('--- OpenRouter CLI Agent (Enhanced) ---');
    console.log(`Model: ${agent.model}`);
    console.log(`Safe Mode: ${agent.safeMode ? 'ENABLED' : 'DISABLED'}`);
    console.log(`Project: ${agent.getProjectContext()}`);
    console.log(`Directory: ${process.cwd()}`);
    console.log('Type /help for commands. Type "exit" to quit.\n');

    const promptUser = () => {
        rl.question('> ', async (input) => {
            const trimmed = input.trim();

            if (trimmed.toLowerCase() === 'exit') {
                await agent.saveHistory();
                rl.close();
                return;
            }

            if (trimmed.startsWith('/')) {
                handleCommand(trimmed);
            } else if (trimmed) {
                await agent.run(trimmed);
            }

            promptUser();
        });
    };

    promptUser();
}

startREPL();
