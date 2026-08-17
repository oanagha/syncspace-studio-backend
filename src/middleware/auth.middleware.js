const { verifyToken } = require('../utils/jwt');
const { getActiveSession, touchSession } = require('../utils/sessions');

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  try {
    const payload = verifyToken(token);

    if (payload.purpose === 'password_reset' || payload.purpose === '2fa_pending' || !payload.sub) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const userId = Number(payload.sub);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    let sessionId = typeof payload.jti === 'string' && payload.jti ? payload.jti : null;
    if (sessionId) {
      const session = await getActiveSession(sessionId, userId);
      if (!session) {
        return res.status(401).json({ message: 'Session expired. Please sign in again.' });
      }
      sessionId = session.id;
      touchSession(sessionId).catch(() => undefined);
    }

    req.user = {
      id: userId,
      email: payload.email || payload.workspace_email || null,
      sessionId,
    };

    return next();
  } catch {
    return res.status(401).json({ message: 'Unauthorized' });
  }
}

module.exports = { authMiddleware };
