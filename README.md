# 🤖 OpenRouter CLI Agent

A powerful, multi-tool AI coding assistant that runs in your terminal. Built with TypeScript and powered by [OpenRouter](https://openrouter.ai), giving you access to Claude, GPT-4, Mistral, and 100+ other models.

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

## ✨ Features

- **🔌 OpenRouter Integration** — Access any LLM via a single API
- **🔧 15 Built-in Tools** — File operations, code editing, search, and command execution
- **🔄 Multi-step Reasoning** — Agent autonomously chains tools to complete tasks (up to 15 steps, with option to continue)
- **🛡️ Safety Confirmations** — Prompts for user approval before dangerous operations (writes, deletes, commands)
- **🌐 Web Search** — Toggle real-time web access with `/web`
- **💾 Persistent History** — Conversations saved across sessions
- **⌨️ Tab Completion** — Press Tab to autocomplete commands
- **📜 REPL History** — Arrow up/down to recall previous prompts (persisted across sessions)
- **🔁 Auto-retry** — Exponential backoff for API errors
- **📁 Project Detection** — Auto-detects Node.js, Python, Rust, Go, and more
- **🗺️ Project Map** — Generates and caches a tree view of your project structure
- **💿 Automatic Backups** — Creates `.bak` files before edits
- **📊 Colour-coded Diffs** — Green for additions, red for deletions
- **🎨 Syntax Highlighting** — Code blocks in responses are syntax highlighted
- **💰 Token Usage Display** — Shows token count after each request
- **📏 Context Management** — Automatic token estimation and history trimming
- **🐛 Debug Mode** — Toggle with `/debug` to see API payloads and hidden errors
- **⚡ Graceful Shutdown** — Ctrl+C saves history and exits cleanly
- **🧪 Unit Tests** — 58+ tests covering security validators and core logic (Vitest)
- **📋 Planning Mode** — Use `/plan` to explore codebase (read-only) and create execution plans before running

---

## 🛠️ Available Tools

| Category | Tool | Description |
|----------|------|-------------|
| **File Ops** | `read_file` | Read content (supports line ranges, optional line numbers) |
| | `read_file_with_lines` | Read with line numbers always shown (use before editing) |
| | `write_file` | Create/update files (auto-creates dirs, creates backup) |
| | `delete_file` | Delete files or directories |
| | `move_file` | Move or rename files |
| | `get_file_info` | Get metadata (size, lines, dates) |
| **Editing** | `edit_file_by_lines` | Replace line range with new content (RECOMMENDED - safest) |
| | `edit_file` | Find-and-replace with diff output |
| | `multi_edit_file` | Batch find-and-replace edits in one operation |
| | `insert_at_line` | Insert content at specific line |
| **Search** | `list_directory` | List files (recursive, show sizes) |
| | `find_files` | Find by glob pattern (`*.ts`, `test*`) |
| | `search_files` | Search text (regex, filter by extension) |
| | `get_current_directory` | Get working directory |
| **System** | `execute_command` | Run shell commands (cwd, timeout, real-time output) |

---

## 📦 Installation

### Prerequisites

- **Node.js** v18 or higher
- **OpenRouter API Key** — Get one at [openrouter.ai/keys](https://openrouter.ai/keys)

### Global Install (Recommended)

Install once and use from any project directory:

```bash
git clone https://github.com/YOUR_USERNAME/openrouter-agent.git
cd openrouter-agent
npm install
npm link
```

Now run from **anywhere**:

```bash
ora                 # Short alias
openrouter-agent    # Full command
```

### Local Development

```bash
npm install
npm start
```

### Running Tests

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
```

---

## ⚙️ Configuration

Create a `.env` file in the project root:

```env
OPENROUTER_API_KEY=sk-or-v1-your-key-here
OPENROUTER_MODEL=mistralai/devstral-2512:free
```

**Popular models:**
- `anthropic/claude-3.5-sonnet` — Best for coding
- `openai/gpt-4o` — Fast and capable
- `mistralai/devstral-2512:free` — Free tier

---

## 🚀 Usage

```bash
ora
```

```
╔══════════════════════════════════════════════════════════╗
║         🤖 OpenRouter CLI Agent v1.0                    ║
╚══════════════════════════════════════════════════════════╝

┌─ Configuration ─────────────────────────────────────────┐
│ Model:     mistralai/devstral-2512:free                │
│ Safety:    FULL                                         │
│ Project:   Node.js/JavaScript, TypeScript              │
│ Directory: C:\Users\lucas\my-project                   │
└─────────────────────────────────────────────────────────┘

┌─ Status Indicators ─────────────────────────────────────┐
│ 🧠 Thinking   - Processing your request                │
│ │ ...        - Streaming response text                  │
│ 🔧 Tool       - Calling a tool/function                 │
│ ⚡ Executing  - Running tool operation                  │
│ ✓ Complete   - Task finished successfully               │
└─────────────────────────────────────────────────────────┘

Type /help for commands, exit to quit. Press Tab for autocomplete.

↩︎ 
```

### Commands

| Command | Alias | Description |
|---------|-------|-------------|
| `/model [name]` | | Show or change model |
| `/web` | | Toggle web search (:online suffix) |
| `/safe` | | Cycle safety level: full → delete-only → off |
| `/tokens` | | Show token usage |
| `/cost` | | Show estimated cost for session |
| `/config` | | Show current configuration |
| `/clear` | `/c` | Clear conversation history |
| `/cls` | | Clear the terminal screen |
| `/refresh` | | Refresh project structure map (bypasses cache) |
| `/map` | | View the current project structure |
| `/debug` | | Toggle debug mode (show API payloads) |
| `/plan <task>` | | Create execution plan with read-only exploration |
| `/run` | | Execute the pending plan |
| `/help` | `/h` | Show help |
| `exit` | | Quit |

### Planning Mode

The `/plan` command enables a two-phase workflow for complex tasks:

1. **Planning Phase** — The agent explores the codebase using read-only tools (read_file, search_files, list_directory, etc.) to understand the structure
2. **Review Phase** — A detailed execution plan is generated and shown to you
3. **Execution Phase** — Use `/run` to execute the approved plan with full tool access

```bash
# Example workflow
↩︎ /plan Add input validation to all API endpoints

🗺️ Planning Mode (read-only exploration)
───────────────────────────────────────
🧠 Analyzing...

🔧 read_file_with_lines → src/routes/api.ts
🔧 search_files → "router.post" in src/
🔧 read_file → src/middleware/validate.ts

📋 EXECUTION PLAN
━━━━━━━━━━━━━━━━━
Task: Add input validation to API endpoints

Steps:
1. Create validation schemas in src/schemas/api.ts
2. Add Zod validation to POST /users endpoint (line 45-60)
3. Add Zod validation to POST /orders endpoint (line 82-95)
4. Update error handling middleware

Files to modify:
- src/routes/api.ts
- src/middleware/error.ts

Files to create:
- src/schemas/api.ts

Estimated tool calls: 5

✓ Plan created!
  Type /run to execute this plan

↩︎ /run

⚡ Executing Plan
───────────────────────────────────────
# Agent now executes the plan with full tool access
```

### Safety Levels

The agent prompts for user confirmation before executing potentially dangerous operations:

| Level | Description |
|-------|-------------|
| **full** (default) | Prompts for all file modifications (write, edit, delete, move, execute) |
| **delete-only** | Only prompts for delete and execute commands |
| **off** | No prompts (use with extreme caution!) |


Toggle with `/safe` command.

### Tips

- Press **Tab** to autocomplete commands
- Use **↑/↓** arrows to browse command history
- Press **Ctrl+C** for graceful shutdown (saves all history)
- When the agent reaches 15 steps, it asks if you want to continue

### Example Session

```
↩︎ Create a Python script that fetches weather data and save it to weather.py

┌─ 🔧 write_file ───────────────────────────────────────┐
  path: "weather.py"
  size: 342 characters
└───────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────┐
│  ⚠️   DANGEROUS OPERATION - Confirmation Required          │
├────────────────────────────────────────────────────────────┤
│  Operation: 📝 CREATE/OVERWRITE FILE                       │
│  Target:    weather.py                                     │
│  Details:   342 characters                                 │
└────────────────────────────────────────────────────────────┘
Allow? (y/yes to confirm): y
✓ Approved

┌─ 📋 Result ───────────────────────────────────────────┐
Successfully wrote to weather.py
└───────────────────────────────────────────────────────┘

📊 Tokens: 1,234 in / 567 out
✓ Complete (2s | 1 tool used)

↩︎ Edit weather.py to add error handling

┌─ 🔧 edit_file_by_lines ───────────────────────────────┐
  path: "weather.py"
  lines: 5-8
  size: 156 chars
└───────────────────────────────────────────────────────┘

┌─ 📋 Result ───────────────────────────────────────────┐
Edited weather.py
Replaced lines 5-8 (4 lines) with 7 lines (+3 net)

Diff:
-response = requests.get(url)
+try:
+    response = requests.get(url)
+    response.raise_for_status()
+except Exception as e:
+    print(f'Error: {e}')
+    sys.exit(1)
└───────────────────────────────────────────────────────┘
```

---

## 📁 Project Structure

```
openrouter-agent/
├── bin/
│   └── cli.js            # CLI entry point (for npm link)
├── src/
│   ├── index.ts          # REPL loop and command handlers
│   ├── Agent.ts          # Core agent class (API calls, tool dispatch, safety)
│   ├── Agent.test.ts     # Agent unit tests
│   ├── tools.ts          # Tool implementations and schemas (Zod validation)
│   └── tools.test.ts     # Tool validation unit tests
├── dist/                 # Compiled JavaScript (generated)
├── .env                  # Your API key (gitignored)
├── .env.example          # Example config
├── .agent_history.json   # Conversation history (gitignored)
├── .ora_history          # REPL command history (gitignored)
├── package.json
├── tsconfig.json
├── vitest.config.ts      # Test configuration
└── README.md
```

---

## 🏗️ Architecture

The agent is built with a clean separation of concerns:

- **`Agent` class** (`Agent.ts`) — Manages conversation history, API calls, streaming, tool dispatch, and safety confirmations
- **Tools** (`tools.ts`) — Pure functions for file operations, editing, search, and command execution with Zod schema validation
- **REPL** (`index.ts`) — Thin entry point handling user input, commands, and the main loop

Key features:
- **Streaming responses** — See output as it's generated
- **Zod validation** — All tool arguments are validated before execution
- **Automatic context management** — History is trimmed to stay under token limits
- **Project map caching** — 5-minute TTL to avoid regenerating on every request
- **Defensive error handling** — Tool execution wrapped in try/catch to prevent crashes
- **Debug mode logging** — Hidden errors are revealed when debug mode is enabled

---

## 🤝 Contributing

Contributions are welcome! Feel free to open issues or submit PRs.

---

## 📄 License

ISC License — see [LICENSE](LICENSE) for details.
