import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Every test file gets its own data directory.
 *
 * `env.DATA_DIR` in vitest.config.ts is read once in the main process, so every
 * file in a run opened the same SQLite file: with fileParallelism off, the bots
 * and conversations one file forgot to delete were visible to the next. That is
 * why the lounge tests passed alone and failed in a full run - the social tick
 * picks its pair from the whole bots table, and it kept picking somebody else's.
 *
 * A setup file is evaluated once per test file, before that file's imports, so
 * assigning here gives the isolation the config already claimed to provide.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'obl-test-'));
