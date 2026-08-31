/**
 * Operator mandate thresholds (spec section 26).
 *
 * These are the numbers a strategy's evidence is judged against. They belong
 * to the operator, not to this system: section 26.6 forbids an agent inferring
 * or widening them, so nothing writes here except an explicit request from a
 * person holding org:manage.
 *
 * Section 26.5 makes a mandate immutable and versioned. A change inserts a new
 * version rather than editing the old one, so a decision recorded last month
 * can still be read against the bar that was in force when it was made.
 */
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { operatorMandates, type Database } from '@arf/db';
import { Errors } from '../errors.js';
import { guard, parseBody } from '../lib/guards.js';

export const ThresholdsSchema = z.object({
  /** Weighted win rate, 0-100. */
  minWinRatePct: z.number().min(0).max(100),
  /** Fraction of walk-forward folds that must be profitable out of sample, 0-1. */
  minFoldsProfitableRatio: z.number().min(0).max(1),
  minClosedTrades: z.number().int().nonnegative(),
  maxDrawdownPct: z.number().min(0).max(100),
  requireOutOfSample: z.boolean(),
  requireTradingViewEvidence: z.boolean(),
  requireParityNotFailing: z.boolean(),
});

export type Thresholds = z.infer<typeof ThresholdsSchema>;

/**
 * Used when an organisation has signed no mandate. Deliberately strict: an
 * unset bar should refuse rather than wave things through, and the screen says
 * plainly that these are defaults nobody chose.
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  minWinRatePct: 40,
  minFoldsProfitableRatio: 0.6,
  minClosedTrades: 100,
  maxDrawdownPct: 30,
  requireOutOfSample: true,
  requireTradingViewEvidence: true,
  requireParityNotFailing: true,
};

export async function loadThresholds(
  db: Database,
  organisationId: string,
): Promise<{ thresholds: Thresholds; version: number | null }> {
  const [row] = await db
    .select()
    .from(operatorMandates)
    .where(eq(operatorMandates.organisationId, organisationId))
    .orderBy(desc(operatorMandates.version))
    .limit(1);

  if (!row) return { thresholds: DEFAULT_THRESHOLDS, version: null };

  const parsed = ThresholdsSchema.safeParse(row.thresholds);
  // A stored mandate that no longer parses is a defect, not a reason to
  // silently fall back to a bar the operator never agreed to.
  if (!parsed.success) {
    throw Errors.policyRejected(
      'mandate_unreadable',
      `Mandate version ${row.version} does not match the current threshold schema.`,
    );
  }
  return { thresholds: parsed.data, version: row.version };
}

export function registerMandateRoutes(app: FastifyInstance, db: Database): void {
  app.get('/v1/mandate', async (request, reply) => {
    const actor = guard(request, 'strategy:read');
    const { thresholds, version } = await loadThresholds(db, actor.organisationId);
    return reply.send({
      thresholds,
      version,
      isDefault: version === null,
      note:
        version === null
          ? 'No mandate has been signed. These are defaults nobody chose; set your own before treating a star as meaningful.'
          : 'Signed mandate in force.',
    });
  });

  app.put('/v1/mandate', async (request, reply) => {
    // org:manage, not strategy:create. Setting the bar a strategy must clear
    // is a governance act, not a research one (section 26.5).
    const actor = guard(request, 'org:manage');
    const thresholds = parseBody(ThresholdsSchema, request.body);

    const [current] = await db
      .select({ version: operatorMandates.version })
      .from(operatorMandates)
      .where(eq(operatorMandates.organisationId, actor.organisationId))
      .orderBy(desc(operatorMandates.version))
      .limit(1);

    const [created] = await db
      .insert(operatorMandates)
      .values({
        organisationId: actor.organisationId,
        version: (current?.version ?? 0) + 1,
        thresholds,
        signedBy: actor.userId,
      })
      .returning();

    return reply.code(201).send({ version: created?.version, thresholds });
  });
}
