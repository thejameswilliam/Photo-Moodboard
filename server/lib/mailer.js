import fs from 'node:fs/promises';
import path from 'node:path';

import nodemailer from 'nodemailer';

export function createMailer(config) {
  const hasMailgunConfig = Boolean(
    config.mailgun.apiKey
    && config.mailgun.domain
    && config.mailgun.from,
  );
  const hasSmtpConfig = Boolean(
    config.smtp.host
    && config.smtp.port
    && config.smtp.from
    && (
      (config.smtp.user && config.smtp.pass)
      || !config.isProduction
    ),
  );
  const transport = hasSmtpConfig
    ? nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? {
        user: config.smtp.user,
        pass: config.smtp.pass,
      } : undefined,
    })
    : null;

  return {
    async sendMagicLinkEmail({ email, magicLinkUrl, expiresAt }) {
      const subject = 'Your Moodboard sign-in link';
      const text = [
        'Use this magic link to sign in to Moodboard:',
        '',
        magicLinkUrl,
        '',
        `This link expires at ${expiresAt}.`,
      ].join('\n');
      const html = [
        '<p>Use this magic link to sign in to Moodboard:</p>',
        `<p><a href="${escapeHtml(magicLinkUrl)}">${escapeHtml(magicLinkUrl)}</a></p>`,
        `<p>This link expires at ${escapeHtml(expiresAt)}.</p>`,
      ].join('');

      if (hasMailgunConfig) {
        await sendWithMailgun(config, {
          to: email,
          subject,
          text,
          html,
        });

        return { previewUrl: null };
      }

      if (transport) {
        await transport.sendMail({
          from: config.smtp.from,
          to: email,
          subject,
          text,
          html,
        });

        return { previewUrl: null };
      }

      if (config.isProduction) {
        const error = new Error('Magic-link email is not configured on this server.');
        error.statusCode = 500;
        throw error;
      }

      await fs.mkdir(config.devMailDir, { recursive: true });

      const fileName = `${Date.now()}-${sanitizeEmail(email)}.txt`;
      const filePath = path.join(config.devMailDir, fileName);
      await fs.writeFile(filePath, `${subject}\n\n${text}\n`, 'utf8');

      console.log(`Magic link preview for ${email}: ${magicLinkUrl}`);

      return {
        previewUrl: magicLinkUrl,
      };
    },
  };
}

async function sendWithMailgun(config, message) {
  const baseUrl = config.mailgun.region === 'eu'
    ? 'https://api.eu.mailgun.net'
    : 'https://api.mailgun.net';
  const endpoint = `${baseUrl}/v3/${encodeURIComponent(config.mailgun.domain)}/messages`;
  const body = new URLSearchParams({
    from: config.mailgun.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
  const credentials = Buffer
    .from(`api:${config.mailgun.apiKey}`, 'utf8')
    .toString('base64');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (response.ok) {
    return;
  }

  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text().catch(() => '');
  const detail = typeof payload === 'string'
    ? payload
    : payload?.message || payload?.error || 'Unknown Mailgun error.';
  const error = new Error(`Mailgun email delivery failed. ${detail}`);
  error.statusCode = 502;
  throw error;
}

function sanitizeEmail(email) {
  return email.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'email';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
