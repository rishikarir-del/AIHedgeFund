/**
 * Identity and access.
 *
 * CLAUDE.md 19 requires every aggregate access to verify organisation
 * ownership, so `organisation_id` is a non-null foreign key on every
 * org-scoped table rather than something joined for at query time.
 */
import { index, pgEnum, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../ids.js';

/** Spec 17.1 RBAC roles. */
export const rbacRoleEnum = pgEnum('rbac_role', [
  'VIEWER',
  'RESEARCHER',
  'DEVELOPER',
  'VALIDATOR',
  'OPERATOR',
  'COMMITTEE_MEMBER',
  'ADMIN',
  'SERVICE_ACCOUNT',
]);

export const organisations = pgTable('organisations', {
  id: uuid('id').primaryKey().$defaultFn(uuidv7),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Auth is delegated to Clerk, so this table holds the local projection of an
 * external subject rather than credentials. No password column exists by design.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    externalSubject: text('external_subject').notNull().unique(),
    email: text('email').notNull(),
    displayName: text('display_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('users_email_idx').on(t.email)],
);

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: rbacRoleEnum('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One role per user per organisation; separation of duties (17.2) is
    // meaningless if a user can hold conflicting roles simultaneously.
    unique('memberships_org_user_uq').on(t.organisationId, t.userId),
    index('memberships_user_idx').on(t.userId),
  ],
);
