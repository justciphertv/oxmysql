// Connection-string parsing extracted from src/fivem/index.ts so it can be
// unit-tested without the FiveM globals (`GetCurrentResourceName`,
// `GetConvar`, `GetResourcePath`, …) that the rest of that file needs at
// module load.
//
// Two accepted forms:
//   - URI form: `mysql://user:pass@host:port/database?option=value`
//   - K=V form: `user=root;password=secret;host=localhost;database=app`
//     with a set of aliased keys normalised to the canonical names.
//
// Behaviour is preserved byte-for-byte from the pre-extraction code with
// one deliberate change:
//
//   - An invalid port (`mysql://user@host:abc/db`) now prints a warning
//     via the injected `warn` function and falls back to `undefined` on
//     the pool options — same effective result as the pre-fix silent NaN
//     (mariadb defaults to 3306 when port is unset / invalid) but loud
//     enough for operators to notice the typo. See compat-matrix §11.2.

export type ConnectionOptionsRaw = Record<string, any>;

export interface ConnectionOptions extends ConnectionOptionsRaw {
  /** Sentinel echoing the user's original namedPlaceholders preference.
   *  Stripped before handing off to mariadb's createPool, preserved on
   *  this field so the worker can see the original (string 'false' vs
   *  boolean false) and decide whether to load the patched
   *  named-placeholders module. */
  _userNamedPlaceholders?: unknown;
}

/** Parse a `mysql://user:pass@host:port/database?opt=val` URI string. */
export function parseUri(
  connectionString: string,
  warn: (message: string) => void = () => {},
): ConnectionOptionsRaw {
  const match = connectionString.match(
    new RegExp(
      '^(?:([^:/?#.]+):)?(?://(?:([^/?#]*)@)?([\\w\\d\\-\\u0100-\\uffff.%]*)(?::([0-9]+))?)?([^?#]+)?(?:\\?([^#]*))?$',
    ),
  ) as RegExpMatchArray | null;

  if (!match) {
    throw new Error(`mysql_connection_string structure was invalid (${connectionString})`);
  }

  const authTarget = match[2] ? match[2].split(':') : [];

  // The URI regex only captures digits into match[4], so any non-digit
  // port string (`:abc`) causes the port segment not to match at all and
  // the character run falls into match[5] (the path). Detect this shape
  // explicitly so operators see a clear diagnostic instead of a silent
  // connect-on-3306 fallback.
  const rawPort = match[4];
  let port: number | undefined;
  if (rawPort) {
    const parsed = Number.parseInt(rawPort, 10);
    port = Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? parsed : undefined;
    if (port === undefined) {
      warn(`mysql_connection_string has an invalid port (${rawPort}); defaulting to 3306.`);
    }
  } else if (/:[^/?]*\//.test(connectionString) && !/:\d+\//.test(connectionString)) {
    // A `:xxx/` segment exists but did not match the port regex — means
    // the user wrote a non-numeric port. Warn once.
    warn(
      `mysql_connection_string has a port value that is not a valid number; defaulting to 3306.`,
    );
  }

  return {
    user: authTarget[0] || undefined,
    password: authTarget[1] || undefined,
    host: match[3],
    port,
    database: match[5]?.replace(/^\/+/, ''),
    ...(match[6] &&
      match[6].split('&').reduce<Record<string, string>>((acc, param) => {
        const [key, value] = param.split('=');
        if (key && value) acc[key] = value;
        return acc;
      }, {})),
  };
}

/** Parse the semicolon-delimited `key=value;…` form, normalising aliased
 *  keys (`uid` -> `user`, `pwd` -> `password`, etc.) to their canonical
 *  names. */
export function parseKeyValue(connectionString: string): ConnectionOptionsRaw {
  return connectionString
    .replace(/(?:host(?:name)|ip|server|data\s?source|addr(?:ess)?)=/gi, 'host=')
    .replace(/(?:user\s?(?:id|name)?|uid)=/gi, 'user=')
    .replace(/(?:pwd|pass)=/gi, 'password=')
    .replace(/(?:db)=/gi, 'database=')
    .split(';')
    .reduce<Record<string, string>>((acc, param) => {
      const [key, value] = param.split('=');
      if (key) acc[key] = value;
      return acc;
    }, {});
}

/** Build the final connection-options object that is passed to the mariadb
 *  createPool. Selects URI vs K=V based on content, then normalises a
 *  couple of JSON-encoded option values (`ssl`) and captures the user's
 *  original `namedPlaceholders` preference on the sentinel field. */
export function buildConnectionOptions(
  connectionString: string,
  warn: (message: string) => void = () => {},
): ConnectionOptions {
  const raw: Record<string, any> = connectionString.includes('mysql://')
    ? parseUri(connectionString, warn)
    : parseKeyValue(connectionString);

  for (const key of ['ssl']) {
    if (typeof raw[key] === 'string') {
      try {
        raw[key] = JSON.parse(raw[key]);
      } catch {
        warn(`Failed to parse property ${key} in configuration.`);
      }
    }
  }

  const userNamedPlaceholders = raw.namedPlaceholders;

  return {
    connectTimeout: 60000,
    bigIntAsNumber: true,
    ...raw,
    namedPlaceholders: false, // disable mariadb's built-in handling; we do it ourselves
    _userNamedPlaceholders: userNamedPlaceholders,
  };
}
