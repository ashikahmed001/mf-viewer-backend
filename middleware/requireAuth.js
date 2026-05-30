import { getAuth } from '@clerk/express';

/**
 * Express middleware — rejects requests that don't carry a valid Clerk session token.
 * Attach after clerkMiddleware() in server.js.
 */
export function requireAuth(req, res, next) {
  const { userId } = getAuth(req);
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorised — please sign in' });
  }
  next();
}
