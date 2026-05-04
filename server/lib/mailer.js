import fs from 'node:fs/promises';
import path from 'node:path';

import nodemailer from 'nodemailer';

export function createMailer(config) {
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

      if (transport) {
        await transport.sendMail({
          from: config.smtp.from,
          to: email,
          subject,
          text,
          html: `
            <p>Use this magic link to sign in to Moodboard:</p>
            <p><a href="${escapeHtml(magicLinkUrl)}">${escapeHtml(magicLinkUrl)}</a></p>
            <p>This link expires at ${escapeHtml(expiresAt)}.</p>
          `,
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
