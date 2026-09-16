#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.MEMORY_DIR || '/tmp/echo-mind';
mkdirSync(dir, { recursive: true });
appendFileSync(join(dir, 'wake.log'), `${new Date().toISOString()} wake ${process.env.AGENT_ID}\n`);
console.log(`[echo-agent] woke; mind at ${dir}`);
