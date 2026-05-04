import crypto from 'node:crypto';

export function signCookieValue(value, secret) {
  const signature = crypto
    .createHmac('sha256', secret)
    .update(value)
    .digest('base64url');

  return `${value}.${signature}`;
}

export function unsignCookieValue(value, secret) {
  if (typeof value !== 'string' || !value.includes('.')) {
    return null;
  }

  const lastDot = value.lastIndexOf('.');
  const unsigned = value.slice(0, lastDot);
  const providedSignature = value.slice(lastDot + 1);
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(unsigned)
    .digest('base64url');

  if (!safeEqual(providedSignature, expectedSignature)) {
    return null;
  }

  return unsigned;
}

export function parseCookies(headerValue) {
  if (typeof headerValue !== 'string' || !headerValue.trim()) {
    return {};
  }

  return headerValue.split(';').reduce((cookies, pair) => {
    const separatorIndex = pair.indexOf('=');

    if (separatorIndex === -1) {
      return cookies;
    }

    const name = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();

    if (!name) {
      return cookies;
    }

    cookies[name] = decodeURIComponent(value);
    return cookies;
  }, {});
}

export function createSessionCookie(name, signedValue, maxAgeMs, secure) {
  const parts = [
    `${name}=${encodeURIComponent(signedValue)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];

  if (secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

export function createExpiredSessionCookie(name, secure) {
  const parts = [
    `${name}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];

  if (secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
