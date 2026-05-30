import { getAuth, clerkClient } from '@clerk/express';

/**
 * Admin-only middleware.
 * Checks that the signed-in user's primary email matches ADMIN_EMAIL in .env.
 */
export async function requireAdmin(req, res, next) {
  const { userId } = getAuth(req);
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) {
    return res.status(500).json({ error: 'ADMIN_EMAIL not configured on server' });
  }

  try {
    const user = await clerkClient.users.getUser(userId);
    const primaryEmail = user.emailAddresses?.find(e => e.id === user.primaryEmailAddressId)?.emailAddress;
    if (primaryEmail !== adminEmail) {
      return res.status(403).json({ error: 'Forbidden — admin only' });
    }
    req.adminUser = { userId, email: primaryEmail };
    next();
  } catch (err) {
    return res.status(500).json({ error: 'Failed to verify admin identity' });
  }
}
