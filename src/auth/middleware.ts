import type { Request, Response, NextFunction } from 'express';
import type { Logger } from '../utils/logger';
import { SESSION_COOKIE_NAME, type ResolvedAuthConfig } from './types';
import { constantTimeCompare, parseCookies, verifyPassword, verifySessionToken } from './crypto';

/**
 * Checks incoming request headers and cookies for valid authentication.
 */
export function authenticateRequest(
  req: Request,
  config: ResolvedAuthConfig,
): { authenticated: boolean; user?: string } {
  if (!config.enabled) return { authenticated: true, user: 'anonymous' };

  // 1. Check HTTP Authorization header (Basic or Bearer)
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const [scheme, credentials] = authHeader.split(/\s+/, 2);
    if (scheme && credentials) {
      const lowerScheme = scheme.toLowerCase();
      if (lowerScheme === 'basic') {
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
          /* ignore parse error */
        }
      } else if (lowerScheme === 'bearer') {
        const user = verifySessionToken(credentials, config.secret, config.username);
        if (user) return { authenticated: true, user };
        if (verifyPassword(credentials, config.password)) {
          return { authenticated: true, user: config.username };
        }
      }
    }
  }

  // 2. Check Cookie session
  const sessionCookie = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
  if (sessionCookie) {
    const user = verifySessionToken(sessionCookie, config.secret, config.username);
    if (user) return { authenticated: true, user };
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
    res.locals.authEnabled = config.enabled;
    res.locals.isDefaultPassword = config.isDefaultPassword;

    if (!config.enabled) {
      res.locals.authUser = null;
      return next();
    }

    const p = req.path;
    // Public static assets and auth endpoints bypass authentication
    if (p.startsWith('/css/') || p.startsWith('/js/') || p === '/favicon.ico' || p === '/login' || p === '/logout') {
      return next();
    }

    const auth = authenticateRequest(req, config);
    if (auth.authenticated && auth.user) {
      res.locals.authUser = auth.user;
      (req as unknown as { user?: string }).user = auth.user;
      return next();
    }

    // Unauthenticated: API requests get 401 JSON
    if (p.startsWith('/api/') || req.xhr || req.headers.accept?.includes('application/json')) {
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
