const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('../config/db');
const { signToken, verifyToken } = require('../utils/jwt');
const { generateOtp, hashOtp } = require('../utils/otp');
const { sendPasswordResetOtpEmail, sendLoginAlertEmail } = require('../utils/mail');
const { generateSecret, verifyTotp, buildOtpAuthUrl } = require('../utils/totp');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 6;
const OTP_EXPIRY_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const RESET_TOKEN_EXPIRY = '15m';
const TWO_FA_CHALLENGE_EXPIRY = '5m';
const APP_ISSUER = process.env.APP_NAME || 'SyncSpace';

function pickField(body, ...keys) {
  for (const key of keys) {
    if (body[key] !== undefined && body[key] !== null) {
      return body[key];
    }
  }
  return undefined;
}

function clientIp(req) {
  if (process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true') {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',')[0].trim();
    }
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function loginFingerprint(ip, userAgent) {
  return crypto
    .createHash('sha256')
    .update(`${ip || ''}|${userAgent || ''}`)
    .digest('hex');
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.full_name,
    email: user.workspace_email,
  };
}

async function syncTwoFactorPreference(userId, enabled, client = pool) {
  await client.query(
    `INSERT INTO user_preferences (user_id, two_factor)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET two_factor = EXCLUDED.two_factor`,
    [userId, Boolean(enabled)]
  );
}

async function maybeSendLoginAlert(req, user) {
  const ip = clientIp(req);
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 500);
  const fingerprint = loginFingerprint(ip, userAgent);

  const prefResult = await pool.query(
    `SELECT login_alerts FROM user_preferences WHERE user_id = $1`,
    [user.id]
  );
  const loginAlerts =
    prefResult.rows.length === 0
      ? true
      : prefResult.rows[0].login_alerts !== false;

  const previous = user.last_login_fingerprint || null;
  const isNewDevice = !previous || previous !== fingerprint;

  await pool.query(
    `UPDATE users
     SET last_login_fingerprint = $2,
         last_login_at = NOW(),
         last_login_ip = $3,
         last_login_user_agent = $4,
         updated_at = NOW()
     WHERE id = $1`,
    [user.id, fingerprint, String(ip).slice(0, 64), userAgent || null]
  );

  if (loginAlerts && isNewDevice) {
    await sendLoginAlertEmail({
      to: user.workspace_email,
      name: user.full_name,
      ip,
      userAgent: userAgent || 'Unknown device',
      when: new Date().toUTCString(),
    });
  }
}

function issueSessionToken(user) {
  return signToken({
    sub: user.id,
    email: user.workspace_email,
  });
}

async function register(req, res) {
  const client = await pool.connect();

  try {
    const firstName = String(
      pickField(req.body, 'first_name', 'firstName') ?? ''
    ).trim();
    const lastName = String(
      pickField(req.body, 'last_name', 'lastName') ?? ''
    ).trim();
    const workspaceEmail = String(
      pickField(req.body, 'workspace_email', 'workspaceEmail', 'email') ?? ''
    ).trim();
    const workspaceName = String(
      pickField(req.body, 'workspace_name', 'workspaceName') ?? ''
    ).trim();
    const password = pickField(req.body, 'password') ?? '';
    const confirmPassword = pickField(
      req.body,
      'confirm_password',
      'confirmPassword'
    );

    if (!firstName) {
      return res.status(400).json({ message: 'First name is required' });
    }

    if (!lastName) {
      return res.status(400).json({ message: 'Last name is required' });
    }

    if (!workspaceEmail) {
      return res.status(400).json({ message: 'Workspace email is required' });
    }

    if (!EMAIL_RE.test(workspaceEmail)) {
      return res.status(400).json({ message: 'Invalid workspace email address' });
    }

    if (!workspaceName) {
      return res.status(400).json({ message: 'Workspace name is required' });
    }

    if (workspaceName.length < 3 || workspaceName.length > 100) {
      return res.status(400).json({
        message: 'Workspace name must be between 3 and 100 characters',
      });
    }

    if (!password || password.length < MIN_PASSWORD_LEN) {
      return res.status(400).json({
        message: `Password must be at least ${MIN_PASSWORD_LEN} characters`,
      });
    }

    if (!confirmPassword) {
      return res.status(400).json({ message: 'Confirm password is required' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ message: 'Passwords do not match' });
    }

    const normalizedEmail = workspaceEmail.toLowerCase();
    const fullName = `${firstName} ${lastName}`.trim();
    const passwordHash = await bcrypt.hash(password, 12);

    await client.query('BEGIN');

    const userResult = await client.query(
      `INSERT INTO users (full_name, workspace_email, workspace_name, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, full_name, workspace_email, workspace_name`,
      [fullName, normalizedEmail, workspaceName, passwordHash]
    );

    const user = userResult.rows[0];

    const workspaceResult = await client.query(
      `INSERT INTO workspaces (name, created_by)
       VALUES ($1, $2)
       RETURNING id, name, created_at`,
      [workspaceName, user.id]
    );

    const workspace = workspaceResult.rows[0];

    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, 'Owner')`,
      [workspace.id, user.id]
    );

    await client.query('COMMIT');

    const token = signToken({
      sub: user.id,
      workspace_email: user.workspace_email,
    });

    return res.status(201).json({
      message: 'Workspace account created successfully',
      token,
      user: {
        id: user.id,
        first_name: firstName,
        last_name: lastName,
        workspace_email: user.workspace_email,
        workspace_name: user.workspace_name,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');

    if (err.code === '23505') {
      return res.status(409).json({ message: 'Workspace email already exists' });
    }

    console.error('Registration error:', err);
    return res.status(500).json({ message: 'Registration failed' });
  } finally {
    client.release();
  }
}

async function login(req, res) {
  try {
    const email = String(pickField(req.body, 'email', 'workspace_email') ?? '').trim();
    const password = pickField(req.body, 'password') ?? '';

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    if (!password) {
      return res.status(400).json({ message: 'Password is required' });
    }

    const result = await pool.query(
      `SELECT id, full_name, workspace_email, password_hash, totp_enabled,
              totp_secret, last_login_fingerprint
       FROM users
       WHERE workspace_email = $1`,
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const user = result.rows[0];
    const passwordMatch = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    if (user.totp_enabled && user.totp_secret) {
      const challengeToken = signToken(
        {
          sub: user.id,
          email: user.workspace_email,
          purpose: '2fa_pending',
        },
        TWO_FA_CHALLENGE_EXPIRY
      );

      return res.status(200).json({
        requires2fa: true,
        challengeToken,
        message: 'Enter the 6-digit code from your authenticator app.',
      });
    }

    const token = issueSessionToken(user);
    await maybeSendLoginAlert(req, user);

    return res.status(200).json({
      token,
      user: publicUser(user),
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ message: 'Login failed' });
  }
}

async function verify2fa(req, res) {
  try {
    const challengeToken = String(
      pickField(req.body, 'challengeToken', 'challenge_token') ?? ''
    ).trim();
    const code = String(pickField(req.body, 'code', 'otp', 'token') ?? '').trim();

    if (!challengeToken) {
      return res.status(400).json({ message: 'Challenge token is required' });
    }
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ message: 'Enter a valid 6-digit code' });
    }

    let payload;
    try {
      payload = verifyToken(challengeToken);
    } catch {
      return res.status(401).json({ message: 'Challenge expired. Sign in again.' });
    }

    if (payload.purpose !== '2fa_pending' || !payload.sub) {
      return res.status(401).json({ message: 'Invalid challenge token' });
    }

    const result = await pool.query(
      `SELECT id, full_name, workspace_email, totp_enabled, totp_secret,
              last_login_fingerprint
       FROM users
       WHERE id = $1`,
      [Number(payload.sub)]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Invalid challenge token' });
    }

    const user = result.rows[0];
    if (!user.totp_enabled || !user.totp_secret) {
      return res.status(400).json({ message: 'Two-factor authentication is not enabled' });
    }

    if (!verifyTotp(user.totp_secret, code)) {
      return res.status(401).json({ message: 'Invalid authentication code' });
    }

    const token = issueSessionToken(user);
    await maybeSendLoginAlert(req, user);

    return res.status(200).json({
      token,
      user: publicUser(user),
    });
  } catch (err) {
    console.error('Verify 2FA error:', err);
    return res.status(500).json({ message: 'Two-factor verification failed' });
  }
}

async function get2faStatus(req, res) {
  try {
    const result = await pool.query(
      `SELECT totp_enabled FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    return res.status(200).json({
      enabled: Boolean(result.rows[0].totp_enabled),
    });
  } catch (err) {
    console.error('2FA status error:', err);
    return res.status(500).json({ message: 'Failed to load 2FA status' });
  }
}

async function setup2fa(req, res) {
  try {
    const userResult = await pool.query(
      `SELECT id, workspace_email, totp_enabled FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const user = userResult.rows[0];
    if (user.totp_enabled) {
      return res.status(400).json({ message: 'Two-factor authentication is already enabled' });
    }

    const secret = generateSecret();
    await pool.query(
      `UPDATE users SET totp_pending_secret = $2, updated_at = NOW() WHERE id = $1`,
      [user.id, secret]
    );

    const otpauthUrl = buildOtpAuthUrl({
      secret,
      email: user.workspace_email,
      issuer: APP_ISSUER,
    });

    return res.status(200).json({
      secret,
      otpauthUrl,
      qrUrl: `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(otpauthUrl)}`,
    });
  } catch (err) {
    console.error('2FA setup error:', err);
    return res.status(500).json({ message: 'Failed to start 2FA setup' });
  }
}

async function enable2fa(req, res) {
  try {
    const code = String(pickField(req.body, 'code', 'otp', 'token') ?? '').trim();
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ message: 'Enter a valid 6-digit code' });
    }

    const result = await pool.query(
      `SELECT id, totp_enabled, totp_pending_secret FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const user = result.rows[0];
    if (user.totp_enabled) {
      return res.status(400).json({ message: 'Two-factor authentication is already enabled' });
    }
    if (!user.totp_pending_secret) {
      return res.status(400).json({ message: 'Start 2FA setup before confirming the code' });
    }

    if (!verifyTotp(user.totp_pending_secret, code)) {
      return res.status(401).json({ message: 'Invalid authentication code' });
    }

    await pool.query(
      `UPDATE users
       SET totp_secret = totp_pending_secret,
           totp_pending_secret = NULL,
           totp_enabled = TRUE,
           updated_at = NOW()
       WHERE id = $1`,
      [user.id]
    );
    await syncTwoFactorPreference(user.id, true);

    return res.status(200).json({
      enabled: true,
      message: 'Two-factor authentication enabled',
    });
  } catch (err) {
    console.error('2FA enable error:', err);
    return res.status(500).json({ message: 'Failed to enable 2FA' });
  }
}

async function disable2fa(req, res) {
  try {
    const password = pickField(req.body, 'password') ?? '';
    const code = String(pickField(req.body, 'code', 'otp', 'token') ?? '').trim();

    if (!password) {
      return res.status(400).json({ message: 'Password is required to disable 2FA' });
    }

    const result = await pool.query(
      `SELECT id, password_hash, totp_enabled, totp_secret FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const user = result.rows[0];
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ message: 'Incorrect password' });
    }

    if (user.totp_enabled && user.totp_secret) {
      if (!/^\d{6}$/.test(code) || !verifyTotp(user.totp_secret, code)) {
        return res.status(401).json({ message: 'Invalid authentication code' });
      }
    }

    const required = await pool.query(
      `SELECT w.name
       FROM workspaces w
       INNER JOIN workspace_members wm ON wm.workspace_id = w.id
       WHERE wm.user_id = $1 AND w.require_2fa IS TRUE
       LIMIT 1`,
      [user.id]
    );
    if (required.rows.length) {
      return res.status(403).json({
        message: `“${required.rows[0].name}” requires two-factor authentication. Turn that workspace setting off first.`,
      });
    }

    await pool.query(
      `UPDATE users
       SET totp_secret = NULL,
           totp_pending_secret = NULL,
           totp_enabled = FALSE,
           updated_at = NOW()
       WHERE id = $1`,
      [user.id]
    );
    await syncTwoFactorPreference(user.id, false);

    return res.status(200).json({
      enabled: false,
      message: 'Two-factor authentication disabled',
    });
  } catch (err) {
    console.error('2FA disable error:', err);
    return res.status(500).json({ message: 'Failed to disable 2FA' });
  }
}

async function forgotPassword(req, res) {
  try {
    const email = String(pickField(req.body, 'email', 'workspace_email') ?? '').trim();

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ message: 'Invalid email address' });
    }

    const normalizedEmail = email.toLowerCase();
    const userResult = await pool.query(
      `SELECT id, workspace_email FROM users WHERE workspace_email = $1`,
      [normalizedEmail]
    );

    if (userResult.rows.length === 0) {
      if (process.env.NODE_ENV !== 'production') {
        console.log(`Password reset OTP requested for unknown email: ${normalizedEmail}`);
      }
    }

    if (userResult.rows.length > 0) {
      const user = userResult.rows[0];
      const otp = generateOtp();
      const otpHash = hashOtp(otp);
      const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

      await pool.query(
        `UPDATE password_reset_otps
         SET used_at = NOW()
         WHERE user_id = $1 AND used_at IS NULL`,
        [user.id]
      );

      await pool.query(
        `INSERT INTO password_reset_otps (user_id, otp_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [user.id, otpHash, expiresAt]
      );

      try {
        await sendPasswordResetOtpEmail({
          to: user.workspace_email,
          otp,
        });
      } catch (mailErr) {
        console.error('Failed to send OTP email:', mailErr.message);
        return res.status(500).json({ message: 'Failed to send verification code. Please try again later.' });
      }
    }

    return res.status(200).json({
      message: 'If an account exists for this email, a verification code has been sent.',
    });
  } catch (err) {
    console.error('Forgot password error:', err);
    return res.status(500).json({ message: 'Failed to process password reset request' });
  }
}

async function verifyOtp(req, res) {
  try {
    const email = String(pickField(req.body, 'email', 'workspace_email') ?? '').trim();
    const otp = String(pickField(req.body, 'otp') ?? '').trim();

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    if (!otp) {
      return res.status(400).json({ message: 'Verification code is required' });
    }

    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({ message: 'Verification code must be 6 digits' });
    }

    const normalizedEmail = email.toLowerCase();
    const userResult = await pool.query(
      `SELECT id FROM users WHERE workspace_email = $1`,
      [normalizedEmail]
    );

    if (userResult.rows.length === 0) {
      return res.status(400).json({ message: 'Invalid verification code' });
    }

    const userId = userResult.rows[0].id;
    const otpResult = await pool.query(
      `SELECT id, otp_hash, expires_at, attempts, used_at, verified_at
       FROM password_reset_otps
       WHERE user_id = $1 AND used_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId]
    );

    if (otpResult.rows.length === 0) {
      return res.status(400).json({ message: 'Invalid or expired verification code' });
    }

    const otpRecord = otpResult.rows[0];

    if (otpRecord.attempts >= OTP_MAX_ATTEMPTS) {
      return res.status(400).json({ message: 'Too many attempts. Request a new code.' });
    }

    if (new Date(otpRecord.expires_at) < new Date()) {
      return res.status(400).json({ message: 'Verification code has expired. Request a new one.' });
    }

    const otpHash = hashOtp(otp);
    if (otpHash !== otpRecord.otp_hash) {
      await pool.query(
        `UPDATE password_reset_otps SET attempts = attempts + 1 WHERE id = $1`,
        [otpRecord.id]
      );
      return res.status(400).json({ message: 'Invalid verification code' });
    }

    await pool.query(
      `UPDATE password_reset_otps SET verified_at = NOW() WHERE id = $1`,
      [otpRecord.id]
    );

    const resetToken = signToken(
      {
        sub: userId,
        purpose: 'password_reset',
        otpId: otpRecord.id,
      },
      RESET_TOKEN_EXPIRY
    );

    return res.status(200).json({
      message: 'Verification code confirmed',
      resetToken,
    });
  } catch (err) {
    console.error('Verify OTP error:', err);
    return res.status(500).json({ message: 'Failed to verify code' });
  }
}

async function resetPassword(req, res) {
  const client = await pool.connect();

  try {
    const resetToken = String(
      pickField(req.body, 'resetToken', 'reset_token', 'token') ?? ''
    ).trim();
    const password = pickField(req.body, 'password') ?? '';
    const confirmPassword = pickField(
      req.body,
      'confirm_password',
      'confirmPassword'
    );

    if (!resetToken) {
      return res.status(400).json({ message: 'Reset session expired. Please verify your code again.' });
    }

    if (!password || password.length < MIN_PASSWORD_LEN) {
      return res.status(400).json({
        message: `Password must be at least ${MIN_PASSWORD_LEN} characters`,
      });
    }

    if (!confirmPassword) {
      return res.status(400).json({ message: 'Confirm password is required' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ message: 'Passwords do not match' });
    }

    let payload;
    try {
      payload = verifyToken(resetToken);
    } catch {
      return res.status(400).json({ message: 'Reset session expired. Please verify your code again.' });
    }

    if (payload.purpose !== 'password_reset' || !payload.otpId) {
      return res.status(400).json({ message: 'Invalid reset session' });
    }

    await client.query('BEGIN');

    const otpResult = await client.query(
      `SELECT id, user_id, verified_at, used_at
       FROM password_reset_otps
       WHERE id = $1`,
      [payload.otpId]
    );

    if (
      otpResult.rows.length === 0 ||
      !otpResult.rows[0].verified_at ||
      otpResult.rows[0].used_at
    ) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Reset session expired. Please verify your code again.' });
    }

    const otpRecord = otpResult.rows[0];
    const passwordHash = await bcrypt.hash(password, 12);

    await client.query(
      `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [passwordHash, otpRecord.user_id]
    );

    await client.query(
      `UPDATE password_reset_otps SET used_at = NOW() WHERE id = $1`,
      [otpRecord.id]
    );

    await client.query(
      `UPDATE password_reset_otps SET used_at = NOW()
       WHERE user_id = $1 AND used_at IS NULL`,
      [otpRecord.user_id]
    );

    await client.query('COMMIT');

    return res.status(200).json({
      message: 'Password reset successfully. You can now sign in with your new password.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Reset password error:', err);
    return res.status(500).json({ message: 'Failed to reset password' });
  } finally {
    client.release();
  }
}

module.exports = {
  register,
  login,
  verify2fa,
  get2faStatus,
  setup2fa,
  enable2fa,
  disable2fa,
  forgotPassword,
  verifyOtp,
  resetPassword,
};
