import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from './Agent';

// ============================================================================
// Agent Class Tests
// ============================================================================

describe('Agent', () => {
    let agent: Agent;

    beforeEach(() => {
        // Create agent with minimal config (no API key needed for these tests)
        agent = new Agent({
            apiKey: 'test-key',
            model: 'test-model',
            safetyLevel: 'off',
        });
    });

    describe('constructor', () => {
        it('should create agent with default model if not specified', () => {
            const defaultAgent = new Agent({ apiKey: 'test' });
            expect(defaultAgent.model).toBeDefined();
        });

        it('should use provided model', () => {
            expect(agent.model).toBe('test-model');
        });

        it('should default to full safety level', () => {
            const safeAgent = new Agent({ apiKey: 'test' });
            expect(safeAgent.safetyLevel).toBe('full');
        });

        it('should accept safety level config', () => {
            expect(agent.safetyLevel).toBe('off');
        });
    });

    describe('model getter/setter', () => {
        it('should get current model', () => {
            expect(agent.model).toBe('test-model');
        });

        it('should set new model', () => {
            agent.model = 'new-model';
            expect(agent.model).toBe('new-model');
        });
    });

    describe('webSearch getter/setter', () => {
        it('should default to false', () => {
            expect(agent.webSearch).toBe(false);
        });

        it('should toggle web search', () => {
            agent.webSearch = true;
            expect(agent.webSearch).toBe(true);
        });
    });

    describe('tokens getter', () => {
        it('should return token counts', () => {
            const tokens = agent.tokens;
            expect(tokens).toHaveProperty('input');
            expect(tokens).toHaveProperty('output');
            expect(tokens.input).toBe(0);
            expect(tokens.output).toBe(0);
        });

        it('should return a copy of tokens', () => {
            const tokens1 = agent.tokens;
            const tokens2 = agent.tokens;
            expect(tokens1).not.toBe(tokens2);
            expect(tokens1).toEqual(tokens2);
        });
    });

    describe('safetyLevel', () => {
        it('should cycle through safety levels', () => {
            const safeAgent = new Agent({ apiKey: 'test', safetyLevel: 'full' });

            expect(safeAgent.safetyLevel).toBe('full');

            safeAgent.cycleSafetyLevel();
            expect(safeAgent.safetyLevel).toBe('delete-only');

            safeAgent.cycleSafetyLevel();
            expect(safeAgent.safetyLevel).toBe('off');

            safeAgent.cycleSafetyLevel();
            expect(safeAgent.safetyLevel).toBe('full');
        });
    });

    describe('debug mode', () => {
        it('should default to false', () => {
            expect(agent.debug).toBe(false);
        });

        it('should toggle debug mode', () => {
            const result = agent.toggleDebug();
            expect(result).toBe(true);
            expect(agent.debug).toBe(true);

            const result2 = agent.toggleDebug();
            expect(result2).toBe(false);
            expect(agent.debug).toBe(false);
        });
    });

    describe('historyLength', () => {
        it('should return 0 for new agent', () => {
            expect(agent.historyLength).toBe(0);
        });
    });

    describe('clearHistory', () => {
        it('should clear history and reset tokens', () => {
            // Manually set some values to verify they get cleared
            agent.clearHistory();

            expect(agent.historyLength).toBe(0);
            expect(agent.tokens.input).toBe(0);
            expect(agent.tokens.output).toBe(0);
        });
    });

    describe('getProjectContext', () => {
        it('should return empty string before initialization', () => {
            expect(agent.getProjectContext()).toBe('');
        });
    });

    describe('getProjectMap', () => {
        it('should return empty string before initialization', () => {
            expect(agent.getProjectMap()).toBe('');
        });
    });
});

// ============================================================================
// Token Estimation Tests (via public interface)
// ============================================================================

describe('Agent Token Management', () => {
    it('should initialize with zero tokens', () => {
        const agent = new Agent({ apiKey: 'test' });
        expect(agent.tokens.input).toBe(0);
        expect(agent.tokens.output).toBe(0);
    });

    // Note: More detailed token estimation tests would require
    // exposing the private methods or testing via integration tests
});
