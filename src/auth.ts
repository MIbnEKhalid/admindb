/**
 * AdminDB Authentication Module
 *
 * Provides simple, robust, zero-dependency native authentication:
 * - Enabled by default with configurable credentials (options, CLI, or env vars).
 * - Stores/verifies passwords using salted scrypt cryptographic key derivation (`scrypt:<salt>:<hash>`).
 * - Default credentials: username `admin` with hardcoded scrypt password hash for `admin`.
 * - Can be completely disabled via `auth: false`, `--no-auth`, or `ADMINDB_AUTH=false`.
 * - Supports signed HMAC session cookies (browser UI), HTTP Basic Auth, and Bearer Tokens (REST API / scripts).
 * - Uses constant-time comparison to prevent timing attacks.
 */

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction, Router } from 'express';
import type { Logger } from './logger';

export interface AuthConfig {
  /**
   * Whether authentication is enabled.
   * Set to `false` to disable protection entirely (e.g. for development or custom upstream auth).
   * Defaults to `true`.
   */
  enabled?: boolean;
  /** Admin username. Defaults to `process.env.ADMINDB_USERNAME` or `'admin'`. */
  username?: string;
  /**
   * Admin password or password hash (e.g. `scrypt:<salt>:<hash>`).
   * Generate a hash using `npm run generatehash`.
   * Defaults to `process.env.ADMINDB_PASSWORD` or the hardcoded default hash for `'admin'`.
   */
  password?: string;
  /** Secret key used to sign session cookies. Defaults to `process.env.ADMINDB_SECRET` or auto-generated. */
  secret?: string;
  /** Session expiration time in milliseconds. Defaults to 7 days (604800000 ms). */
  sessionDurationMs?: number;
}

export interface ResolvedAuthConfig {
  enabled: boolean;
  username: string;
  password: string;
  secret: string;
  sessionDurationMs: number;
  isDefaultPassword: boolean;
}

export const DEFAULT_USERNAME = 'admin';

/**
 * Hardcoded default scrypt hash for password 'admin' (salt: d9f2e64b8a1c3d5e7f0a2b4c6e801357, keyLen: 64).
 */
export const DEFAULT_PASSWORD_HASH =
  'scrypt:d9f2e64b8a1c3d5e7f0a2b4c6e801357:cb3032b16f29c8d44f75c779f070c61c846b17eb333d07596ceb8470fc1b4c06cc720c08796ebc86937dab28a3ef580ced38a71c940fd4a169fd2e9cb9fa40e2';

const DEFAULT_SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const SESSION_COOKIE_NAME = 'admindb_session';

// Stable process-wide fallback secret when no secret is explicitly provided in env
const PROCESS_FALLBACK_SECRET = randomBytes(32).toString('hex');

/**
 * Generates a secure scrypt password hash with a random or provided salt.
 * Format: `scrypt:<saltHex>:<derivedKeyHex>`
 */
export function hashPassword(password: string, salt?: string): string {
  const saltHex = salt || randomBytes(16).toString('hex');
  const derivedKey = scryptSync(password, saltHex, 64).toString('hex');
  return `scrypt:${saltHex}:${derivedKey}`;
}

/**
 * Constant-time comparison between two strings to prevent timing attacks.
 */
export function constantTimeCompare(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(String(a), 'utf8');
    const bufB = Buffer.from(String(b), 'utf8');
    if (bufA.length !== bufB.length) {
      // Dummy comparison to prevent timing leak on length mismatch
      timingSafeEqual(bufA, bufA);
      return false;
    }
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/**
 * Verifies a candidate plaintext password against a stored password or scrypt hash.
 */
export function verifyPassword(candidatePassword: string, storedPasswordOrHash: string): boolean {
  if (typeof candidatePassword !== 'string' || typeof storedPasswordOrHash !== 'string') {
    return false;
  }

  // Handle scrypt formatted hash: `scrypt:<salt>:<hash>`
  if (storedPasswordOrHash.startsWith('scrypt:')) {
    const parts = storedPasswordOrHash.split(':');
    if (parts.length === 3 && parts[1] && parts[2]) {
      const salt = parts[1];
      const expectedKeyHex = parts[2];
      try {
        const derivedKey = scryptSync(candidatePassword, salt, 64).toString('hex');
        return constantTimeCompare(derivedKey, expectedKeyHex);
      } catch {
        return false;
      }
    }
  }

  // Fallback for plaintext passwords (legacy or plain string configs)
  return constantTimeCompare(candidatePassword, storedPasswordOrHash);
}

/**
 * Parses raw Cookie header string into key-value map.
 */
export function parseCookies(cookieHeader?: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) {
      try {
        cookies[key] = decodeURIComponent(val);
      } catch {
        cookies[key] = val;
      }
    }
  }
  return cookies;
}

/**
 * Creates a tamper-proof signed session token using HMAC-SHA256.
 * Format: `<base64url(username)>.<expiresAtTimestamp>.<hmacSignature>`
 */
export function createSessionToken(username: string, secret: string, durationMs = DEFAULT_SESSION_DURATION_MS): string {
  const expiresAt = Date.now() + durationMs;
  const userPayload = Buffer.from(username, 'utf8').toString('base64url');
  const data = `${userPayload}.${expiresAt}`;
  const signature = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${signature}`;
}

/**
 * Verifies a signed session token in constant time.
 * Returns the authenticated username if valid and non-expired, or null otherwise.
 */
export function verifySessionToken(token: string, secret: string, expectedUser?: string): string | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [userPayload, expiresStr, providedSignature] = parts;
  const data = `${userPayload}.${expiresStr}`;
  const expectedSignature = createHmac('sha256', secret).update(data).digest('base64url');

  if (!constantTimeCompare(providedSignature, expectedSignature)) {
    return null;
  }

  const expiresAt = Number.parseInt(expiresStr, 10);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
    return null; // Expired
  }

  let username: string;
  try {
    username = Buffer.from(userPayload, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  if (expectedUser && !constantTimeCompare(username, expectedUser)) {
    return null;
  }

  return username;
}

/**
 * Resolves the authentication options against environment variables.
 */
export function resolveAuthConfig(
  optionsAuth?: boolean | AuthConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAuthConfig {
  // Check if explicitly disabled via options or environment variable
  const envDisabled =
    ['0', 'false', 'no', 'off'].includes(String(env.ADMINDB_AUTH ?? '').trim().toLowerCase()) ||
    ['1', 'true', 'yes'].includes(String(env.ADMINDB_NO_AUTH ?? env.ADMINDB_DISABLE_AUTH ?? '').trim().toLowerCase());

  let enabled = true;
  let username = env.ADMINDB_USERNAME ? String(env.ADMINDB_USERNAME).trim() : DEFAULT_USERNAME;
  let password = env.ADMINDB_PASSWORD ? String(env.ADMINDB_PASSWORD).trim() : DEFAULT_PASSWORD_HASH;
  let secret = env.ADMINDB_SECRET ? String(env.ADMINDB_SECRET).trim() : PROCESS_FALLBACK_SECRET;
  let sessionDurationMs = DEFAULT_SESSION_DURATION_MS;

  if (optionsAuth === false || envDisabled) {
    enabled = false;
  } else if (typeof optionsAuth === 'object' && optionsAuth !== null) {
    if (optionsAuth.enabled === false) enabled = false;
    if (optionsAuth.username !== undefined) username = String(optionsAuth.username).trim();
    if (optionsAuth.password !== undefined) password = String(optionsAuth.password).trim();
    if (optionsAuth.secret !== undefined) secret = String(optionsAuth.secret).trim();
    if (optionsAuth.sessionDurationMs !== undefined) sessionDurationMs = optionsAuth.sessionDurationMs;
  }

  const isDefaultPassword =
    username === DEFAULT_USERNAME &&
    (password === DEFAULT_PASSWORD_HASH || password === 'admin');

  return {
    enabled,
    username,
    password,
    secret,
    sessionDurationMs,
    isDefaultPassword,
  };
}

/**
 * Checks incoming request headers and cookies for valid authentication.
 */
export function authenticateRequest(
  req: Request,
  config: ResolvedAuthConfig,
): { authenticated: boolean; user?: string } {
  if (!config.enabled) {
    return { authenticated: true, user: 'anonymous' };
  }

  // 1. Check HTTP Authorization header (Basic or Bearer)
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const [scheme, credentials] = authHeader.split(/\s+/, 2);
    if (scheme && credentials) {
      if (scheme.toLowerCase() === 'basic') {
        try {
          const decoded = Buffer.from(credentials, 'base64').toString('utf8');
          const colonIdx = decoded.indexOf(':');
          if (colonIdx !== -1) {
            const user = decoded.slice(0, colonIdx);
            const pass = decoded.slice(colonIdx + 1);
            if (constantTimeCompare(user, config.username) && verifyPassword(pass, config.password)) {
              return { authenticated: true, user };
            }
          }
        } catch {
          // Ignore parse errors
        }
      } else if (scheme.toLowerCase() === 'bearer') {
        const user = verifySessionToken(credentials, config.secret, config.username);
        if (user) {
          return { authenticated: true, user };
        }
        // Direct password comparison as bearer token
        if (verifyPassword(credentials, config.password)) {
          return { authenticated: true, user: config.username };
        }
      }
    }
  }

  // 2. Check Cookie session
  const cookies = parseCookies(req.headers.cookie);
  const sessionCookie = cookies[SESSION_COOKIE_NAME];
  if (sessionCookie) {
    const user = verifySessionToken(sessionCookie, config.secret, config.username);
    if (user) {
      return { authenticated: true, user };
    }
  }

  return { authenticated: false };
}

/**
 * Express middleware to protect routes.
 */
export function createAuthMiddleware(
  config: ResolvedAuthConfig,
  basePath: string,
  _logger: Logger,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Expose auth state to templates
    res.locals.authEnabled = config.enabled;
    res.locals.isDefaultPassword = config.isDefaultPassword;

    if (!config.enabled) {
      res.locals.authUser = null;
      return next();
    }

    const p = req.path;

    // Public static assets and auth endpoints bypass authentication
    if (
      p.startsWith('/css/') ||
      p.startsWith('/js/') ||
      p === '/favicon.ico' ||
      p === '/login' ||
      p === '/logout'
    ) {
      return next();
    }

    const auth = authenticateRequest(req, config);
    if (auth.authenticated && auth.user) {
      res.locals.authUser = auth.user;
      (req as unknown as { user?: string }).user = auth.user;
      return next();
    }

    // Unauthenticated: API requests get 401 JSON
    if (p.startsWith('/api/') || req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      res.setHeader('WWW-Authenticate', 'Basic realm="AdminDB", Bearer');
      res.status(401).json({
        success: false,
        error: 'Authentication required. Please log in or provide valid credentials.',
      });
      return;
    }

    // Web UI: Redirect to login with return path
    const returnUrl = req.originalUrl || `${basePath}${req.url}`;
    const loginUrl = `${basePath}/login${returnUrl && returnUrl !== `${basePath}/` ? `?next=${encodeURIComponent(returnUrl)}` : ''}`;
    res.redirect(loginUrl);
  };
}

/**
 * Registers /login and /logout routes.
 */
export function registerAuthRoutes(
  router: Router,
  config: ResolvedAuthConfig,
  basePath: string,
  logger: Logger,
): void {
  // GET /login - render login screen
  router.get('/login', (req: Request, res: Response) => {
    if (!config.enabled) {
      return res.redirect(`${basePath}/`);
    }

    const auth = authenticateRequest(req, config);
    if (auth.authenticated) {
      const nextUrl = String(req.query.next ?? '').trim();
      return res.redirect(nextUrl.startsWith('/') ? nextUrl : `${basePath}/`);
    }

    const nextUrl = String(req.query.next ?? '').trim();
    res.render('pages/login', {
      title: 'Sign in',
      noSidebar: true,
      next: nextUrl.startsWith('/') ? nextUrl : '',
      isDefaultPassword: config.isDefaultPassword,
      error: req.query.error ? String(req.query.error) : null,
    });
  });

  // POST /login - process login submission
  router.post('/login', (req: Request, res: Response) => {
    if (!config.enabled) {
      return res.redirect(`${basePath}/`);
    }

    const username = String(req.body?.username ?? '').trim();
    const password = String(req.body?.password ?? '').trim();
    const nextUrl = String(req.body?.next ?? req.query.next ?? '').trim();

    const isValid =
      constantTimeCompare(username, config.username) &&
      verifyPassword(password, config.password);

    if (!isValid) {
      logger.warn(`Failed login attempt for user "${username || '<empty>'}"`);
      if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.status(401).json({ success: false, error: 'Invalid username or password.' });
      }
      return res.status(401).render('pages/login', {
        title: 'Sign in',
        noSidebar: true,
        username,
        next: nextUrl.startsWith('/') ? nextUrl : '',
        isDefaultPassword: config.isDefaultPassword,
        error: 'Invalid username or password. Please check your credentials.',
      });
    }

    // Successful authentication: issue signed session cookie
    const token = createSessionToken(config.username, config.secret, config.sessionDurationMs);
    const maxAgeSec = Math.floor(config.sessionDurationMs / 1000);
    const cookiePath = basePath || '/';

    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=${cookiePath}; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax`,
    );

    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.json({ success: true, message: 'Logged in successfully.', user: config.username, token });
    }

    const target = nextUrl.startsWith('/') ? nextUrl : `${basePath}/`;
    res.redirect(target);
  });

  // POST & GET /logout - clear session and redirect to login
  const handleLogout = (req: Request, res: Response) => {
    const cookiePath = basePath || '/';
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE_NAME}=; Path=${cookiePath}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax`,
    );

    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.json({ success: true, message: 'Logged out successfully.' });
    }

    res.redirect(`${basePath}/login`);
  };

  router.post('/logout', handleLogout);
  router.get('/logout', handleLogout);
}
