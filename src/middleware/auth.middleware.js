const { verifyToken } = require('../utils/jwt');

function authMiddleware(req, res, next) {
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

    req.user = {
      id: Number(payload.sub),
      email: payload.email || payload.workspace_email || null,
    };

    if (!Number.isInteger(req.user.id) || req.user.id <= 0) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    return next();
  } catch {
    return res.status(401).json({ message: 'Unauthorized' });
  }
}

module.exports = { authMiddleware };
