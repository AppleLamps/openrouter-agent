#!/usr/bin/env node
// bin/cli.js
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Point to the compiled JS file instead of TS source
const __dirname = dirname(fileURLToPath(import.meta.url));
import(join(__dirname, '..', 'dist', 'index.js'));
