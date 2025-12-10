import 'dotenv/config';
import * as readline from 'readline';
import chalk from 'chalk';
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
                console.log(chalk.green(`✓ Model changed to: ${agent.model}`));
            } else {
                console.log(chalk.cyan(`Current model: ${agent.model}`));
            }
            return true;

        case '/web':
            agent.webSearch = !agent.webSearch;
            console.log(agent.webSearch
                ? chalk.green('✓ Web search: ENABLED')
                : chalk.yellow('○ Web search: DISABLED'));
            return true;

        case '/tokens':
            const tokens = agent.tokens;
            console.log(chalk.cyan(`📊 Session tokens - Input: ${tokens.input}, Output: ${tokens.output}`));
            console.log(chalk.dim('   Estimated cost varies by model. Check OpenRouter pricing.'));
            return true;

        case '/clear':
            agent.clearHistory();
            agent.saveHistory();
            console.log(chalk.green('✓ Conversation history cleared.'));
            return true;

        case '/safe':
            agent.safeMode = !agent.safeMode;
            console.log(agent.safeMode
                ? chalk.green('✓ Safe mode: ENABLED (will prompt for dangerous operations)')
                : chalk.yellow('⚠ Safe mode: DISABLED'));
            return true;

        case '/help':
            console.log(`
${chalk.bold.cyan('Available Commands:')}
  ${chalk.yellow('/model')} ${chalk.dim('[name]')}  - Show or set current model
  ${chalk.yellow('/web')}           - Toggle web search (appends :online)
  ${chalk.yellow('/safe')}          - Toggle safe mode (prompts before dangerous ops)
  ${chalk.yellow('/tokens')}        - Show token usage for this session
  ${chalk.yellow('/clear')}         - Clear conversation history
  ${chalk.yellow('/help')}          - Show this help message
  ${chalk.yellow('exit')}           - Quit the agent
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

    // Pretty startup banner
    console.log('');
    console.log(chalk.cyan.bold('╔══════════════════════════════════════════════════════╗'));
    console.log(chalk.cyan.bold('║') + chalk.white.bold('       🤖 OpenRouter CLI Agent (Enhanced)            ') + chalk.cyan.bold('║'));
    console.log(chalk.cyan.bold('╚══════════════════════════════════════════════════════╝'));
    console.log('');
    console.log(chalk.dim('┌─────────────────────────────────────────────────────┐'));
    console.log(chalk.dim('│') + ` ${chalk.cyan('Model:')}     ${chalk.white(agent.model.padEnd(40))}` + chalk.dim('│'));
    console.log(chalk.dim('│') + ` ${chalk.cyan('Safe Mode:')} ${agent.safeMode ? chalk.green('ENABLED'.padEnd(40)) : chalk.yellow('DISABLED'.padEnd(40))}` + chalk.dim('│'));
    console.log(chalk.dim('│') + ` ${chalk.cyan('Project:')}   ${chalk.white((agent.getProjectContext() || 'Unknown').slice(0, 40).padEnd(40))}` + chalk.dim('│'));
    console.log(chalk.dim('│') + ` ${chalk.cyan('Directory:')} ${chalk.white(process.cwd().slice(-40).padEnd(40))}` + chalk.dim('│'));
    console.log(chalk.dim('└─────────────────────────────────────────────────────┘'));
    console.log('');
    console.log(chalk.dim('Type') + chalk.yellow(' /help ') + chalk.dim('for commands.') + chalk.dim(' Type') + chalk.yellow(' exit ') + chalk.dim('to quit.'));
    console.log('');

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
