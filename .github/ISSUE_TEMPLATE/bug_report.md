---
name: Bug report
about: Report a defect in the justciphertv/oxmysql fork
title: ''
labels: bug
assignees: ''

---

> **This is a fork of [CommunityOx/oxmysql](https://github.com/CommunityOx/oxmysql).**
> If your issue is reproducible on upstream as well, please report it there too or link the upstream issue here.

## Issue checklist

- [ ] I am running the latest release from [justciphertv/oxmysql](https://github.com/justciphertv/oxmysql).
- [ ] I have searched existing issues on this fork's repo.
- [ ] I have read [docs/troubleshooting.md](../../docs/troubleshooting.md), including the build-stamp verification steps.
- [ ] I'm certain this is an oxmysql defect, not a defect in the consumer resource.

## Build stamp

Paste the exact line from your FXServer startup console:

```
[<db-version>] Database server connection established! [oxmysql-mariadb-patch XXXXXXX]
```

> Deployment drift (stale files, wrong directory, missing `add_unsafe_worker_permission`) is the single most common cause of reports that cannot be reproduced. The build stamp makes that easy to rule out.

## Describe the bug

A clear and concise description of what happens and how it differs from the expected behaviour.

## Minimal reproducer

```lua
-- The query + Lua call that triggers the defect.
```

```sql
-- If relevant, the schema of the table(s) involved — `SHOW CREATE TABLE …`.
```

## Expected vs. observed

**Expected:**

**Observed:**

## Environment

- **Server:** FXServer artifact build (from `version` in server console, e.g. `12913`).
- **OS:** Windows / Linux (distribution + version).
- **Database:** MariaDB or MySQL, version.
- **Relevant convars** (`mysql_debug`, `mysql_bit_full_integer`, `mysql_start_transaction_propagate_errors`, `mysql_request_timeout_ms`, etc.):

```
set mysql_debug "…"
```

## Logs

Please include the FXServer console output around the error, with `mysql_debug` enabled if the issue touches typeCast / placeholder handling:

```
```
