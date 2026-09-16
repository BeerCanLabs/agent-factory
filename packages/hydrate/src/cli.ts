#!/usr/bin/env node
import { pullMind, pushMind } from './index.js';

const [cmd] = process.argv.slice(2);
const storeRoot = process.env.MEMORY_STORE_DIR;
const prefix = process.env.MEMORY_PREFIX;
const dest = process.env.MEMORY_DIR;

if (!storeRoot || !prefix || !dest) {
  console.error('MEMORY_STORE_DIR, MEMORY_PREFIX, and MEMORY_DIR are required');
  process.exit(1);
}

if (cmd === 'pull') {
  pullMind({ root: storeRoot }, prefix, dest);
  process.exit(0);
}
if (cmd === 'push') {
  pushMind({ root: storeRoot }, prefix, dest);
  process.exit(0);
}

console.error('usage: factory-hydrate pull|push');
process.exit(1);
