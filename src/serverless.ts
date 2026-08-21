import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createRouter, type AppOptions } from './app';

/**
 * Detects if the current process is running in a serverless environment
 * (e.g. Vercel, AWS Lambda, Netlify Functions, Google Cloud Functions/Run, Azure Functions, Cloudflare Pages).
 */
export function isServerlessEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  // Explicit serverless flags
  if (
    ['1', 'true', 'yes', 'on'].includes(
      String(env.ADMINDB_SERVERLESS ?? env.SERVERLESS ?? env.IS_SERVERLESS ?? '').trim().toLowerCase()
    )
  ) {
    return true;
  }

  // Vercel Serverless Functions
  if (Boolean(env.VERCEL || env.VERCEL_ENV || env.NOW_REGION)) {
    return true;
  }

  // AWS Lambda
  if (Boolean(env.AWS_LAMBDA_FUNCTION_NAME || env.LAMBDA_TASK_ROOT || env.AWS_EXECUTION_ENV)) {
    return true;
  }

  // Netlify Functions
  if (Boolean(env.NETLIFY || env.NETLIFY_LOCAL)) {
    return true;
  }

  // Google Cloud Functions / Cloud Run
  if (Boolean(env.FUNCTION_TARGET || env.FUNCTION_NAME || env.K_SERVICE)) {
    return true;
  }

  // Azure Functions
  if (Boolean(env.FUNCTIONS_WORKER_RUNTIME || env.WEBSITE_INSTANCE_ID)) {
    return true;
  }

  // Cloudflare Pages
  if (Boolean(env.CF_PAGES)) {
    return true;
  }

  return false;
}

/**
 * Creates an HTTP request listener for standard Node.js serverless runtimes
 * (Vercel API routes, Next.js custom route handlers, Google Cloud Functions, Azure Functions, Micro).
 *
 * In serverless mode, all write operations and database mutations are strictly disabled.
 *
 * Example (Vercel `api/index.ts`):
 * ```ts
 * import { createServerlessHandler } from 'admindb';
 * export default createServerlessHandler({ dbPath: './data.db' });
 * ```
 */
export function createServerlessHandler(
  options: AppOptions = {}
): (req: IncomingMessage, res: ServerResponse) => void {
  const app = createRouter({
    ...options,
    serverless: options.serverless ?? true,
    readonly: options.readonly ?? true,
  });

  return (req: IncomingMessage, res: ServerResponse) => {
    app(req, res);
  };
}

export interface LambdaProxyResult {
  statusCode: number;
  headers: Record<string, string>;
  multiValueHeaders?: Record<string, string[]>;
  body: string;
  isBase64Encoded: boolean;
}

/**
 * Creates an AWS Lambda handler for API Gateway (REST v1 and HTTP v2 payloads).
 *
 * In serverless mode, all write operations and database mutations are strictly disabled.
 *
 * Example (AWS Lambda `index.ts`):
 * ```ts
 * import { createLambdaHandler } from 'admindb';
 * export const handler = createLambdaHandler({ dbPath: './data.db' });
 * ```
 */
export function createLambdaHandler(options: AppOptions = {}) {
  const app = createRouter({
    ...options,
    serverless: options.serverless ?? true,
    readonly: options.readonly ?? true,
  });

  return async (event: any, _context?: any): Promise<LambdaProxyResult> => {
    return new Promise<LambdaProxyResult>((resolve) => {
      try {
        const isV2 = Boolean(event.version === '2.0' || event.rawPath);
        const method = (
          isV2
            ? event.requestContext?.http?.method
            : event.httpMethod
        ) || 'GET';

        const rawPath = isV2 ? (event.rawPath || '/') : (event.path || '/');
        const qs = isV2
          ? (event.rawQueryString || '')
          : (event.queryStringParameters
              ? Object.entries(event.queryStringParameters)
                  .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
                  .join('&')
              : '');

        const url = qs ? `${rawPath}?${qs}` : rawPath;

        const rawHeaders = event.headers || {};
        const headers: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(rawHeaders)) {
          if (v !== undefined && v !== null) {
            headers[k.toLowerCase()] = String(v);
          }
        }
        if (event.cookies && Array.isArray(event.cookies) && !headers['cookie']) {
          headers['cookie'] = event.cookies.join('; ');
        }

        // Prepare request body
        let bodyBuffer: Buffer | null = null;
        if (event.body) {
          if (event.isBase64Encoded) {
            bodyBuffer = Buffer.from(event.body, 'base64');
          } else {
            bodyBuffer = Buffer.from(event.body, 'utf8');
          }
          if (!headers['content-length']) {
            headers['content-length'] = String(bodyBuffer.length);
          }
        }

        const socket = new Socket();
        const req = new IncomingMessage(socket);
        req.url = url;
        req.method = method;
        req.headers = headers as any;
        req.httpVersion = '1.1';
        req.httpVersionMajor = 1;
        req.httpVersionMinor = 1;

        if (bodyBuffer) {
          req.push(bodyBuffer);
        }
        req.push(null);

        const res = new ServerResponse(req);
        const chunks: Buffer[] = [];

        res.write = function (chunk: any, ...args: any[]): boolean {
          if (chunk) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const cb = typeof args[0] === 'function' ? args[0] : typeof args[1] === 'function' ? args[1] : undefined;
          if (cb) cb();
          return true;
        } as any;

        res.end = function (chunk?: any, ...args: any[]): ServerResponse {
          if (chunk && typeof chunk !== 'function') {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const cb =
            typeof chunk === 'function'
              ? chunk
              : typeof args[0] === 'function'
              ? args[0]
              : typeof args[1] === 'function'
              ? args[1]
              : undefined;
          if (cb) cb();

          const responseHeaders: Record<string, string> = {};
          const multiValueHeaders: Record<string, string[]> = {};

          const resHeaders = res.getHeaders();
          for (const [k, v] of Object.entries(resHeaders)) {
            if (Array.isArray(v)) {
              multiValueHeaders[k] = v.map(String);
              responseHeaders[k] = v.map(String).join(', ');
            } else if (v !== undefined) {
              responseHeaders[k] = String(v);
            }
          }

          const fullBody = Buffer.concat(chunks);
          const contentType = String(responseHeaders['content-type'] || '');
          const isBinary =
            !contentType.startsWith('text/') &&
            !contentType.includes('application/json') &&
            !contentType.includes('application/javascript') &&
            !contentType.includes('application/xml') &&
            !contentType.includes('image/svg+xml');

          resolve({
            statusCode: res.statusCode || 200,
            headers: responseHeaders,
            multiValueHeaders: Object.keys(multiValueHeaders).length > 0 ? multiValueHeaders : undefined,
            body: isBinary ? fullBody.toString('base64') : fullBody.toString('utf8'),
            isBase64Encoded: isBinary,
          });

          return res;
        } as any;

        app(req, res);
      } catch (err: any) {
        resolve({
          statusCode: 500,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ success: false, error: err?.message || 'Server error' }),
          isBase64Encoded: false,
        });
      }
    });
  };
}
