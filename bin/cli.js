#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Run the TypeScript source directly using tsx
spawnSync('npx', ['tsx', join(__dirname, '..', 'src', 'index.ts')], {
    stdio: 'inherit',
    shell: true,
});
