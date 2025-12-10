#!/usr/bin/env node
const path = require('path');

// Point to the compiled JS file in dist/
const distIndex = path.join(__dirname, '..', 'dist', 'index.js');
require(distIndex);
