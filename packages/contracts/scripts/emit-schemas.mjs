/**
 * Emit JSON Schema for every published contract into the repository's
 * top-level `schemas/` directory.
 *
 * CLAUDE.md section 2 tells any agent to read "relevant schemas in schemas/"
 * before implementing a feature, and the build prompt says to generate
 * TypeScript contracts corresponding to those JSON schemas. Hand-maintaining
 * both sides would let them drift, so Zod is the single source of truth and the
 * JSON Schema is generated from it.
 *
 * Run with: pnpm --filter @arf/contracts schemas:emit
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import {
  BacktestPlanSchema,
  BacktestRunResultSchema,
  HandoffSchema,
  ParityReportSchema,
  StrategyDefinitionSchema,
} from '../dist/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', '..', '..', 'schemas');

/**
 * `io: 'input'` describes the wire format rather than the parsed result. That
 * matters because branded IDs are transforms: on the wire they are plain UUID
 * strings, which is what an external producer needs to satisfy.
 */
const OPTIONS = { io: 'input', unrepresentable: 'any', target: 'draft-2020-12' };

const CONTRACTS = [
  ['strategy-definition', StrategyDefinitionSchema, 'Strategy Definition Language document (spec section 9)'],
  ['agent-handoff', HandoffSchema, 'Typed contract for agent-to-agent handoffs (spec section 8)'],
  ['backtest-plan', BacktestPlanSchema, 'Declared plan for a backtest run, fixed before execution'],
  ['backtest-run-result', BacktestRunResultSchema, 'Backtest result, source-discriminated (see ADR 0002)'],
  ['parity-report', ParityReportSchema, 'Reported-versus-calculated comparison (spec section 15.3)'],
];

mkdirSync(OUT, { recursive: true });

let failed = false;
for (const [name, schema, description] of CONTRACTS) {
  try {
    const jsonSchema = z.toJSONSchema(schema, OPTIONS);
    const document = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: `https://arf-os.local/schemas/${name}.schema.json`,
      title: name,
      description,
      ...jsonSchema,
    };
    const file = path.join(OUT, `${name}.schema.json`);
    writeFileSync(file, JSON.stringify(document, null, 2) + '\n', 'utf8');
    console.log(`WRITE schemas/${name}.schema.json`);
  } catch (err) {
    failed = true;
    console.error(`FAIL  ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (failed) process.exitCode = 1;
