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

function contactInbox() {
  return process.env.CONTACT_TO || process.env.EMAIL_FROM;
}

function buildContactEmail({ name, email, subject, message }) {
  const fromEmail = process.env.EMAIL_FROM;
  const appName = process.env.APP_NAME || 'SyncSpace';

  return {
    to: contactInbox(),
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

function buildContactConfirmationEmail({ name, email, subject, message }) {
  const fromEmail = process.env.EMAIL_FROM;
  const appName = process.env.APP_NAME || 'SyncSpace';

  return {
    to: email,
    from: {
      email: fromEmail,
      name: appName,
    },
    replyTo: fromEmail,
    subject: `We received your message — ${appName}`,
    text: [
      `Hi ${name},`,
      '',
      `Thanks for contacting ${appName}. We received your message and will get back to you shortly.`,
      '',
      `Subject: ${subject}`,
      '',
      message,
      '',
      `— The ${appName} team`,
    ].join('\n'),
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827; max-width: 560px; margin: 0 auto; padding: 24px;">
        <h2 style="margin: 0 0 16px;">We received your message</h2>
        <p>Hi ${escapeHtml(name)},</p>
        <p>Thanks for contacting <strong>${escapeHtml(appName)}</strong>. We received your message and will get back to you shortly.</p>
        <p><strong>Subject:</strong> ${escapeHtml(subject)}</p>
        <p style="white-space: pre-wrap; margin-top: 16px; padding: 16px; background: #f3f4f6; border-radius: 12px;">${escapeHtml(message)}</p>
        <p style="font-size: 14px; color: #6b7280;">— The ${escapeHtml(appName)} team</p>
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
  const inbox = contactInbox();

  try {
    const [response] = await sgMail.send(buildContactEmail(payload));
    const messageId = response?.headers?.['x-message-id'];
    console.log(
      `Contact form emailed to ${inbox}${messageId ? ` (id: ${messageId})` : ''} from ${payload.email}`
    );
  } catch (err) {
    const details = err.response?.body?.errors?.[0]?.message || err.message;
    console.error('SendGrid contact error:', details);
    if (err.response?.body) {
      console.error('SendGrid details:', JSON.stringify(err.response.body, null, 2));
    }
    throw new Error('Failed to send contact message');
  }

  const submitter = String(payload.email || '').toLowerCase();
  const inboxNorm = String(inbox || '').toLowerCase();
  if (submitter && submitter !== inboxNorm) {
    try {
      const [confirm] = await sgMail.send(buildContactConfirmationEmail(payload));
      const confirmId = confirm?.headers?.['x-message-id'];
      console.log(
        `Contact confirmation emailed to ${payload.email}${confirmId ? ` (id: ${confirmId})` : ''}`
      );
    } catch (err) {
      const details = err.response?.body?.errors?.[0]?.message || err.message;
      console.error('SendGrid contact confirmation error:', details);
    }
  }

  return { delivered: true, logged: true };
}

function logInvite({ to, workspaceName, role }) {
  console.log('\n--- Workspace invitation ---');
  console.log(`To: ${to}`);
  console.log(`Workspace: ${workspaceName}`);
  console.log(`Role: ${role}`);
  console.log('----------------------------\n');
}

function buildInviteEmail({
  to,
  workspaceName,
  role,
  invitedByName,
  acceptUrl,
}) {
  const fromEmail = process.env.EMAIL_FROM;
  const appName = process.env.APP_NAME || 'SyncSpace';
  const safeWorkspace = escapeHtml(workspaceName);
  const safeRole = escapeHtml(role);
  const safeInviter = escapeHtml(invitedByName || 'A teammate');
  const safeUrl = escapeHtml(acceptUrl);

  return {
    to,
    from: {
      email: fromEmail,
      name: appName,
    },
    replyTo: fromEmail,
    subject: `You're invited to join ${workspaceName} on ${appName}`,
    text: [
      `${invitedByName || 'A teammate'} invited you to join “${workspaceName}” on ${appName} as ${role}.`,
      '',
      `Open this link to accept the invitation (same browser tab):`,
      acceptUrl,
      '',
      'Sign in with the invited email if asked, then tap Accept invitation.',
      '',
      'If you were not expecting this invitation, you can ignore this email.',
    ].join('\n'),
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827; max-width: 560px; margin: 0 auto; padding: 24px;">
        <h2 style="margin: 0 0 16px;">You're invited to ${safeWorkspace}</h2>
        <p><strong>${safeInviter}</strong> invited you to join <strong>${safeWorkspace}</strong> as <strong>${safeRole}</strong>.</p>
        <p style="margin: 24px 0;">
          <a href="${safeUrl}" style="display:inline-block;background:#1A4A6E;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:600;">
            Accept invitation
          </a>
        </p>
        <p style="font-size: 14px; color: #6b7280;">
          Opens in this browser. Sign in with <strong>${escapeHtml(to)}</strong> if needed, then accept — you’ll be added as a member right away.
        </p>
        <p style="font-size: 13px; color: #9ca3af; word-break: break-all;">${safeUrl}</p>
      </div>
    `,
    trackingSettings: {
      clickTracking: { enable: false },
      openTracking: { enable: false },
    },
  };
}

/**
 * Send a workspace invite email. When SendGrid is missing, logs and resolves
 * so local invites still succeed.
 */
async function sendWorkspaceInviteEmail(payload) {
  logInvite(payload);

  if (!isSendGridConfigured()) {
    console.warn(
      'SendGrid is not configured — invitation logged only (set SENDGRID_API_KEY and EMAIL_FROM to email).'
    );
    return { delivered: false, logged: true };
  }

  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  try {
    const [response] = await sgMail.send(buildInviteEmail(payload));
    const messageId = response?.headers?.['x-message-id'];
    console.log(
      `Workspace invite emailed to ${payload.to}${messageId ? ` (id: ${messageId})` : ''}`
    );
    return { delivered: true, logged: true };
  } catch (err) {
    const details = err.response?.body?.errors?.[0]?.message || err.message;
    console.error('SendGrid invite error:', details);
    if (err.response?.body) {
      console.error('SendGrid details:', JSON.stringify(err.response.body, null, 2));
    }
    throw new Error('Failed to send invitation email');
  }
}

function buildLoginAlertEmail({ to, name, ip, userAgent, when }) {
  const fromEmail = process.env.EMAIL_FROM;
  const appName = process.env.APP_NAME || 'SyncSpace';
  const safeName = escapeHtml(name || 'there');
  const safeIp = escapeHtml(ip || 'Unknown');
  const safeUa = escapeHtml(userAgent || 'Unknown device');
  const safeWhen = escapeHtml(when || new Date().toUTCString());

  return {
    to,
    from: {
      email: fromEmail,
      name: appName,
    },
    replyTo: fromEmail,
    subject: `New sign-in to your ${appName} account`,
    text: [
      `Hi ${name || 'there'},`,
      '',
      `We noticed a sign-in to your ${appName} account from a new device or location.`,
      '',
      `When: ${when}`,
      `IP: ${ip || 'Unknown'}`,
      `Device: ${userAgent || 'Unknown device'}`,
      '',
      'If this was you, you can ignore this email.',
      'If you did not sign in, reset your password and disable any compromised sessions.',
    ].join('\n'),
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827; max-width: 560px; margin: 0 auto; padding: 24px;">
        <h2 style="margin: 0 0 16px;">New sign-in detected</h2>
        <p>Hi ${safeName},</p>
        <p>We noticed a sign-in to your <strong>${escapeHtml(appName)}</strong> account from a new device or location.</p>
        <ul style="font-size: 14px; color: #374151; padding-left: 18px;">
          <li><strong>When:</strong> ${safeWhen}</li>
          <li><strong>IP:</strong> ${safeIp}</li>
          <li><strong>Device:</strong> ${safeUa}</li>
        </ul>
        <p style="font-size: 14px; color: #6b7280;">If this was you, no action is needed. If it wasn’t, reset your password right away.</p>
      </div>
    `,
    trackingSettings: {
      clickTracking: { enable: false },
      openTracking: { enable: false },
    },
  };
}

async function sendLoginAlertEmail(payload) {
  if (!isSendGridConfigured()) {
    console.warn(
      `Login alert for ${payload.to} (SendGrid not configured): ${payload.ip || 'unknown IP'}`
    );
    return { delivered: false, logged: true };
  }

  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  try {
    const [response] = await sgMail.send(buildLoginAlertEmail(payload));
    const messageId = response?.headers?.['x-message-id'];
    console.log(
      `Login alert emailed to ${payload.to}${messageId ? ` (id: ${messageId})` : ''}`
    );
    return { delivered: true, logged: true };
  } catch (err) {
    const details = err.response?.body?.errors?.[0]?.message || err.message;
    console.error('SendGrid login alert error:', details);
    // Don't fail the login if email delivery fails.
    return { delivered: false, logged: true, error: details };
  }
}

module.exports = {
  sendPasswordResetOtpEmail,
  sendContactEmail,
  sendWorkspaceInviteEmail,
  sendLoginAlertEmail,
  isSendGridConfigured,
};
