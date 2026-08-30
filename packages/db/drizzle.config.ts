import type { Config } from 'drizzle-kit';

export default {
  // Compiled output, not source: drizzle-kit loads the schema through a CJS
  // bundler that cannot resolve the explicit `.js` specifiers NodeNext
  // requires. Run `pnpm build` before `db:generate`.
  schema: './dist/schema/*.js',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://arfos:arfos@localhost:5432/arfos',
  },
  strict: true,
  verbose: true,
} satisfies Config;
