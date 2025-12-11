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
    show_line_numbers: z.boolean().optional().default(false),
});

export const ReadFileWithLinesSchema = z.object({
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

export const EditFileByLinesSchema = z.object({
    path: z.string().min(1, 'Path is required'),
    start_line: z.number().int().positive('Start line must be a positive integer'),
    end_line: z.number().int().positive('End line must be a positive integer'),
    new_content: z.string(),
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
    read_file_with_lines: ReadFileWithLinesSchema,
    write_file: WriteFileSchema,
    delete_file: DeleteFileSchema,
    move_file: MoveFileSchema,
    get_file_info: GetFileInfoSchema,
    edit_file: EditFileSchema,
    edit_file_by_lines: EditFileByLinesSchema,
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

// Maximum file size to read (10MB) - prevents memory issues with huge files
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * Check if a file is too large to read safely
 */
async function checkFileSize(filePath: string): Promise<{ ok: boolean; size: number; error?: string }> {
    try {
        const stats = await fs.stat(filePath);
        if (stats.size > MAX_FILE_SIZE) {
            const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
            return {
                ok: false,
                size: stats.size,
                error: `File too large (${sizeMB}MB). Maximum allowed size is ${MAX_FILE_SIZE / (1024 * 1024)}MB. Use line ranges to read portions of large files.`
            };
        }
        return { ok: true, size: stats.size };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return { ok: false, size: 0, error: `Cannot access file: ${message}` };
    }
}

// ============================================================================
// SECURITY VALIDATORS
// ============================================================================

/**
 * Sensitive file patterns that should not be accessible.
 * Blocks access to secrets, credentials, and system files.
 */
const SENSITIVE_FILE_PATTERNS = [
    /^\.env(\.local|\.production|\.development)?$/i,  // Environment files
    /^\.env\..+$/i,                                    // Any .env variant
    /id_rsa|id_ed25519|id_ecdsa/i,                    // SSH private keys
    /\.pem$/i,                                         // Certificate files
    /\.key$/i,                                         // Key files
    /credentials/i,                                    // Credential files
    /secrets?\.ya?ml$/i,                              // Secret configs
];

/**
 * Validate that a file path is safe to access.
 * - Must be within the working directory
 * - Must not access sensitive files
 */
export function validatePath(inputPath: string): { valid: boolean; resolvedPath: string; error?: string } {
    const workingDir = process.cwd();

    try {
        // Resolve the path relative to working directory
        const resolved = path.resolve(workingDir, inputPath);

        // Ensure the resolved path is within the working directory
        const relative = path.relative(workingDir, resolved);

        // If the relative path starts with '..' or is absolute, it's outside the working dir
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            return {
                valid: false,
                resolvedPath: resolved,
                error: `Path traversal blocked: "${inputPath}" resolves outside the working directory`
            };
        }

        // Check against sensitive file patterns
        const filename = path.basename(resolved);
        for (const pattern of SENSITIVE_FILE_PATTERNS) {
            if (pattern.test(filename)) {
                return {
                    valid: false,
                    resolvedPath: resolved,
                    error: `Access denied: "${filename}" is a sensitive file`
                };
            }
        }

        return { valid: true, resolvedPath: resolved };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return {
            valid: false,
            resolvedPath: inputPath,
            error: `Invalid path: ${message}`
        };
    }
}

/**
 * Dangerous command patterns that should be blocked or warned about.
 */
const DANGEROUS_COMMAND_PATTERNS: Array<{ pattern: RegExp; reason: string; block: boolean }> = [
    // High danger - always block
    { pattern: /rm\s+(-rf?|--recursive).*\s*[\/\\]($|\s)/i, reason: 'Recursive delete on root/sensitive path', block: true },
    { pattern: /sudo\s+/i, reason: 'Privilege escalation attempt', block: true },
    { pattern: />\s*\/dev\//i, reason: 'Writing to device files', block: true },
    { pattern: /mkfs\s+/i, reason: 'Filesystem formatting', block: true },
    { pattern: /dd\s+if=/i, reason: 'Low-level disk operations', block: true },
    { pattern: /format\s+[a-z]:/i, reason: 'Disk formatting on Windows', block: true },

    // Medium danger - warn but allow (user will see confirmation prompt anyway)
    { pattern: /[;&|`$()]/, reason: 'Command chaining/substitution detected', block: false },
    { pattern: /\brm\s+-rf?\s+\*/, reason: 'Wildcard deletion', block: false },
];

/**
 * Validate that a command is safe to execute.
 * Returns validation result with reason if blocked.
 */
export function validateCommand(command: string): { valid: boolean; warnings: string[]; error?: string } {
    const warnings: string[] = [];

    for (const { pattern, reason, block } of DANGEROUS_COMMAND_PATTERNS) {
        if (pattern.test(command)) {
            if (block) {
                return {
                    valid: false,
                    warnings: [],
                    error: `Command blocked: ${reason}. Command: "${command.slice(0, 50)}${command.length > 50 ? '...' : ''}"`
                };
            } else {
                warnings.push(reason);
            }
        }
    }

    return { valid: true, warnings };
}

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
    } catch {
        // Backup failed - not critical, continue without backup
    }
    return null;
}

// ============================================================================
// PROJECT MAP GENERATOR
// ============================================================================

/**
 * Load and parse .gitignore patterns from a directory
 */
async function loadGitignorePatterns(dir: string): Promise<string[]> {
    const patterns: string[] = [];
    try {
        const gitignorePath = path.join(dir, '.gitignore');
        if (existsSync(gitignorePath)) {
            const content = await fs.readFile(gitignorePath, 'utf-8');
            const lines = content.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                // Skip comments and empty lines
                if (trimmed && !trimmed.startsWith('#')) {
                    patterns.push(trimmed);
                }
            }
        }
    } catch {
        // Gitignore parsing failed - continue with empty patterns
    }
    return patterns;
}

/**
 * Check if a file/directory should be ignored based on patterns
 */
function shouldIgnore(name: string, patterns: string[]): boolean {
    // Always ignore these
    const alwaysIgnore = [
        'node_modules', '.git', '.svn', '.hg',
        'dist', 'build', 'out', '.next', '.nuxt',
        '__pycache__', '.pytest_cache', '.mypy_cache',
        'coverage', '.nyc_output',
        '.DS_Store', 'Thumbs.db',
        '*.bak', '.env', '.env.*',
    ];

    for (const pattern of alwaysIgnore) {
        if (pattern.startsWith('*.')) {
            // Extension pattern
            if (name.endsWith(pattern.slice(1))) return true;
        } else if (pattern.endsWith('.*')) {
            // Prefix pattern
            if (name.startsWith(pattern.slice(0, -2))) return true;
        } else {
            if (name === pattern) return true;
        }
    }

    // Check gitignore patterns
    for (const pattern of patterns) {
        // Simple pattern matching (not full glob)
        const cleanPattern = pattern.replace(/^\//, '').replace(/\/$/, '');
        if (name === cleanPattern) return true;
        if (pattern.startsWith('*.') && name.endsWith(pattern.slice(1))) return true;
    }

    return false;
}

/**
 * Generate a tree-like project map string
 */
export async function generateProjectMap(dir: string, maxDepth: number = 4, maxFiles: number = 100): Promise<string> {
    const gitignorePatterns = await loadGitignorePatterns(dir);
    const lines: string[] = [];
    let fileCount = 0;
    let truncated = false;

    async function walkDir(currentDir: string, prefix: string, depth: number): Promise<void> {
        if (depth > maxDepth || fileCount >= maxFiles) {
            truncated = true;
            return;
        }

        try {
            const entries = await fs.readdir(currentDir, { withFileTypes: true });

            // Sort: directories first, then files, both alphabetically
            const sorted = entries.sort((a, b) => {
                if (a.isDirectory() && !b.isDirectory()) return -1;
                if (!a.isDirectory() && b.isDirectory()) return 1;
                return a.name.localeCompare(b.name);
            });

            // Filter ignored entries
            const filtered = sorted.filter(e => !shouldIgnore(e.name, gitignorePatterns));

            for (let i = 0; i < filtered.length; i++) {
                if (fileCount >= maxFiles) {
                    truncated = true;
                    break;
                }

                const entry = filtered[i];
                const isLast = i === filtered.length - 1;
                const connector = isLast ? '└── ' : '├── ';
                const childPrefix = isLast ? '    ' : '│   ';

                if (entry.isDirectory()) {
                    lines.push(`${prefix}${connector}📁 ${entry.name}/`);
                    fileCount++;
                    await walkDir(
                        path.join(currentDir, entry.name),
                        prefix + childPrefix,
                        depth + 1
                    );
                } else {
                    // Add file with type indicator
                    const ext = path.extname(entry.name).toLowerCase();
                    let icon = '📄';
                    if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) icon = '📜';
                    else if (['.json', '.yaml', '.yml', '.toml'].includes(ext)) icon = '⚙️';
                    else if (['.md', '.txt', '.rst'].includes(ext)) icon = '📝';
                    else if (['.css', '.scss', '.less'].includes(ext)) icon = '🎨';
                    else if (['.html', '.htm'].includes(ext)) icon = '🌐';

                    lines.push(`${prefix}${connector}${icon} ${entry.name}`);
                    fileCount++;
                }
            }
        } catch { }
    }

    const dirName = path.basename(dir) || dir;
    lines.push(`📂 ${dirName}/`);
    await walkDir(dir, '', 1);

    if (truncated) {
        lines.push(`\n... (truncated at ${maxFiles} items or depth ${maxDepth})`);
    }

    return lines.join('\n');
}

// ============================================================================
// FILE OPERATIONS
// ============================================================================

async function readFile({ path: filePath, start_line, end_line, show_line_numbers = false }: { path: string; start_line?: number; end_line?: number; show_line_numbers?: boolean }) {
    try {
        // Validate path security - prevent traversal and sensitive file access
        const pathCheck = validatePath(filePath);
        if (!pathCheck.valid) {
            return `Error: ${pathCheck.error}`;
        }

        if (start_line !== undefined || end_line !== undefined) {
            // Read specific lines - streaming, so no size check needed
            const fileStream = createReadStream(pathCheck.resolvedPath);
            const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

            const lines: string[] = [];
            let lineNum = 0;
            const start = start_line || 1;
            const end = end_line || Infinity;

            for await (const line of rl) {
                lineNum++;
                if (lineNum >= start && lineNum <= end) {
                    if (show_line_numbers) {
                        lines.push(`${lineNum} | ${line}`);
                    } else {
                        lines.push(line);
                    }
                }
                if (lineNum > end) break;
            }

            return lines.join('\n') || 'No lines in specified range';
        }

        // Check file size before reading entire file into memory
        const sizeCheck = await checkFileSize(pathCheck.resolvedPath);
        if (!sizeCheck.ok) {
            return `Error: ${sizeCheck.error}`;
        }

        const content = await fs.readFile(pathCheck.resolvedPath, 'utf-8');
        if (show_line_numbers) {
            const lines = content.split('\n');
            return lines.map((line, i) => `${i + 1} | ${line}`).join('\n');
        }
        return content;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return `Error reading file: ${message}`;
    }
}

/**
 * Read file with line numbers always shown - helps the LLM target specific lines for editing.
 * Format: "1 | import..." for easy parsing
 */
async function readFileWithLines({ path: filePath, start_line, end_line }: { path: string; start_line?: number; end_line?: number }) {
    try {
        // Validate path security - prevent traversal and sensitive file access
        const pathCheck = validatePath(filePath);
        if (!pathCheck.valid) {
            return `Error: ${pathCheck.error}`;
        }

        const fileStream = createReadStream(pathCheck.resolvedPath);
        const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

        const lines: string[] = [];
        let lineNum = 0;
        let totalLines = 0;
        const start = start_line || 1;
        const end = end_line || Infinity;

        for await (const line of rl) {
            lineNum++;
            totalLines++;
            if (lineNum >= start && lineNum <= end) {
                // Pad line numbers for alignment (up to 9999 lines)
                const paddedNum = String(lineNum).padStart(4, ' ');
                lines.push(`${paddedNum} | ${line}`);
            }
            if (lineNum > end && end !== Infinity) break;
        }

        if (lines.length === 0) {
            return `No lines in specified range (file has ${totalLines} lines)`;
        }

        // Add file info header
        const rangeInfo = start_line || end_line
            ? `Lines ${start}-${Math.min(end, totalLines)} of ${totalLines}`
            : `All ${totalLines} lines`;

        return `File: ${filePath}\n${rangeInfo}\n${'─'.repeat(60)}\n${lines.join('\n')}`;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return `Error reading file: ${message}`;
    }
}

/**
 * Edit file by replacing a range of lines with new content.
 * This is safer than string matching because it uses explicit line numbers.
 */
async function editFileByLines({ path: filePath, start_line, end_line, new_content }: {
    path: string;
    start_line: number;
    end_line: number;
    new_content: string
}) {
    try {
        // Validate path security
        const pathCheck = validatePath(filePath);
        if (!pathCheck.valid) {
            return `Error: ${pathCheck.error}`;
        }

        // Validate line range
        if (start_line > end_line) {
            return `Error: start_line (${start_line}) must be <= end_line (${end_line})`;
        }

        // Read original content
        const originalContent = await fs.readFile(pathCheck.resolvedPath, 'utf-8');
        const originalLines = originalContent.split('\n');
        const totalLines = originalLines.length;

        // Validate line numbers
        if (start_line < 1) {
            return `Error: start_line must be >= 1 (got ${start_line})`;
        }
        if (end_line > totalLines) {
            return `Error: end_line (${end_line}) exceeds file length (${totalLines} lines)`;
        }

        // Create backup
        await createBackup(pathCheck.resolvedPath);

        // Split new content into lines (handle empty content = delete lines)
        const newLines = new_content === '' ? [] : new_content.split('\n');

        // Build new file content
        const resultLines = [
            ...originalLines.slice(0, start_line - 1),  // Lines before the range
            ...newLines,                                  // New content
            ...originalLines.slice(end_line)              // Lines after the range
        ];

        const newContent = resultLines.join('\n');
        await fs.writeFile(pathCheck.resolvedPath, newContent, 'utf-8');

        // Generate diff
        const diff = createDiff(originalContent, newContent, filePath);

        // Summary
        const linesRemoved = end_line - start_line + 1;
        const linesAdded = newLines.length;
        const lineDelta = linesAdded - linesRemoved;
        const deltaStr = lineDelta >= 0 ? `+${lineDelta}` : `${lineDelta}`;

        return `Edited ${filePath}\n` +
            `Replaced lines ${start_line}-${end_line} (${linesRemoved} lines) with ${linesAdded} lines (${deltaStr} net)\n` +
            `New file has ${resultLines.length} lines\n\n` +
            `Diff:\n${diff}`;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return `Error editing file: ${message}`;
    }
}

async function writeFile({ path: filePath, content }: { path: string; content: string }) {
    try {
        // Validate path security
        const pathCheck = validatePath(filePath);
        if (!pathCheck.valid) {
            return `Error: ${pathCheck.error}`;
        }

        await createBackup(pathCheck.resolvedPath);
        const dir = path.dirname(pathCheck.resolvedPath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(pathCheck.resolvedPath, content, 'utf-8');
        return `Successfully wrote to ${filePath}`;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return `Error writing file: ${message}`;
    }
}

async function deleteFile({ path: filePath, recursive = false }: { path: string; recursive?: boolean }) {
    try {
        // Validate path security
        const pathCheck = validatePath(filePath);
        if (!pathCheck.valid) {
            return `Error: ${pathCheck.error}`;
        }

        const stat = await fs.stat(pathCheck.resolvedPath);
        if (stat.isDirectory()) {
            await fs.rm(pathCheck.resolvedPath, { recursive });
            return `Successfully deleted directory: ${filePath}`;
        } else {
            await fs.unlink(pathCheck.resolvedPath);
            return `Successfully deleted file: ${filePath}`;
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return `Error deleting: ${message}`;
    }
}

async function moveFile({ source, destination }: { source: string; destination: string }) {
    try {
        // Validate both paths
        const sourceCheck = validatePath(source);
        if (!sourceCheck.valid) {
            return `Error: Source - ${sourceCheck.error}`;
        }
        const destCheck = validatePath(destination);
        if (!destCheck.valid) {
            return `Error: Destination - ${destCheck.error}`;
        }

        const destDir = path.dirname(destCheck.resolvedPath);
        await fs.mkdir(destDir, { recursive: true });
        await fs.rename(sourceCheck.resolvedPath, destCheck.resolvedPath);
        return `Successfully moved ${source} to ${destination}`;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return `Error moving file: ${message}`;
    }
}

async function getFileInfo({ path: filePath }: { path: string }) {
    try {
        // Validate path security - prevent traversal and sensitive file access
        const pathCheck = validatePath(filePath);
        if (!pathCheck.valid) {
            return `Error: ${pathCheck.error}`;
        }

        const stat = await fs.stat(pathCheck.resolvedPath);
        const content = stat.isFile() ? await fs.readFile(pathCheck.resolvedPath, 'utf-8') : null;
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
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return `Error getting file info: ${message}`;
    }
}

// ============================================================================
// EDIT OPERATIONS
// ============================================================================

async function editFile({ path: filePath, old_text, new_text, replace_all = false }: { path: string; old_text: string; new_text: string; replace_all?: boolean }) {
    try {
        // Validate path security
        const pathCheck = validatePath(filePath);
        if (!pathCheck.valid) {
            return `Error: ${pathCheck.error}`;
        }

        const content = await fs.readFile(pathCheck.resolvedPath, 'utf-8');

        if (!content.includes(old_text)) {
            return `Error: The specified old_text was not found in ${filePath}`;
        }

        await createBackup(pathCheck.resolvedPath);

        const occurrences = content.split(old_text).length - 1;
        let newContent: string;

        if (replace_all) {
            newContent = content.split(old_text).join(new_text);
        } else {
            newContent = content.replace(old_text, new_text);
        }

        await fs.writeFile(pathCheck.resolvedPath, newContent, 'utf-8');

        const diff = createDiff(content, newContent, filePath);
        const replacedCount = replace_all ? occurrences : 1;
        return `Edited ${filePath}: replaced ${replacedCount} occurrence(s)\n\nDiff:\n${diff}`;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return `Error editing file: ${message}`;
    }
}

interface EditOperation {
    old_text: string;
    new_text: string;
}

async function multiEditFile({ path: filePath, edits }: { path: string; edits: EditOperation[] }) {
    try {
        // Validate path security
        const pathCheck = validatePath(filePath);
        if (!pathCheck.valid) {
            return `Error: ${pathCheck.error}`;
        }

        const originalContent = await fs.readFile(pathCheck.resolvedPath, 'utf-8');
        await createBackup(pathCheck.resolvedPath);

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

        await fs.writeFile(pathCheck.resolvedPath, content, 'utf-8');

        const diff = createDiff(originalContent, content, filePath);
        return `Edited ${filePath}:\n${results.join('\n')}\n\nDiff:\n${diff}`;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return `Error editing file: ${message}`;
    }
}

async function insertAtLine({ path: filePath, line_number, content: insertContent, position = 'after' }: { path: string; line_number: number; content: string; position?: 'before' | 'after' }) {
    try {
        // Validate path security
        const pathCheck = validatePath(filePath);
        if (!pathCheck.valid) {
            return `Error: ${pathCheck.error}`;
        }

        const originalContent = await fs.readFile(pathCheck.resolvedPath, 'utf-8');
        await createBackup(pathCheck.resolvedPath);

        const lines = originalContent.split('\n');
        const insertIndex = position === 'before' ? line_number - 1 : line_number;

        if (insertIndex < 0 || insertIndex > lines.length) {
            return `Error: Line ${line_number} is out of range (file has ${lines.length} lines)`;
        }

        lines.splice(insertIndex, 0, insertContent);
        const newContent = lines.join('\n');

        await fs.writeFile(pathCheck.resolvedPath, newContent, 'utf-8');

        return `Inserted content ${position} line ${line_number} in ${filePath}`;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return `Error inserting at line: ${message}`;
    }
}

// ============================================================================
// COMMAND EXECUTION
// ============================================================================

// Maximum characters to keep from command output (prevents memory issues)
const MAX_OUTPUT_LENGTH = 50000;

async function executeCommand({ command, cwd, timeout = 60000 }: { command: string; cwd?: string; timeout?: number }): Promise<string> {
    // Validate command for dangerous patterns
    const cmdCheck = validateCommand(command);
    if (!cmdCheck.valid) {
        return `Error: ${cmdCheck.error}`;
    }

    // Show warnings for potentially risky commands (but allow them - user sees confirmation anyway)
    if (cmdCheck.warnings.length > 0) {
        console.log(`\n⚠️  Command warnings: ${cmdCheck.warnings.join(', ')}`);
    }

    return new Promise((resolve) => {
        console.log('\n[Command Output]');
        const child = spawn(command, {
            shell: true,
            cwd: cwd || process.cwd(),
        });
        let output = '';
        let timedOut = false;
        let truncatedWarning = false;

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
            resolve(`Command timed out after ${timeout}ms\nPartial output:\n${output}`);
        }, timeout);

        child.stdout.on('data', (data: Buffer) => {
            const text = data.toString();
            process.stdout.write(text);
            output += text;
            // Cap output to prevent memory issues, keeping most recent
            if (output.length > MAX_OUTPUT_LENGTH) {
                output = output.slice(-MAX_OUTPUT_LENGTH);
                if (!truncatedWarning) {
                    truncatedWarning = true;
                }
            }
        });

        child.stderr.on('data', (data: Buffer) => {
            const text = data.toString();
            process.stderr.write(text);
            output += `[stderr] ${text}`;
            // Cap output to prevent memory issues
            if (output.length > MAX_OUTPUT_LENGTH) {
                output = output.slice(-MAX_OUTPUT_LENGTH);
                if (!truncatedWarning) {
                    truncatedWarning = true;
                }
            }
        });

        child.on('close', (code) => {
            clearTimeout(timer);
            if (!timedOut) {
                console.log(`\n[Exit Code: ${code}]`);
                const prefix = truncatedWarning ? '[Output truncated to last 50KB]\n' : '';
                resolve(prefix + output || `Command completed with exit code ${code}`);
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
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return `Error listing directory: ${message}`;
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
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return `Error finding files: ${message}`;
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
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return `Error searching files: ${message}`;
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
                    show_line_numbers: { type: 'boolean', description: 'Optional: If true, prefix each line with its line number (e.g., "1 | code"). Default: false.' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_file_with_lines',
            description: 'Read file content with line numbers always shown. Output format: "   1 | code...". Use this BEFORE editing to identify exact line numbers for edit_file_by_lines.',
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
    {
        type: 'function',
        function: {
            name: 'edit_file_by_lines',
            description: 'Replace a range of lines with new content. SAFER than string matching. Use read_file_with_lines first to identify exact line numbers. Supports deleting lines (empty new_content) or replacing with different number of lines.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'The path to the file to edit.' },
                    start_line: { type: 'number', description: 'First line to replace (1-indexed, inclusive).' },
                    end_line: { type: 'number', description: 'Last line to replace (1-indexed, inclusive).' },
                    new_content: { type: 'string', description: 'The new content to insert. Can be empty to delete lines, or multiple lines (use \\n).' },
                },
                required: ['path', 'start_line', 'end_line', 'new_content'],
            },
        },
    },
];

// ============================================================================
// TOOL MAPPING
// ============================================================================

export const availableTools: Record<string, Function> = {
    read_file: readFile,
    read_file_with_lines: readFileWithLines,
    write_file: writeFile,
    delete_file: deleteFile,
    move_file: moveFile,
    get_file_info: getFileInfo,
    edit_file: editFile,
    edit_file_by_lines: editFileByLines,
    multi_edit_file: multiEditFile,
    insert_at_line: insertAtLine,
    execute_command: executeCommand,
    list_directory: listDirectory,
    find_files: findFiles,
    search_files: searchFiles,
    get_current_directory: getCurrentDirectory,
};

// ============================================================================
// READ-ONLY TOOLS FOR PLANNING MODE
// ============================================================================

/**
 * Tools that are safe to use during planning mode.
 * These only read/explore the codebase without modifying anything.
 */
export const READ_ONLY_TOOL_NAMES = [
    'read_file',
    'read_file_with_lines',
    'list_directory',
    'find_files',
    'search_files',
    'get_file_info',
    'get_current_directory',
];

/**
 * Filtered tools array for planning mode - only read-only tools
 */
export const readOnlyTools = tools.filter(
    (tool) => READ_ONLY_TOOL_NAMES.includes(tool.function.name)
);
