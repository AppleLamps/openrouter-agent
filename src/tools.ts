import fs from 'fs/promises';
import { spawn } from 'child_process';
import path from 'path';
import { createReadStream, statSync, existsSync } from 'fs';
import readline from 'readline';
import { z } from 'zod';
import * as Diff from 'diff';

// ============================================================================
// ZOD SCHEMAS FOR TOOL VALIDATION
// ============================================================================

export const ReadFileSchema = z.object({
    path: z.string().min(1, 'Path is required'),
    start_line: z.number().int().positive().optional(),
    end_line: z.number().int().positive().optional(),
});

export const WriteFileSchema = z.object({
    path: z.string().min(1, 'Path is required'),
    content: z.string(),
});

export const DeleteFileSchema = z.object({
    path: z.string().min(1, 'Path is required'),
    recursive: z.boolean().optional().default(false),
});

export const MoveFileSchema = z.object({
    source: z.string().min(1, 'Source path is required'),
    destination: z.string().min(1, 'Destination path is required'),
});

export const GetFileInfoSchema = z.object({
    path: z.string().min(1, 'Path is required'),
});

export const EditFileSchema = z.object({
    path: z.string().min(1, 'Path is required'),
    old_text: z.string().min(1, 'old_text is required'),
    new_text: z.string(),
    replace_all: z.boolean().optional().default(false),
});

export const EditOperationSchema = z.object({
    old_text: z.string().min(1, 'old_text is required'),
    new_text: z.string(),
});

export const MultiEditFileSchema = z.object({
    path: z.string().min(1, 'Path is required'),
    edits: z.array(EditOperationSchema).min(1, 'At least one edit is required'),
});

export const InsertAtLineSchema = z.object({
    path: z.string().min(1, 'Path is required'),
    line_number: z.number().int().positive('Line number must be a positive integer'),
    content: z.string(),
    position: z.enum(['before', 'after']).optional().default('after'),
});

export const ExecuteCommandSchema = z.object({
    command: z.string().min(1, 'Command is required'),
    cwd: z.string().optional(),
    timeout: z.number().int().positive().optional().default(60000),
});

export const ListDirectorySchema = z.object({
    directory: z.string().min(1, 'Directory is required'),
    recursive: z.boolean().optional().default(false),
    show_size: z.boolean().optional().default(false),
});

export const FindFilesSchema = z.object({
    pattern: z.string().min(1, 'Pattern is required'),
    directory: z.string().min(1, 'Directory is required'),
    max_results: z.number().int().positive().optional().default(50),
});

export const SearchFilesSchema = z.object({
    pattern: z.string().min(1, 'Pattern is required'),
    directory: z.string().min(1, 'Directory is required'),
    regex: z.boolean().optional().default(false),
    extensions: z.array(z.string()).optional(),
});

export const GetCurrentDirectorySchema = z.object({});

// Schema map for validation
export const toolSchemas: Record<string, z.ZodSchema> = {
    read_file: ReadFileSchema,
    write_file: WriteFileSchema,
    delete_file: DeleteFileSchema,
    move_file: MoveFileSchema,
    get_file_info: GetFileInfoSchema,
    edit_file: EditFileSchema,
    multi_edit_file: MultiEditFileSchema,
    insert_at_line: InsertAtLineSchema,
    execute_command: ExecuteCommandSchema,
    list_directory: ListDirectorySchema,
    find_files: FindFilesSchema,
    search_files: SearchFilesSchema,
    get_current_directory: GetCurrentDirectorySchema,
};

// Validation helper that returns either validated args or an error string
export function validateToolArgs(toolName: string, args: unknown): { success: true; data: any } | { success: false; error: string } {
    const schema = toolSchemas[toolName];
    if (!schema) {
        return { success: false, error: `Unknown tool: ${toolName}` };
    }

    const result = schema.safeParse(args);
    if (result.success) {
        return { success: true, data: result.data };
    } else {
        const issues = result.error.issues;
        const errorMessages = issues.map((issue) => `${String(issue.path.join('.') || 'root')}: ${issue.message}`);
        return { success: false, error: `Validation failed for ${toolName}: ${errorMessages.join(', ')}` };
    }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function createDiff(oldContent: string, newContent: string, filePath: string): string {
    // Use the diff library for robust unified diff output
    const patch = Diff.createTwoFilesPatch(
        filePath,
        filePath,
        oldContent,
        newContent,
        'original',
        'modified',
        { context: 3 }
    );

    // Check if there are actual changes
    if (oldContent === newContent) {
        return 'No changes';
    }

    // Truncate if too long (keep first 50 lines of diff)
    const lines = patch.split('\n');
    if (lines.length > 50) {
        return lines.slice(0, 50).join('\n') + `\n... (${lines.length - 50} more lines truncated)`;
    }

    return patch;
}

async function createBackup(filePath: string): Promise<string | null> {
    try {
        if (existsSync(filePath)) {
            const backupPath = `${filePath}.bak`;
            await fs.copyFile(filePath, backupPath);
            return backupPath;
        }
    } catch { }
    return null;
}

// ============================================================================
// FILE OPERATIONS
// ============================================================================

async function readFile({ path: filePath, start_line, end_line }: { path: string; start_line?: number; end_line?: number }) {
    try {
        if (start_line !== undefined || end_line !== undefined) {
            // Read specific lines
            const fileStream = createReadStream(filePath);
            const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

            const lines: string[] = [];
            let lineNum = 0;
            const start = start_line || 1;
            const end = end_line || Infinity;

            for await (const line of rl) {
                lineNum++;
                if (lineNum >= start && lineNum <= end) {
                    lines.push(`${lineNum}: ${line}`);
                }
                if (lineNum > end) break;
            }

            return lines.join('\n') || 'No lines in specified range';
        }

        const content = await fs.readFile(filePath, 'utf-8');
        return content;
    } catch (error: any) {
        return `Error reading file: ${error.message}`;
    }
}

async function writeFile({ path: filePath, content }: { path: string; content: string }) {
    try {
        await createBackup(filePath);
        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(filePath, content, 'utf-8');
        return `Successfully wrote to ${filePath}`;
    } catch (error: any) {
        return `Error writing file: ${error.message}`;
    }
}

async function deleteFile({ path: filePath, recursive = false }: { path: string; recursive?: boolean }) {
    try {
        const stat = await fs.stat(filePath);
        if (stat.isDirectory()) {
            await fs.rm(filePath, { recursive });
            return `Successfully deleted directory: ${filePath}`;
        } else {
            await fs.unlink(filePath);
            return `Successfully deleted file: ${filePath}`;
        }
    } catch (error: any) {
        return `Error deleting: ${error.message}`;
    }
}

async function moveFile({ source, destination }: { source: string; destination: string }) {
    try {
        const destDir = path.dirname(destination);
        await fs.mkdir(destDir, { recursive: true });
        await fs.rename(source, destination);
        return `Successfully moved ${source} to ${destination}`;
    } catch (error: any) {
        return `Error moving file: ${error.message}`;
    }
}

async function getFileInfo({ path: filePath }: { path: string }) {
    try {
        const stat = await fs.stat(filePath);
        const content = stat.isFile() ? await fs.readFile(filePath, 'utf-8') : null;
        const lineCount = content ? content.split('\n').length : 0;

        return JSON.stringify({
            path: filePath,
            type: stat.isDirectory() ? 'directory' : 'file',
            size: stat.size,
            sizeHuman: stat.size > 1024 ? `${(stat.size / 1024).toFixed(1)}KB` : `${stat.size}B`,
            lineCount: stat.isFile() ? lineCount : undefined,
            modified: stat.mtime.toISOString(),
            created: stat.birthtime.toISOString(),
        }, null, 2);
    } catch (error: any) {
        return `Error getting file info: ${error.message}`;
    }
}

// ============================================================================
// EDIT OPERATIONS
// ============================================================================

async function editFile({ path: filePath, old_text, new_text, replace_all = false }: { path: string; old_text: string; new_text: string; replace_all?: boolean }) {
    try {
        const content = await fs.readFile(filePath, 'utf-8');

        if (!content.includes(old_text)) {
            return `Error: The specified old_text was not found in ${filePath}`;
        }

        await createBackup(filePath);

        const occurrences = content.split(old_text).length - 1;
        let newContent: string;

        if (replace_all) {
            newContent = content.split(old_text).join(new_text);
        } else {
            newContent = content.replace(old_text, new_text);
        }

        await fs.writeFile(filePath, newContent, 'utf-8');

        const diff = createDiff(content, newContent, filePath);
        const replacedCount = replace_all ? occurrences : 1;
        return `Edited ${filePath}: replaced ${replacedCount} occurrence(s)\n\nDiff:\n${diff}`;
    } catch (error: any) {
        return `Error editing file: ${error.message}`;
    }
}

interface EditOperation {
    old_text: string;
    new_text: string;
}

async function multiEditFile({ path: filePath, edits }: { path: string; edits: EditOperation[] }) {
    try {
        const originalContent = await fs.readFile(filePath, 'utf-8');
        await createBackup(filePath);

        let content = originalContent;
        const results: string[] = [];

        for (let i = 0; i < edits.length; i++) {
            const { old_text, new_text } = edits[i];

            if (!content.includes(old_text)) {
                results.push(`Edit ${i + 1}: NOT FOUND - "${old_text.slice(0, 30)}..."`);
                continue;
            }

            content = content.replace(old_text, new_text);
            results.push(`Edit ${i + 1}: OK`);
        }

        await fs.writeFile(filePath, content, 'utf-8');

        const diff = createDiff(originalContent, content, filePath);
        return `Edited ${filePath}:\n${results.join('\n')}\n\nDiff:\n${diff}`;
    } catch (error: any) {
        return `Error editing file: ${error.message}`;
    }
}

async function insertAtLine({ path: filePath, line_number, content: insertContent, position = 'after' }: { path: string; line_number: number; content: string; position?: 'before' | 'after' }) {
    try {
        const originalContent = await fs.readFile(filePath, 'utf-8');
        await createBackup(filePath);

        const lines = originalContent.split('\n');
        const insertIndex = position === 'before' ? line_number - 1 : line_number;

        if (insertIndex < 0 || insertIndex > lines.length) {
            return `Error: Line ${line_number} is out of range (file has ${lines.length} lines)`;
        }

        lines.splice(insertIndex, 0, insertContent);
        const newContent = lines.join('\n');

        await fs.writeFile(filePath, newContent, 'utf-8');

        return `Inserted content ${position} line ${line_number} in ${filePath}`;
    } catch (error: any) {
        return `Error inserting at line: ${error.message}`;
    }
}

// ============================================================================
// COMMAND EXECUTION
// ============================================================================

async function executeCommand({ command, cwd, timeout = 60000 }: { command: string; cwd?: string; timeout?: number }): Promise<string> {
    return new Promise((resolve) => {
        console.log('\n[Command Output]');
        const child = spawn(command, {
            shell: true,
            cwd: cwd || process.cwd(),
        });
        let output = '';
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
            resolve(`Command timed out after ${timeout}ms\nPartial output:\n${output}`);
        }, timeout);

        child.stdout.on('data', (data: Buffer) => {
            const text = data.toString();
            process.stdout.write(text);
            output += text;
        });

        child.stderr.on('data', (data: Buffer) => {
            const text = data.toString();
            process.stderr.write(text);
            output += `[stderr] ${text}`;
        });

        child.on('close', (code) => {
            clearTimeout(timer);
            if (!timedOut) {
                console.log(`\n[Exit Code: ${code}]`);
                resolve(output || `Command completed with exit code ${code}`);
            }
        });

        child.on('error', (err) => {
            clearTimeout(timer);
            resolve(`Error executing command: ${err.message}`);
        });
    });
}

// ============================================================================
// DIRECTORY OPERATIONS
// ============================================================================

async function listDirectory({ directory, recursive = false, show_size = false }: { directory: string; recursive?: boolean; show_size?: boolean }) {
    try {
        const results: string[] = [];

        async function listDir(dir: string, indent: string = '') {
            const entries = await fs.readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
                if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

                const fullPath = path.join(dir, entry.name);
                let info = `${indent}${entry.isDirectory() ? '📁' : '📄'} ${entry.name}`;

                if (show_size && !entry.isDirectory()) {
                    try {
                        const stat = await fs.stat(fullPath);
                        info += ` (${stat.size > 1024 ? `${(stat.size / 1024).toFixed(1)}KB` : `${stat.size}B`})`;
                    } catch { }
                }

                results.push(info);

                if (recursive && entry.isDirectory()) {
                    await listDir(fullPath, indent + '  ');
                }
            }
        }

        await listDir(directory);
        return results.join('\n') || 'Empty directory';
    } catch (error: any) {
        return `Error listing directory: ${error.message}`;
    }
}

async function findFiles({ pattern, directory, max_results = 50 }: { pattern: string; directory: string; max_results?: number }) {
    try {
        const results: string[] = [];
        const regex = new RegExp(pattern.replace(/\*/g, '.*').replace(/\?/g, '.'), 'i');

        async function searchDir(dir: string) {
            if (results.length >= max_results) return;

            const entries = await fs.readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
                if (results.length >= max_results) return;
                if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

                const fullPath = path.join(dir, entry.name);

                if (regex.test(entry.name)) {
                    results.push(fullPath);
                }

                if (entry.isDirectory()) {
                    await searchDir(fullPath);
                }
            }
        }

        await searchDir(directory);
        return results.join('\n') || 'No files found matching pattern';
    } catch (error: any) {
        return `Error finding files: ${error.message}`;
    }
}

async function searchFiles({ pattern, directory, regex = false, extensions }: { pattern: string; directory: string; regex?: boolean; extensions?: string[] }) {
    try {
        const results: string[] = [];
        const searchRegex = regex ? new RegExp(pattern, 'gi') : null;

        async function searchDir(dir: string) {
            if (results.length >= 50) return;

            const entries = await fs.readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
                if (results.length >= 50) return;

                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                    await searchDir(fullPath);
                } else if (entry.isFile()) {
                    // Check extension filter
                    if (extensions && extensions.length > 0) {
                        const ext = path.extname(entry.name).slice(1);
                        if (!extensions.includes(ext)) continue;
                    }

                    try {
                        const content = await fs.readFile(fullPath, 'utf-8');
                        const lines = content.split('\n');

                        lines.forEach((line, index) => {
                            if (results.length >= 50) return;

                            const matches = regex
                                ? searchRegex!.test(line)
                                : line.toLowerCase().includes(pattern.toLowerCase());

                            if (matches) {
                                results.push(`${fullPath}:${index + 1}: ${line.trim().slice(0, 100)}`);
                            }
                        });
                    } catch {
                        // Skip binary or unreadable files
                    }
                }
            }
        }

        await searchDir(directory);
        return results.join('\n') || 'No matches found';
    } catch (error: any) {
        return `Error searching files: ${error.message}`;
    }
}

function getCurrentDirectory() {
    return process.cwd();
}

// ============================================================================
// PROJECT DETECTION
// ============================================================================

export async function detectProjectType(): Promise<string> {
    const checks = [
        { file: 'package.json', type: 'Node.js/JavaScript' },
        { file: 'tsconfig.json', type: 'TypeScript' },
        { file: 'pyproject.toml', type: 'Python (pyproject)' },
        { file: 'requirements.txt', type: 'Python' },
        { file: 'Cargo.toml', type: 'Rust' },
        { file: 'go.mod', type: 'Go' },
        { file: 'pom.xml', type: 'Java (Maven)' },
        { file: 'build.gradle', type: 'Java (Gradle)' },
        { file: 'Gemfile', type: 'Ruby' },
        { file: 'composer.json', type: 'PHP' },
    ];

    const detected: string[] = [];

    for (const check of checks) {
        if (existsSync(path.join(process.cwd(), check.file))) {
            detected.push(check.type);
        }
    }

    return detected.length > 0 ? detected.join(', ') : 'Unknown';
}

// ============================================================================
// TOOL DEFINITIONS (OpenAI Schema)
// ============================================================================

export const tools = [
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read file content. Optionally read specific line range for large files.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'The path to the file to read.' },
                    start_line: { type: 'number', description: 'Optional: Start reading from this line (1-indexed).' },
                    end_line: { type: 'number', description: 'Optional: Stop reading at this line (inclusive).' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'write_file',
            description: 'Write content to a file. Creates directories if needed. Creates backup before overwriting.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'The path to the file to write.' },
                    content: { type: 'string', description: 'The content to write to the file.' },
                },
                required: ['path', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'delete_file',
            description: 'Delete a file or directory.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'The path to delete.' },
                    recursive: { type: 'boolean', description: 'If true, delete directories recursively. Default: false.' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'move_file',
            description: 'Move or rename a file or directory.',
            parameters: {
                type: 'object',
                properties: {
                    source: { type: 'string', description: 'The source path.' },
                    destination: { type: 'string', description: 'The destination path.' },
                },
                required: ['source', 'destination'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_file_info',
            description: 'Get detailed information about a file (size, line count, modified date, etc.).',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'The path to the file.' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'edit_file',
            description: 'Edit a file by replacing specific text. Creates backup before editing. Shows diff after.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'The path to the file to edit.' },
                    old_text: { type: 'string', description: 'The exact text to find and replace.' },
                    new_text: { type: 'string', description: 'The replacement text.' },
                    replace_all: { type: 'boolean', description: 'If true, replace all occurrences. Default: false.' },
                },
                required: ['path', 'old_text', 'new_text'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'multi_edit_file',
            description: 'Apply multiple find-and-replace edits to a file in one operation. Creates backup. Shows diff.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'The path to the file to edit.' },
                    edits: {
                        type: 'array',
                        description: 'Array of edit operations to apply in order.',
                        items: {
                            type: 'object',
                            properties: {
                                old_text: { type: 'string', description: 'The exact text to find.' },
                                new_text: { type: 'string', description: 'The replacement text.' },
                            },
                            required: ['old_text', 'new_text'],
                        },
                    },
                },
                required: ['path', 'edits'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'insert_at_line',
            description: 'Insert content at a specific line number.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'The path to the file.' },
                    line_number: { type: 'number', description: 'The line number (1-indexed).' },
                    content: { type: 'string', description: 'The content to insert.' },
                    position: { type: 'string', enum: ['before', 'after'], description: 'Insert before or after the line. Default: after.' },
                },
                required: ['path', 'line_number', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'execute_command',
            description: 'Execute a shell command with real-time streaming output.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'The command to execute.' },
                    cwd: { type: 'string', description: 'Optional: Working directory for the command.' },
                    timeout: { type: 'number', description: 'Optional: Timeout in milliseconds. Default: 60000.' },
                },
                required: ['command'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_directory',
            description: 'List files and directories.',
            parameters: {
                type: 'object',
                properties: {
                    directory: { type: 'string', description: 'The directory path. Use "." for current.' },
                    recursive: { type: 'boolean', description: 'If true, list recursively. Default: false.' },
                    show_size: { type: 'boolean', description: 'If true, show file sizes. Default: false.' },
                },
                required: ['directory'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'find_files',
            description: 'Find files matching a glob-like pattern (e.g., "*.ts", "test*").',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'The pattern to match (supports * and ? wildcards).' },
                    directory: { type: 'string', description: 'The directory to search in.' },
                    max_results: { type: 'number', description: 'Maximum results to return. Default: 50.' },
                },
                required: ['pattern', 'directory'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_files',
            description: 'Search for text pattern in files. Supports regex and file extension filtering.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'The text or regex pattern to search for.' },
                    directory: { type: 'string', description: 'The directory to search in.' },
                    regex: { type: 'boolean', description: 'If true, treat pattern as regex. Default: false.' },
                    extensions: { type: 'array', items: { type: 'string' }, description: 'Optional: Only search files with these extensions (e.g., ["ts", "js"]).' },
                },
                required: ['pattern', 'directory'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_current_directory',
            description: 'Get the current working directory path.',
            parameters: {
                type: 'object',
                properties: {},
                required: [],
            },
        },
    },
];

// ============================================================================
// TOOL MAPPING
// ============================================================================

export const availableTools: Record<string, Function> = {
    read_file: readFile,
    write_file: writeFile,
    delete_file: deleteFile,
    move_file: moveFile,
    get_file_info: getFileInfo,
    edit_file: editFile,
    multi_edit_file: multiEditFile,
    insert_at_line: insertAtLine,
    execute_command: executeCommand,
    list_directory: listDirectory,
    find_files: findFiles,
    search_files: searchFiles,
    get_current_directory: getCurrentDirectory,
};
