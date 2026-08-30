# Troubleshooting

Every entry here is a failure that actually happened during development, with
the diagnosis rather than just the fix. They are recorded because each cost
real time and none was obvious from the error message.

## Memurai installer fails with 1603

**Symptom**

```
Installer failed with exit code: 1603
SFXCA: Failed to create temp directory. Error code 5
CustomAction ca_CheckIfFirewallServiceRunning returned actual error code 1603
```

**Cause.** MSI deferred custom actions run as `SYSTEM` and extract themselves
into the SYSTEM profile's temp directory. On some Windows installs that
directory does not exist, and error code 5 is access-denied on creating it.

Nothing about Memurai is at fault, and the firewall check named in the log is a
red herring — it is simply the first custom action to run.

**Fix.** In an **Administrator** PowerShell:

```bash
mkdir "C:\Windows\System32\config\systemprofile\AppData\Local\Temp"
```

Then re-run the install. This also fixes other MSI installers that would hit
the same wall.

## MCP-style "server disconnected" from a shared SQLite file

**Symptom.** A process crashes at startup with:

```
Error: database is locked
    this.db.exec('PRAGMA journal_mode = WAL;');
  errcode: 261
```

**Cause.** Setting the journal mode needs an exclusive lock. Two processes
opening the same SQLite file will see the second one fail, and it presents as
intermittent because it only occurs when an established connection already
holds an active WAL — two cold starts on a fresh file succeed.

**Fix.** Give each process its own database file, or set a `busy_timeout`
before the pragma.

## `drizzle-kit generate` cannot resolve the schema

**Symptom.** `MODULE_NOT_FOUND` pointing at a `.js` import inside a `.ts`
schema file.

**Cause.** The packages use `NodeNext` module resolution, which requires
explicit `.js` specifiers in relative imports. drizzle-kit loads the schema
through a CJS bundler that cannot resolve them.

**Fix.** `drizzle.config.ts` points at `./dist/schema/*.js`, so `pnpm build`
must run before `pnpm db:generate`. Documented in the config itself.

## Next.js cannot resolve a relative import

**Symptom.** `Module not found: Can't resolve '../lib/server-client.js'`.

**Cause.** The opposite of the previous entry. `apps/web` uses `Bundler`
resolution, where the `.js` extension must be **omitted**. The two conventions
coexist in one repository because Next and Node disagree.

**Fix.** No extension in `apps/web`, explicit `.js` everywhere else.

## pnpm refuses to run a build script

**Symptom.**

```
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: esbuild@0.28.2
```

**Cause.** pnpm 10+ blocks dependency lifecycle scripts by default. The setting
moved out of `package.json` in pnpm 11 and is now `allowBuilds` in
`pnpm-workspace.yaml`.

**Fix.** Add the package with an explicit `true` or `false`. Everything in this
repository is declined except `esbuild`, which needs its postinstall to place a
platform binary.

## Integration tests pass but should not

**Symptom.** `pnpm test` passes while a required service is unavailable.

**Cause.** Without a `vitest.config.ts` exclusion, the default include pattern
collects `*.integration.test.ts` into the unit run. They then pass only because
the service happened to be running locally, and fail in CI.

**Fix.** Every package with integration tests has a `vitest.config.ts` that
excludes them and a separate `vitest.integration.config.ts` that includes only
them.

## `maxRunup` reported as zero on a profitable run

**Symptom.** An equity curve that clearly rose reports a maximum runup of `0`.

**Cause.** Resetting the running trough when a new peak appears erases the very
rise that produced that peak.

**Fix.** Track the running maximum and running minimum independently. Drawdown
measures from the running max; runup measures from the running min, which never
resets on a peak. `packages/metrics` has a regression test for this, and it
caught the bug in this implementation before it shipped.

## MinIO binary not found after winget install

**Symptom.** `The term '...\WinGet\Links\minio.exe' is not recognized`.

**Cause.** winget reports a shim path that does not always resolve for a
non-interactive process.

**Fix.** Use the real binary under
`%LOCALAPPDATA%\Microsoft\WinGet\Packages\MinIO.Server_*\minio.exe`.
