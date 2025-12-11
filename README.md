# 🤖 OpenRouter CLI Agent

A powerful, multi-tool AI coding assistant that runs in your terminal. Built with TypeScript and powered by [OpenRouter](https://openrouter.ai), giving you access to Claude, GPT-4, Mistral, and 100+ other models.

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

## ✨ Features

- **🔌 OpenRouter Integration** — Access any LLM via a single API
- **🔧 13 Built-in Tools** — File operations, code editing, search, and command execution
- **🔄 Multi-step Reasoning** — Agent autonomously chains tools to complete tasks
- **🌐 Web Search** — Toggle real-time web access with `/web`
- **💾 Persistent History** — Conversations saved across sessions
- **⌨️ Tab Completion** — Press Tab to autocomplete commands
- **📜 REPL History** — Arrow up/down to recall previous prompts (persisted across sessions)
- **🔁 Auto-retry** — Exponential backoff for API errors
- **📁 Project Detection** — Auto-detects Node.js, Python, Rust, Go, and more
- **💿 Automatic Backups** — Creates `.bak` files before edits
- **📊 Colour-coded Diffs** — Green for additions, red for deletions
- **💰 Token Usage Display** — Shows token count after each request
- **🐛 Debug Mode** — Toggle with `/debug` to see API payloads
- **⚡ Graceful Shutdown** — Ctrl+C saves history and exits cleanly

---

## 🛠️ Available Tools

| Category | Tool | Description |
|----------|------|-------------|
| **File Ops** | `read_file` | Read content (supports line ranges) |
| | `write_file` | Create/update files (auto-creates dirs) |
| | `delete_file` | Delete files or directories |
| | `move_file` | Move or rename files |
| | `get_file_info` | Get metadata (size, lines, dates) |
| **Editing** | `edit_file` | Find-and-replace with diff output |
| | `multi_edit_file` | Batch edits in one operation |
| | `insert_at_line` | Insert content at specific line |
| **Search** | `list_directory` | List files (recursive, show sizes) |
| | `find_files` | Find by glob pattern (`*.ts`) |
| | `search_files` | Search text (regex, filter by ext) |
| | `get_current_directory` | Get working directory |
| **System** | `execute_command` | Run shell commands (cwd, timeout) |

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
| `/refresh` | | Refresh project structure map |
| `/map` | | View the current project structure |
| `/debug` | | Toggle debug mode (show API payloads) |
| `/help` | `/h` | Show help |
| `exit` | | Quit |

### Tips

- Press **Tab** to autocomplete commands
- Use **↑/↓** arrows to browse command history
- Press **Ctrl+C** for graceful shutdown (saves all history)

### Example Session

```
↩︎ Create a Python script that fetches weather data and save it to weather.py

🔧 write_file
  path: "weather.py"
  size: 342 characters

📋 Result
Successfully wrote to weather.py

📊 Tokens: 1,234 in / 567 out
✓ Complete (2s | 1 tool used)

↩︎ Edit weather.py to add error handling

🔧 edit_file
  path: "weather.py"  
  find: "response = requests.get(url)..."

📋 Result
Edited weather.py: replaced 1 occurrence(s)

-response = requests.get(url)
+try:
+    response = requests.get(url)
+except Exception as e:
+    print(f'Error: {e}')
```

---

## 📁 Project Structure

```
openrouter-agent/
├── bin/
│   └── cli.js          # CLI entry point
├── src/
│   ├── index.ts        # Main agent logic
│   └── tools.ts        # Tool definitions
├── .env                # Your API key (gitignored)
├── .env.example        # Example config
├── package.json
├── tsconfig.json
└── README.md
```

---

## 🤝 Contributing

Contributions are welcome! Feel free to open issues or submit PRs.

---

## 📄 License

ISC License — see [LICENSE](LICENSE) for details.
