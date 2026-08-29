import type { Request, Response, Router } from 'express';
import type { Logger } from '../utils/logger';
import { SESSION_COOKIE_NAME, type ResolvedAuthConfig } from './types';
import { authenticateRequest } from './middleware';
import { constantTimeCompare, createSessionToken, verifyPassword } from './crypto';

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
    if (!config.enabled) return res.redirect(`${basePath}/`);

    const auth = authenticateRequest(req, config);
    const nextUrl = String(req.query.next ?? '').trim();
    if (auth.authenticated) {
      return res.redirect(nextUrl.startsWith('/') ? nextUrl : `${basePath}/`);
    }

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
    if (!config.enabled) return res.redirect(`${basePath}/`);

    const username = String(req.body?.username ?? '').trim();
    const password = String(req.body?.password ?? '').trim();
    const nextUrl = String(req.body?.next ?? req.query.next ?? '').trim();

    const isValid = constantTimeCompare(username, config.username) && verifyPassword(password, config.password);

    if (!isValid) {
      logger.warn(`Failed login attempt for user "${username || '<empty>'}"`);
      if (req.xhr || req.headers.accept?.includes('application/json')) {
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

    const token = createSessionToken(config.username, config.secret, config.sessionDurationMs);
    const maxAgeSec = Math.floor(config.sessionDurationMs / 1000);
    const expiresUtc = new Date(Date.now() + config.sessionDurationMs).toUTCString();
    const cookiePath = basePath || '/';

    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=${cookiePath}; Max-Age=${maxAgeSec}; Expires=${expiresUtc}; HttpOnly; SameSite=Lax`,
    );

    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json({ success: true, message: 'Logged in successfully.', user: config.username, token });
    }

    res.redirect(nextUrl.startsWith('/') ? nextUrl : `${basePath}/`);
  });

  // POST & GET /logout - clear session and redirect to login
  const handleLogout = (req: Request, res: Response) => {
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE_NAME}=; Path=${basePath || '/'}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax`,
    );

    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json({ success: true, message: 'Logged out successfully.' });
    }

    res.redirect(`${basePath}/login`);
  };

  router.post('/logout', handleLogout);
  router.get('/logout', handleLogout);
}
