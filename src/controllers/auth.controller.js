const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { signToken, verifyToken } = require('../utils/jwt');
const { generateOtp, hashOtp } = require('../utils/otp');
const { sendPasswordResetOtpEmail } = require('../utils/mail');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 6;
const OTP_EXPIRY_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const RESET_TOKEN_EXPIRY = '15m';
function pickField(body, ...keys) {
  for (const key of keys) {
    if (body[key] !== undefined && body[key] !== null) {
      return body[key];
    }
  }
  return undefined;
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
      `SELECT id, full_name, workspace_email, password_hash
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

    const token = signToken({
      sub: user.id,
      email: user.workspace_email,
    });

    return res.status(200).json({
      token,
      user: {
        id: user.id,
        name: user.full_name,
        email: user.workspace_email,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ message: 'Login failed' });
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

module.exports = { register, login, forgotPassword, verifyOtp, resetPassword };
