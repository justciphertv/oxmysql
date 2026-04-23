// Cluster 19 — connection-string parsing (audit M5).
//
// Pins the port-parsing behaviour introduced alongside the
// extraction of src/fivem/connection-string.ts:
//
//   - A valid port is parsed as a number in the [1, 65535] range.
//   - An omitted port leaves the `port` field `undefined` (mariadb
//     defaults to 3306 — same effective behaviour as the pre-fix
//     silent NaN fallback).
//   - An invalid port (non-numeric, zero, negative, out-of-range) also
//     leaves `port` `undefined` and invokes the injected `warn` callback
//     so operators see a diagnostic. This is the deliberate behaviour
//     change from the pre-fix silent NaN for typos like
//     `mysql://user@host:abc/db`.
//
// Also verifies that the k=v form continues to work for non-URI
// connection strings (backward-compat).

import { describe, expect, it, vi } from 'vitest';

import {
  buildConnectionOptions,
  parseKeyValue,
  parseUri,
} from '../src/fivem/connection-string';

describe('cluster 19 — connection-string parsing', () => {
  // ── URI form ─────────────────────────────────────────────────────────

  it('parses a fully-specified URI', () => {
    const r = parseUri('mysql://root:secret@localhost:3306/app');
    expect(r).toMatchObject({
      user: 'root',
      password: 'secret',
      host: 'localhost',
      port: 3306,
      database: 'app',
    });
  });

  it('leaves port undefined when the URI omits it', () => {
    const warn = vi.fn();
    const r = parseUri('mysql://root:secret@localhost/app', warn);
    expect(r.port).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and leaves port undefined for a non-numeric port', () => {
    const warn = vi.fn();
    const r = parseUri('mysql://root:secret@localhost:abc/app', warn);
    expect(r.port).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/port/i);
  });

  it('warns and leaves port undefined for an out-of-range port', () => {
    const warn = vi.fn();
    // 70000 is > 65535 — the regex matches (all digits) but the range
    // validation in parseUri rejects it.
    const r = parseUri('mysql://root:secret@localhost:70000/app', warn);
    expect(r.port).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns and leaves port undefined for a zero port', () => {
    const warn = vi.fn();
    const r = parseUri('mysql://root:secret@localhost:0/app', warn);
    expect(r.port).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('parses URI query-string options into the result', () => {
    const r = parseUri('mysql://root@localhost/app?charset=utf8mb4&ssl=true');
    expect(r).toMatchObject({
      user: 'root',
      host: 'localhost',
      database: 'app',
      charset: 'utf8mb4',
      ssl: 'true',
    });
  });

  it('trims leading slashes from the database path', () => {
    const r = parseUri('mysql://root@localhost/app');
    expect(r.database).toBe('app');
  });

  // ── K=V form ─────────────────────────────────────────────────────────

  it('parses the k=v form and normalises aliased keys', () => {
    const r = parseKeyValue('uid=root;pwd=secret;server=db;db=app');
    expect(r).toMatchObject({
      user: 'root',
      password: 'secret',
      host: 'db',
      database: 'app',
    });
  });

  it('k=v form leaves port untouched when not specified', () => {
    const r = parseKeyValue('user=root;host=localhost;database=app');
    // k=v does not coerce types; port would come as a string if given,
    // and undefined if absent. The pool accepts both shapes.
    expect(r.port).toBeUndefined();
  });

  // ── buildConnectionOptions integration ───────────────────────────────

  it('buildConnectionOptions selects URI parser for strings containing mysql://', () => {
    const opts = buildConnectionOptions('mysql://root@localhost:3306/app');
    expect(opts).toMatchObject({
      user: 'root',
      host: 'localhost',
      port: 3306,
      database: 'app',
      connectTimeout: 60000,
      bigIntAsNumber: true,
      namedPlaceholders: false,
    });
  });

  it('buildConnectionOptions selects k=v parser when URI scheme is absent', () => {
    const opts = buildConnectionOptions('user=root;host=localhost;database=app');
    expect(opts.user).toBe('root');
    expect(opts.host).toBe('localhost');
    expect(opts.database).toBe('app');
    expect(opts.namedPlaceholders).toBe(false);
  });

  it('buildConnectionOptions preserves user namedPlaceholders preference on sentinel', () => {
    const opts = buildConnectionOptions('mysql://root@localhost/app?namedPlaceholders=false');
    expect(opts.namedPlaceholders).toBe(false);
    expect(opts._userNamedPlaceholders).toBe('false');
  });

  it('buildConnectionOptions parses ssl option as JSON when it is a string', () => {
    const opts = buildConnectionOptions('mysql://root@localhost/app?ssl={"rejectUnauthorized":false}');
    expect(opts.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('buildConnectionOptions warns on malformed ssl JSON but does not throw', () => {
    const warn = vi.fn();
    const opts = buildConnectionOptions(
      'mysql://root@localhost/app?ssl=not-json',
      warn,
    );
    expect(opts).toBeDefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ssl/));
  });

  it('buildConnectionOptions propagates port warning from parseUri', () => {
    const warn = vi.fn();
    const opts = buildConnectionOptions('mysql://root@localhost:nope/app', warn);
    expect(opts.port).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
