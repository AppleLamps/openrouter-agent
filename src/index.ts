import 'dotenv/config';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { Agent } from './Agent';
import { getTerminalColumns, renderBanner, renderBox } from './ui';

// ============================================================================
// ENVIRONMENT VALIDATION
// ============================================================================

function validateEnvironment(): void {
    if (!process.env.OPENROUTER_API_KEY) {
        console.error(chalk.red.bold('\n❌ Error: OPENROUTER_API_KEY environment variable is not set.\n'));
        console.error(chalk.yellow('To fix this, either:\n'));
        console.error(chalk.white('  1. Create a .env file in the project root with:'));
        console.error(chalk.cyan('     OPENROUTER_API_KEY=your_api_key_here\n'));
        console.error(chalk.white('  2. Or set it in your terminal:'));
        console.error(chalk.cyan('     export OPENROUTER_API_KEY=your_api_key_here  (Linux/Mac)'));
        console.error(chalk.cyan('     $env:OPENROUTER_API_KEY="your_api_key_here"  (PowerShell)\n'));
        console.error(chalk.dim('Get your API key from: https://openrouter.ai/keys\n'));
        process.exit(1);
    }
}

// Validate environment before proceeding
validateEnvironment();

// Available commands for tab-completion
const COMMANDS = ['/model', '/web', '/tokens', '/clear', '/safe', '/refresh', '/help', '/cls', '/config', '/cost', '/map', '/debug', '/ui', '/plan', '/run', 'exit'];

// History file path
const HISTORY_PATH = path.join(process.cwd(), '.ora_history');
const MAX_HISTORY_LINES = 200;

// Create readline interface with tab-completion
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: (line: string): [string[], string] => {
        const trimmed = line.trim();
        const hits = COMMANDS.filter(c => c.startsWith(trimmed));
        // Return [matches, line] – readline will display the list if >1
        return [hits.length ? hits : COMMANDS, line];
    },
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

        case '/c':
        case '/clear':
            agent.clearHistory();
            agent.saveHistory();
            console.log(chalk.green('✓ Conversation history cleared.'));
            return true;

        case '/cls':
            console.clear();
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
            await agent.refreshProjectMap(true); // Force refresh, bypass cache
            console.log(chalk.green('✓ Project structure refreshed.'));
            return true;

        case '/config':
            console.log('');
            console.log(chalk.bold.cyan('Current Configuration:'));
            console.log(`  ${chalk.cyan('Model:')}     ${chalk.white(agent.model)}`);
            console.log(`  ${chalk.cyan('Web:')}       ${agent.webSearch ? chalk.green('ON') : chalk.yellow('OFF')}`);
            const safetyColor = agent.safetyLevel === 'full' ? chalk.green : agent.safetyLevel === 'delete-only' ? chalk.yellow : chalk.red;
            console.log(`  ${chalk.cyan('Safety:')}    ${safetyColor(agent.safetyLevel.toUpperCase())}`);
            console.log(`  ${chalk.cyan('Project:')}   ${chalk.white(agent.getProjectContext() || 'Unknown')}`);
            console.log(`  ${chalk.cyan('Directory:')} ${chalk.white(process.cwd())}`);
            const tokenCount = agent.tokens;
            console.log(`  ${chalk.cyan('Tokens:')}    ${chalk.white(`${tokenCount.input} in / ${tokenCount.output} out`)}`);
            console.log('');
            return true;

        case '/cost':
            const costTokens = agent.tokens;
            // Approximate pricing (GPT-4o rates as example - actual varies by model)
            const inputCost = (costTokens.input / 1000) * 0.005; // $5 per 1M input
            const outputCost = (costTokens.output / 1000) * 0.015; // $15 per 1M output
            const totalCost = inputCost + outputCost;
            console.log(chalk.cyan(`💰 Token usage this session:`));
            console.log(`   Input:  ${chalk.white(costTokens.input.toLocaleString())} tokens`);
            console.log(`   Output: ${chalk.white(costTokens.output.toLocaleString())} tokens`);
            console.log(`   ${chalk.dim('Estimated cost: ~$' + totalCost.toFixed(5))} ${chalk.dim('(varies by model)')}`);
            return true;

        case '/map':
            const projectMap = agent.getProjectMap();
            if (projectMap) {
                console.log(chalk.bold.cyan('\nProject Structure:'));
                console.log(projectMap);
            } else {
                console.log(chalk.yellow('No project map generated yet. Run /refresh to generate.'));
            }
            return true;

        case '/debug':
            const debugState = agent.toggleDebug();
            console.log(`Debug mode: ${debugState ? chalk.green('ON') : chalk.yellow('OFF')}`);
            return true;

        case '/ui': {
            // /ui
            // /ui width 80
            // /ui markdown on|off
            // /ui stream live|final
            // /ui legend on|off
            // /ui reset
            const sub = (parts[1] || '').toLowerCase();
            const arg = (parts[2] || '').toLowerCase();

            if (!sub) {
                const ui = agent.getUiConfig();
                console.log('');
                console.log(chalk.bold.cyan('UI Settings:'));
                console.log(`  ${chalk.cyan('Width:')}     ${chalk.white(String(ui.maxWidth))}`);
                console.log(`  ${chalk.cyan('Markdown:')}  ${ui.markdown ? chalk.green('ON') : chalk.yellow('OFF')}`);
                console.log(`  ${chalk.cyan('Streaming:')} ${chalk.white(ui.streaming.toUpperCase())}`);
                console.log(`  ${chalk.cyan('Legend:')}    ${ui.showLegendOnStartup ? chalk.green('ON') : chalk.yellow('OFF')} ${chalk.dim('(startup)')}`);
                console.log('');
                console.log(chalk.dim('Usage:'));
                console.log(chalk.dim('  /ui width <40-140>'));
                console.log(chalk.dim('  /ui markdown on|off'));
                console.log(chalk.dim('  /ui stream live|final'));
                console.log(chalk.dim('  /ui legend on|off   (takes effect on restart)'));
                console.log(chalk.dim('  /ui reset'));
                console.log('');
                return true;
            }

            if (sub === 'reset') {
                agent.resetUiConfig();
                console.log(chalk.green('✓ UI settings reset to defaults.'));
                return true;
            }

            if (sub === 'width') {
                const width = Number(parts[2]);
                if (!Number.isFinite(width)) {
                    console.log(chalk.yellow('Usage: /ui width <number>'));
                    return true;
                }
                const ui = agent.setUiMaxWidth(width);
                console.log(chalk.green(`✓ UI width set to: ${ui.maxWidth}`));
                return true;
            }

            if (sub === 'markdown') {
                if (arg !== 'on' && arg !== 'off') {
                    console.log(chalk.yellow('Usage: /ui markdown on|off'));
                    return true;
                }
                const ui = agent.setUiMarkdown(arg === 'on');
                console.log(ui.markdown ? chalk.green('✓ Markdown rendering: ON') : chalk.yellow('○ Markdown rendering: OFF'));
                return true;
            }

            if (sub === 'stream') {
                if (arg !== 'live' && arg !== 'final') {
                    console.log(chalk.yellow('Usage: /ui stream live|final'));
                    return true;
                }
                const ui = agent.setUiStreaming(arg as any);
                console.log(chalk.green(`✓ Streaming mode: ${ui.streaming.toUpperCase()}`));
                return true;
            }

            if (sub === 'legend') {
                if (arg !== 'on' && arg !== 'off') {
                    console.log(chalk.yellow('Usage: /ui legend on|off'));
                    return true;
                }
                const ui = agent.setShowLegendOnStartup(arg === 'on');
                console.log(ui.showLegendOnStartup ? chalk.green('✓ Startup legend: ON') : chalk.yellow('○ Startup legend: OFF'));
                console.log(chalk.dim('  (Takes effect next restart)'));
                return true;
            }

            console.log(chalk.yellow('Unknown /ui subcommand. Run /ui for help.'));
            return true;
        }

        case '/plan':
            const planTask = parts.slice(1).join(' ');
            if (!planTask) {
                if (agent.hasPendingPlan) {
                    const pending = agent.getPendingPlan();
                    console.log(chalk.cyan('\nPending Plan:'));
                    console.log(chalk.dim(`Task: ${pending?.task}`));
                    console.log(chalk.dim(`Use ${chalk.yellow('/run')} to execute, or ${chalk.yellow('/plan <new task>')} to create a new plan.`));
                } else {
                    console.log(chalk.yellow('Usage: /plan <task description>'));
                    console.log(chalk.dim('  Example: /plan Add input validation to the API endpoints'));
                }
            } else {
                await agent.plan(planTask);
            }
            return true;

        case '/run':
            if (agent.hasPendingPlan) {
                await agent.executePlan();
            } else {
                console.log(chalk.yellow('No pending plan to execute.'));
                console.log(chalk.dim('  Use /plan <task> to create a plan first.'));
            }
            return true;

        case '/h':
        case '/help':
            console.log(`
${chalk.bold.cyan('Available Commands:')}
  ${chalk.yellow('/model')} ${chalk.dim('[name]')}  - Show or set current model
  ${chalk.yellow('/web')}           - Toggle web search (appends :online)
  ${chalk.yellow('/safe')}          - Cycle safety: full → delete-only → off
  ${chalk.yellow('/tokens')}        - Show token usage for this session
  ${chalk.yellow('/cost')}          - Show estimated cost for this session
  ${chalk.yellow('/config')}        - Show current configuration
  ${chalk.yellow('/clear')} ${chalk.dim('(/c)')}    - Clear conversation history
  ${chalk.yellow('/cls')}           - Clear the terminal screen
  ${chalk.yellow('/refresh')}       - Refresh project structure map
  ${chalk.yellow('/map')}           - View the current project structure
  ${chalk.yellow('/debug')}         - Toggle debug mode (show API payloads)
  ${chalk.yellow('/ui')}            - UI settings (width/markdown/streaming)
  ${chalk.yellow('/plan')} ${chalk.dim('<task>')}  - Create execution plan (read-only exploration)
  ${chalk.yellow('/run')}           - Execute the pending plan
  ${chalk.yellow('/help')} ${chalk.dim('(/h)')}     - Show this help message
  ${chalk.yellow('exit')}           - Quit the agent

${chalk.bold.cyan('Planning Workflow:')}
  ${chalk.dim('1.')} /plan Add logging to all API routes
  ${chalk.dim('2.')} Review the generated plan
  ${chalk.dim('3.')} /run to execute, or /plan again for a different approach

${chalk.bold.cyan('Safety Levels:')}
  ${chalk.green('full')}        - Prompts for all file modifications
  ${chalk.yellow('delete-only')} - Only prompts for delete and execute commands
  ${chalk.red('off')}         - No prompts (use with caution!)

${chalk.bold.cyan('Tips:')}
  ${chalk.dim('•')} Press ${chalk.cyan('Tab')} to autocomplete commands
  ${chalk.dim('•')} Use ${chalk.cyan('↑/↓')} arrows to browse command history
            `);
            return true;

        default:
            return false;
    }
}

// ============================================================================
// REPL HISTORY HELPERS
// ============================================================================

function loadReplHistory(): void {
    try {
        if (fs.existsSync(HISTORY_PATH)) {
            const historyData = fs.readFileSync(HISTORY_PATH, 'utf-8');
            const lines = historyData.split('\n').filter(line => line.trim());
            // readline.history is in reverse order (newest first)
            (rl as any).history = lines.reverse().slice(0, MAX_HISTORY_LINES);
        }
    } catch (err) {
        // History load errors are non-critical - start fresh
    }
}

function saveReplHistory(): void {
    try {
        const history = (rl as any).history || [];
        // Save in chronological order (oldest first)
        const toSave = history.slice(0, MAX_HISTORY_LINES).reverse().join('\n');
        fs.writeFileSync(HISTORY_PATH, toSave);
    } catch (err) {
        // History save errors are non-critical - user can continue
    }
}

// ============================================================================
// REPL LOOP
// ============================================================================

async function startREPL() {
    // Load REPL command history from previous sessions
    loadReplHistory();

    await agent.initialize();

    const cols = getTerminalColumns();
    const ui = agent.getUiConfig();
    const contentWidth = Math.max(36, Math.min(ui.maxWidth, cols - 6));

    console.log('');
    console.log(renderBanner('🤖 OpenRouter CLI Agent v1.0', contentWidth));
    console.log('');

    const safetyColors = { 'full': chalk.green, 'delete-only': chalk.yellow, 'off': chalk.red };
    const configLines = [
        `${chalk.cyan('Model:')}     ${chalk.white(agent.model)}`,
        `${chalk.cyan('Safety:')}    ${safetyColors[agent.safetyLevel](agent.safetyLevel.toUpperCase())}`,
        `${chalk.cyan('Project:')}   ${chalk.white(agent.getProjectContext() || 'Unknown')}`,
        `${chalk.cyan('Directory:')} ${chalk.white(process.cwd())}`,
    ];
    console.log(renderBox({ title: 'Configuration', width: contentWidth, tint: chalk.dim, content: configLines }));
    console.log('');

    if (ui.showLegendOnStartup) {
        const legendLines = [
            `${chalk.cyan('🧠 Thinking')}   ${chalk.dim('- Processing your request')}`,
            `${chalk.white('│ ...')}        ${chalk.dim('- Streaming response')}`,
            `${chalk.yellow('🔧 Tool')}       ${chalk.dim('- Calling a tool/function')}`,
            `${chalk.magenta('⚡ Executing')} ${chalk.dim('- Running tool operation')}`,
            `${chalk.green('✓ Complete')}   ${chalk.dim('- Task finished successfully')}`,
        ];
        console.log(renderBox({ title: 'Status Indicators', width: contentWidth, tint: chalk.dim, content: legendLines }));
        console.log('');
    }

    console.log(chalk.dim('Type') + chalk.yellow(' /help ') + chalk.dim('for commands,') + chalk.yellow(' exit ') + chalk.dim('to quit. Press') + chalk.cyan(' Tab ') + chalk.dim('for autocomplete.'));
    console.log(chalk.dim(`UI: ${chalk.yellow('/ui')} to adjust width/streaming/markdown`));
    console.log('');

    const promptUser = () => {
        rl.question(chalk.cyan('↩︎ '), async (input) => {
            const trimmed = input.trim();

            if (trimmed.toLowerCase() === 'exit') {
                await gracefulShutdown();
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

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

async function gracefulShutdown() {
    console.log(chalk.cyan('\n👋 Saving and exiting...'));
    await agent.saveHistory();
    saveReplHistory();
    rl.close();
    process.exit(0);
}

// Handle Ctrl+C gracefully
process.on('SIGINT', async () => {
    await gracefulShutdown();
});

// Handle readline close (for clean exit)
rl.on('close', () => {
    saveReplHistory();
});

startREPL();

