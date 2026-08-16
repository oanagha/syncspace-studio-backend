const sgMail = require('@sendgrid/mail');
const { isProduction } = require('../config/env');

function isSendGridConfigured() {
  return Boolean(process.env.SENDGRID_API_KEY && process.env.EMAIL_FROM);
}

function shouldLogOtp() {
  return !isProduction() || process.env.LOG_RESET_LINKS === 'true';
}

function logOtp({ to, otp }) {
  if (!shouldLogOtp()) return;

  console.log('\n--- Password reset OTP ---');
  console.log(`To: ${to}`);
  console.log(`OTP: ${otp}`);
  console.log('--------------------------\n');
}

function buildOtpEmail({ to, otp }) {
  const fromEmail = process.env.EMAIL_FROM;
  const appName = process.env.APP_NAME || 'SyncSpace';

  return {
    to,
    from: {
      email: fromEmail,
      name: appName,
    },
    replyTo: fromEmail,
    subject: `Your ${appName} password reset code`,
    text: [
      `You requested a password reset for your ${appName} account.`,
      '',
      `Your verification code is: ${otp}`,
      '',
      'This code expires in 10 minutes.',
      'If you did not request this, you can ignore this email.',
    ].join('\n'),
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827; max-width: 560px; margin: 0 auto; padding: 24px;">
        <h2 style="margin: 0 0 16px;">Password reset code</h2>
        <p>You requested a password reset for your ${appName} account.</p>
        <p style="font-size: 32px; font-weight: 700; letter-spacing: 0.3em; margin: 24px 0;">${otp}</p>
        <p style="font-size: 14px; color: #6b7280;">Enter this code on the forgot password page. It expires in 10 minutes.</p>
        <p style="font-size: 14px; color: #6b7280;">If you did not request this, you can ignore this email.</p>
      </div>
    `,
    trackingSettings: {
      clickTracking: { enable: false },
      openTracking: { enable: false },
    },
    mailSettings: {
      sandboxMode: {
        enable: false,
      },
    },
  };
}

async function sendPasswordResetOtpEmail({ to, otp }) {
  logOtp({ to, otp });

  if (!isSendGridConfigured()) {
    const message =
      'Email service is not configured. Set SENDGRID_API_KEY and EMAIL_FROM on the server.';
    console.error(message);
    throw new Error(message);
  }

  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  try {
    const [response] = await sgMail.send(buildOtpEmail({ to, otp }));
    const messageId = response?.headers?.['x-message-id'];
    console.log(`Password reset OTP sent to ${to}${messageId ? ` (id: ${messageId})` : ''}`);
  } catch (err) {
    const details = err.response?.body?.errors?.[0]?.message || err.message;
    console.error('SendGrid error:', details);
    if (err.response?.body) {
      console.error('SendGrid details:', JSON.stringify(err.response.body, null, 2));
    }
    throw new Error('Failed to send verification code');
  }
}

function buildContactEmail({ name, email, subject, message }) {
  const fromEmail = process.env.EMAIL_FROM;
  const appName = process.env.APP_NAME || 'SyncSpace';
  const inbox = process.env.CONTACT_TO || fromEmail;

  return {
    to: inbox,
    from: {
      email: fromEmail,
      name: `${appName} Contact`,
    },
    replyTo: {
      email,
      name,
    },
    subject: `[${appName} Contact] ${subject}`,
    text: [
      `New contact form submission`,
      '',
      `Name: ${name}`,
      `Email: ${email}`,
      `Subject: ${subject}`,
      '',
      message,
    ].join('\n'),
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827; max-width: 560px; margin: 0 auto; padding: 24px;">
        <h2 style="margin: 0 0 16px;">New contact form submission</h2>
        <p><strong>Name:</strong> ${escapeHtml(name)}</p>
        <p><strong>Email:</strong> ${escapeHtml(email)}</p>
        <p><strong>Subject:</strong> ${escapeHtml(subject)}</p>
        <p style="white-space: pre-wrap; margin-top: 16px;">${escapeHtml(message)}</p>
      </div>
    `,
    trackingSettings: {
      clickTracking: { enable: false },
      openTracking: { enable: false },
    },
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function logContactSubmission(payload) {
  console.log('\n--- Contact form submission ---');
  console.log(`Name: ${payload.name}`);
  console.log(`Email: ${payload.email}`);
  console.log(`Subject: ${payload.subject}`);
  console.log(`Message: ${payload.message}`);
  console.log('------------------------------\n');
}

/**
 * Deliver contact form mail via existing SendGrid setup.
 * When SendGrid is not configured, logs the payload and resolves
 * so local development can continue without failing the request.
 */
async function sendContactEmail(payload) {
  logContactSubmission(payload);

  if (!isSendGridConfigured()) {
    console.warn(
      'SendGrid is not configured — contact form logged only (set SENDGRID_API_KEY and EMAIL_FROM to email).'
    );
    return { delivered: false, logged: true };
  }

  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  try {
    const [response] = await sgMail.send(buildContactEmail(payload));
    const messageId = response?.headers?.['x-message-id'];
    console.log(
      `Contact form emailed${messageId ? ` (id: ${messageId})` : ''} from ${payload.email}`
    );
    return { delivered: true, logged: true };
  } catch (err) {
    const details = err.response?.body?.errors?.[0]?.message || err.message;
    console.error('SendGrid contact error:', details);
    if (err.response?.body) {
      console.error('SendGrid details:', JSON.stringify(err.response.body, null, 2));
    }
    throw new Error('Failed to send contact message');
  }
}

module.exports = {
  sendPasswordResetOtpEmail,
  sendContactEmail,
  isSendGridConfigured,
};
