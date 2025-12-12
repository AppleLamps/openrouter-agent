# Refactor: Split `tools.ts` into a modular `tools/` directory

## Overview

The current `src/tools.ts` file is ~1400 lines and handles multiple responsibilities. This refactor will split it into a well-organized `tools/` directory for better maintainability.

---

## Prompt for LLM (Cursor/Copilot)

````text
Refactor src/tools.ts into a modular tools/ directory structure. The current file is ~1400 lines and handles schemas, validation, security, file operations, edit operations, command execution, directory operations, project detection, and planning-mode/read-only tool exports.

### Target Structure

Create the following files:

src/tools/
├── index.ts           # Re-exports everything (public API)
├── schemas.ts         # All Zod schemas (ReadFileSchema, WriteFileSchema, etc.)
├── validation.ts      # validateToolArgs function and toolSchemas map
├── security.ts        # validatePath, validateCommand, SENSITIVE_FILE_PATTERNS, DANGEROUS_COMMAND_PATTERNS
├── utils.ts           # checkFileSize, createDiff, createBackup, MAX_FILE_SIZE, MAX_OUTPUT_LENGTH
├── file-operations.ts # readFile, readFileWithLines, writeFile, deleteFile, moveFile, getFileInfo
├── edit-operations.ts # editFile, editFileByLines, multiEditFile, insertAtLine, EditOperation interface
├── directory-ops.ts   # listDirectory, findFiles, searchFiles, getCurrentDirectory
├── command.ts         # executeCommand function
├── project.ts         # detectProjectType, generateProjectMap, loadGitignorePatterns, shouldIgnore
├── planning.ts        # READ_ONLY_TOOL_NAMES and readOnlyTools
└── definitions.ts     # tools array (OpenAI function definitions) and availableTools map

### Requirements

1. **Preserve all exports** - The current public API must remain unchanged:
   - `tools` (array of OpenAI tool definitions)
   - `availableTools` (Record<string, Function>)
   - `detectProjectType`
   - `validateToolArgs`
   - `generateProjectMap`
   - `readOnlyTools`
   - `READ_ONLY_TOOL_NAMES`

2. **index.ts should re-export everything**:
   ```typescript
   export { tools, availableTools } from './definitions';
   export { validateToolArgs } from './validation';
   export { detectProjectType, generateProjectMap } from './project';
   export { readOnlyTools, READ_ONLY_TOOL_NAMES } from './planning';
   // Export schemas if needed elsewhere
   export * from './schemas';
   ```

3. **Import structure** - Each file should import only what it needs:
   - `file-operations.ts` imports from `security.ts`, `utils.ts`
   - `edit-operations.ts` imports from `security.ts`, `utils.ts`
   - `command.ts` imports from `security.ts`, `utils.ts`
   - `definitions.ts` imports all operation functions to build `availableTools`
   - `validation.ts` imports all schemas from `schemas.ts`

4. **No functionality changes** - This is a pure refactor. All functions must behave identically.

5. **Update src/Agent.ts import** to use the new path:

   ```typescript
   // Before
   import { tools, availableTools, detectProjectType, validateToolArgs, generateProjectMap, readOnlyTools, READ_ONLY_TOOL_NAMES } from './tools';
   
   // After (should work the same due to index.ts)
   import { tools, availableTools, detectProjectType, validateToolArgs, generateProjectMap, readOnlyTools, READ_ONLY_TOOL_NAMES } from './tools';
   ```

### File Content Guide

**schemas.ts** (~120 lines)

- All `z.object()` schema definitions
- Export each schema individually

Note: includes `TaskCompleteSchema`.

**validation.ts** (~30 lines)

- Import all schemas
- Export `toolSchemas` record
- Export `validateToolArgs` function

**security.ts** (~80 lines)

- `SENSITIVE_FILE_PATTERNS` array
- `DANGEROUS_COMMAND_PATTERNS` array
- `validatePath` function
- `validateCommand` function

**utils.ts** (~60 lines)

- `MAX_FILE_SIZE` constant
- `MAX_OUTPUT_LENGTH` constant
- `checkFileSize` function
- `createDiff` function (uses 'diff' package)
- `createBackup` function

**file-operations.ts** (~150 lines)

- `readFile`
- `readFileWithLines`
- `writeFile`
- `deleteFile`
- `moveFile`
- `getFileInfo`

**edit-operations.ts** (~150 lines)

- `EditOperation` interface
- `editFile`
- `editFileByLines`
- `multiEditFile`
- `insertAtLine`

**directory-ops.ts** (~100 lines)

- `listDirectory`
- `findFiles`
- `searchFiles`
- `getCurrentDirectory`

**command.ts** (~60 lines)

- `executeCommand` function

**project.ts** (~120 lines)

- `loadGitignorePatterns`
- `shouldIgnore`
- `generateProjectMap`
- `detectProjectType`

**definitions.ts** (~200 lines)

- `tools` array (OpenAI function definitions)
- `availableTools` map (imports all operation functions)

Note: includes the `task_complete` tool definition.

### Verification

After refactoring:

1. Run `npm run build` - should compile with no errors
2. Run the agent with `npm run dev` - should work identically
3. All tool calls should execute correctly

Do NOT delete src/tools.ts until the new structure is verified working.

````

---

## Manual Checklist

- [ ] Create `src/tools/` directory
- [ ] Create all 12 files listed above
- [ ] Verify `npm run build` passes
- [ ] Test agent functionality with `npm run dev`
- [ ] Delete old `src/tools.ts` after verification
- [ ] Update any other imports if needed

## Notes

- The `diff` package import stays in `utils.ts`
- The `zod` import stays in `schemas.ts`
- Node.js imports (`fs`, `path`, `child_process`, `readline`) go in the files that need them
- Keep `existsSync` and `statSync` imports where used (avoid async alternatives for simple checks)
