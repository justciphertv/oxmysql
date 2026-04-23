# Security policy

This is a fork of [`CommunityOx/oxmysql`](https://github.com/CommunityOx/oxmysql). Security decisions described below apply to this fork only; consult the upstream repo for upstream guidance.

## Supported versions

| Version | Security fixes |
|---------|----------------|
| `3.2.x` | ✅ current |
| `3.1.x` | ✅ previous; security fixes backported on a best-effort basis |
| `< 3.1` | ❌ upstream-forked territory; use upstream or upgrade |

## Reporting a vulnerability

Open a **private** security advisory via GitHub:

[github.com/justciphertv/oxmysql/security/advisories/new](https://github.com/justciphertv/oxmysql/security/advisories/new)

Please include:

- The fork commit stamp from the FXServer startup banner (`[oxmysql-mariadb-patch XXXXXXX]`).
- MariaDB / MySQL server version.
- A minimal reproducer — SQL, Lua / JS call that triggers it, and the observed vs. expected result.
- Whether consumer data is observable or modifiable by an unauthenticated / unprivileged actor.

I'll acknowledge within 7 days. For privately-reported issues the fix, any necessary matrix update, and a release go out together before the advisory is made public.

**Do not** open public GitHub issues or PRs for security-sensitive defects.

## Trust boundary

oxmysql runs as a FiveM resource on the server process. By design it has:

- Full read/write access to the database behind the connection string.
- A Node.js worker thread spawned under FXServer's `add_unsafe_worker_permission oxmysql` grant.
- Access to FXServer globals and events.

The trust boundary therefore sits at the **resource operator** — anyone who controls `server.cfg`, the `resources/` directory, or the worker-permission allow-list.

Players, non-admin ace groups, and out-of-band callers (e.g. third-party web tools) **do not cross the trust boundary**. Attack surface we defend against:

- Malicious SQL from consumer resource code (parameterised placeholders; multi-statement disabled by default).
- Player input reaching query callers as placeholder values (handled by the patched `named-placeholders` and positional bindings).
- Attempted use of privileged NUI handlers (`oxmysql:fetchResource`) without the `command.mysql` ace — blocked.

Attack surface we **do not** defend against:

- A resource operator who edits `mysql_connection_string` with malicious URL-encoded options.
- A resource operator who sets `multipleStatements` on the pool and writes unparameterised SQL.
- A compromised FXServer administrator.

## Known trust-affecting surfaces

These are documented so operators can decide whether to opt in.

### 1. Unsafe worker permission

`add_unsafe_worker_permission oxmysql` is **required** for the fork to function — the database client runs inside a Node `worker_thread`, which FXServer gates behind this permission. The permission gives the worker the same file-system and network access as FXServer itself.

Operators who cannot grant unsafe-worker access should run upstream `CommunityOx/oxmysql`, which uses `mysql2` directly on the FXServer main thread.

### 2. `mysql_logger_service` convar — arbitrary JavaScript load

When `mysql_logger_service` is set, [src/fivem/index.ts:72](src/fivem/index.ts:72) loads the referenced `.js` file via `new Function(LoadResourceFile(...))()` at startup. The file content is server-controlled (your resources) and runs with full Node privileges. Upstream behavior, preserved here.

**Mitigation:** do not point `mysql_logger_service` at a file sourced from anything other than trusted resource code you control.

### 3. `mysql_debug` logs queries to disk buffer

When `mysql_debug` is truthy, queries and parameters are buffered for the in-game UI (`mysql_ui = true`) and written to the FXServer console. **Parameters may contain secrets** — player tokens, hashed passwords, billing references. Enable in development only, or scope to a single resource via the JSON-array form: `set mysql_debug ["resource_name"]`.

### 4. Named-placeholders patch

The `named-placeholders` module is pinned to `1.1.3` and carries a local patch ([patches/named-placeholders+1.1.3.patch](patches/named-placeholders+1.1.3.patch)). The patch:
- accepts `@name` in addition to `:name`;
- strips a leading `:` / `@` from parameter object keys;
- binds a missing key as `null` (not `undefined`).

A startup sanity check verifies the patched contract is active; worker exits with code 1 if the patch is missing. See [src/worker/config.ts](src/worker/config.ts) and [docs/troubleshooting.md](docs/troubleshooting.md).

### 5. Fork-specific build stamp

Every production zip embeds the short git commit it was built from, printed to the FXServer startup banner as `[oxmysql-mariadb-patch XXXXXXX]`. Include this hash in any security report. Deployment drift (stale files, wrong directory) is the single most common reason a reported defect cannot be reproduced on a current build.

## What is **not** a security issue

- A consumer resource that constructs SQL by concatenation is the consumer's problem, not this library's.
- `BIGINT` / `insertId` precision loss above 2^53 is a deliberate, documented type-coercion tradeoff (see compat-matrix §4.1 and §4.3). Opt out by using a string-typed column or waiting for the planned `bigint` opt-in convar.
- `mysql_debug` output containing secrets is a documented contract of enabling debug mode. Do not enable on a production server that holds PII.
- `DATE` columns returning local-timezone-interpreted milliseconds is a pinned behaviour (compat-matrix §5). Run with `TZ=UTC` if DST-safe DATE arithmetic matters.
