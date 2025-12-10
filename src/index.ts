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

async function handleCommand(input: string): Promise<boolean> {
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
            const newLevel = agent.cycleSafetyLevel();
            const levelDescriptions = {
                'full': chalk.green('FULL - prompts for all file changes'),
                'delete-only': chalk.yellow('DELETE-ONLY - only prompts for delete/execute'),
                'off': chalk.red('OFF - no prompts (dangerous!)')
            };
            console.log(`Safety level: ${levelDescriptions[newLevel]}`);
            return true;

        case '/refresh':
            console.log(chalk.cyan('Refreshing project structure...'));
            await agent.refreshProjectMap();
            console.log(chalk.green('✓ Project structure refreshed.'));
            return true;

        case '/help':
            console.log(`
${chalk.bold.cyan('Available Commands:')}
  ${chalk.yellow('/model')} ${chalk.dim('[name]')}  - Show or set current model
  ${chalk.yellow('/web')}           - Toggle web search (appends :online)
  ${chalk.yellow('/safe')}          - Cycle safety: full → delete-only → off
  ${chalk.yellow('/tokens')}        - Show token usage for this session
  ${chalk.yellow('/clear')}         - Clear conversation history
  ${chalk.yellow('/refresh')}       - Refresh project structure map
  ${chalk.yellow('/help')}          - Show this help message
  ${chalk.yellow('exit')}           - Quit the agent

${chalk.bold.cyan('Safety Levels:')}
  ${chalk.green('full')}        - Prompts for all file modifications
  ${chalk.yellow('delete-only')} - Only prompts for delete and execute commands
  ${chalk.red('off')}         - No prompts (use with caution!)
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
    const safetyColors = { 'full': chalk.green, 'delete-only': chalk.yellow, 'off': chalk.red };
    const safetyLabel = safetyColors[agent.safetyLevel](agent.safetyLevel.toUpperCase().padEnd(40));
    console.log(chalk.dim('│') + ` ${chalk.cyan('Safety:')}    ${safetyLabel}` + chalk.dim('│'));
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
                await handleCommand(trimmed);
            } else if (trimmed) {
                await agent.run(trimmed);
            }

            promptUser();
        });
    };

    promptUser();
}

startREPL();
