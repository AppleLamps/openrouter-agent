import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    validateToolArgs,
    validatePath,
    validateCommand,
} from './tools';

// ============================================================================
// validateToolArgs Tests
// ============================================================================

describe('validateToolArgs', () => {
    describe('read_file', () => {
        it('should validate valid read_file args', () => {
            const result = validateToolArgs('read_file', { path: 'test.ts' });
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.path).toBe('test.ts');
            }
        });

        it('should reject empty path', () => {
            const result = validateToolArgs('read_file', { path: '' });
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error).toContain('Path is required');
            }
        });

        it('should reject missing path', () => {
            const result = validateToolArgs('read_file', {});
            expect(result.success).toBe(false);
        });

        it('should accept optional line range', () => {
            const result = validateToolArgs('read_file', {
                path: 'test.ts',
                start_line: 1,
                end_line: 10,
                show_line_numbers: true,
            });
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.start_line).toBe(1);
                expect(result.data.end_line).toBe(10);
            }
        });
    });

    describe('write_file', () => {
        it('should validate valid write_file args', () => {
            const result = validateToolArgs('write_file', {
                path: 'test.ts',
                content: 'console.log("hello")',
            });
            expect(result.success).toBe(true);
        });

        it('should allow empty content', () => {
            const result = validateToolArgs('write_file', {
                path: 'test.ts',
                content: '',
            });
            expect(result.success).toBe(true);
        });
    });

    describe('edit_file_by_lines', () => {
        it('should validate valid line edit args', () => {
            const result = validateToolArgs('edit_file_by_lines', {
                path: 'test.ts',
                start_line: 5,
                end_line: 10,
                new_content: '// new code',
            });
            expect(result.success).toBe(true);
        });

        it('should reject non-positive line numbers', () => {
            const result = validateToolArgs('edit_file_by_lines', {
                path: 'test.ts',
                start_line: 0,
                end_line: 10,
                new_content: '',
            });
            expect(result.success).toBe(false);
        });
    });

    describe('execute_command', () => {
        it('should validate valid command', () => {
            const result = validateToolArgs('execute_command', {
                command: 'npm install',
            });
            expect(result.success).toBe(true);
        });

        it('should apply default timeout', () => {
            const result = validateToolArgs('execute_command', {
                command: 'npm install',
            });
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.timeout).toBe(60000);
            }
        });

        it('should accept custom timeout', () => {
            const result = validateToolArgs('execute_command', {
                command: 'npm install',
                timeout: 30000,
            });
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.timeout).toBe(30000);
            }
        });
    });

    describe('unknown tool', () => {
        it('should return error for unknown tool', () => {
            const result = validateToolArgs('nonexistent_tool', {});
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error).toContain('Unknown tool');
            }
        });
    });
});

// ============================================================================
// validatePath Tests
// ============================================================================

describe('validatePath', () => {
    it('should allow paths within working directory', () => {
        const result = validatePath('src/index.ts');
        expect(result.valid).toBe(true);
    });

    it('should allow nested paths', () => {
        const result = validatePath('src/utils/helpers.ts');
        expect(result.valid).toBe(true);
    });

    it('should block path traversal with ../', () => {
        const result = validatePath('../../../etc/passwd');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Path traversal blocked');
    });

    it('should block .env files', () => {
        const result = validatePath('.env');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('sensitive file');
    });

    it('should block .env.local files', () => {
        const result = validatePath('.env.local');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('sensitive file');
    });

    it('should block private key files', () => {
        const result = validatePath('id_rsa');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('sensitive file');
    });

    it('should block .pem certificate files', () => {
        const result = validatePath('server.pem');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('sensitive file');
    });

    it('should block credentials files', () => {
        const result = validatePath('credentials.json');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('sensitive file');
    });

    it('should allow normal config files', () => {
        const result = validatePath('package.json');
        expect(result.valid).toBe(true);
    });

    it('should allow tsconfig.json', () => {
        const result = validatePath('tsconfig.json');
        expect(result.valid).toBe(true);
    });
});

// ============================================================================
// validateCommand Tests
// ============================================================================

describe('validateCommand', () => {
    describe('safe commands', () => {
        it('should allow npm install', () => {
            const result = validateCommand('npm install');
            expect(result.valid).toBe(true);
            expect(result.warnings).toHaveLength(0);
        });

        it('should allow npm run build', () => {
            const result = validateCommand('npm run build');
            expect(result.valid).toBe(true);
        });

        it('should allow git status', () => {
            const result = validateCommand('git status');
            expect(result.valid).toBe(true);
        });

        it('should allow ls -la', () => {
            const result = validateCommand('ls -la');
            expect(result.valid).toBe(true);
        });
    });

    describe('blocked commands', () => {
        it('should block sudo commands', () => {
            const result = validateCommand('sudo apt install');
            expect(result.valid).toBe(false);
            expect(result.error).toContain('Privilege escalation');
        });

        it('should block mkfs commands', () => {
            const result = validateCommand('mkfs /dev/sda1');
            expect(result.valid).toBe(false);
            expect(result.error).toContain('Filesystem formatting');
        });

        it('should block dd commands', () => {
            const result = validateCommand('dd if=/dev/zero of=/dev/sda');
            expect(result.valid).toBe(false);
            expect(result.error).toContain('Low-level disk operations');
        });

        it('should block Windows format commands', () => {
            const result = validateCommand('format C:');
            expect(result.valid).toBe(false);
            expect(result.error).toContain('Disk formatting on Windows');
        });

        it('should block writing to /dev/ files', () => {
            const result = validateCommand('echo x > /dev/sda');
            expect(result.valid).toBe(false);
            expect(result.error).toContain('Writing to device files');
        });
    });

    describe('warned commands (allowed but flagged)', () => {
        it('should warn on command chaining with ;', () => {
            const result = validateCommand('npm install; npm run build');
            expect(result.valid).toBe(true);
            expect(result.warnings).toContain('Command chaining/substitution detected');
        });

        it('should warn on command chaining with &&', () => {
            const result = validateCommand('npm install && npm run build');
            expect(result.valid).toBe(true);
            expect(result.warnings).toContain('Command chaining/substitution detected');
        });

        it('should warn on command chaining with ||', () => {
            const result = validateCommand('npm install || echo failed');
            expect(result.valid).toBe(true);
            expect(result.warnings).toContain('Command chaining/substitution detected');
        });

        it('should warn on command substitution with backticks', () => {
            const result = validateCommand('echo `whoami`');
            expect(result.valid).toBe(true);
            expect(result.warnings).toContain('Command chaining/substitution detected');
        });

        it('should warn on command substitution with $()', () => {
            const result = validateCommand('echo $(whoami)');
            expect(result.valid).toBe(true);
            expect(result.warnings).toContain('Command chaining/substitution detected');
        });

        it('should warn on wildcard rm', () => {
            const result = validateCommand('rm -rf *');
            expect(result.valid).toBe(true);
            expect(result.warnings).toContain('Wildcard deletion');
        });
    });
});
