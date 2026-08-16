function getFrontendUrl() {
  return process.env.FRONTEND_URL || 'http://localhost:5173';
}

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function validateEnv() {
  const warnings = [];
  const errors = [];

  if (!process.env.JWT_SECRET) {
    errors.push('JWT_SECRET is required');
  } else if (String(process.env.JWT_SECRET).length < 32) {
    const message = 'JWT_SECRET should be at least 32 characters';
    if (isProduction()) {
      errors.push(message);
    } else {
      warnings.push(message);
    }
  }

  if (!process.env.FRONTEND_URL) {
    warnings.push('FRONTEND_URL is not set — password reset links will use http://localhost:5173');
  } else if (isProduction() && !process.env.FRONTEND_URL.startsWith('https://')) {
    warnings.push('FRONTEND_URL should use https:// in production');
  }

  const sendGridReady = Boolean(
    process.env.SENDGRID_API_KEY && process.env.EMAIL_FROM
  );

  if (!sendGridReady) {
    const message =
      'SendGrid is not configured (SENDGRID_API_KEY and EMAIL_FROM required for password reset emails)';
    if (isProduction()) {
      errors.push(message);
    } else {
      warnings.push(`${message} — reset emails will not be sent`);
    }
  }

  return { warnings, errors, sendGridReady };
}

function logEnvStatus() {
  const { warnings, errors, sendGridReady } = validateEnv();

  warnings.forEach((message) => console.warn(`⚠️  ${message}`));

  if (errors.length > 0) {
    errors.forEach((message) => console.error(`❌ ${message}`));
    if (isProduction()) {
      console.error('Fix the environment variables above before running in production.');
      process.exit(1);
    }
  }

  if (sendGridReady) {
    console.log('✅ SendGrid email configured');
  }

  console.log(`✅ Reset links will point to: ${getFrontendUrl()}`);
}

module.exports = {
  getFrontendUrl,
  isProduction,
  validateEnv,
  logEnvStatus,
};
