import nodemailer, { Transporter } from 'nodemailer';

/**
 * Outbound email.
 *
 * The platform had no way to send mail at all, which is why account
 * verification, password reset and "your inspection is booked" notices all used
 * to be impossible. This module is the single place that talks to an SMTP
 * server.
 *
 * Configuration is entirely environment-driven, and the absence of it is a
 * supported state rather than a crash: with no SMTP_HOST the message is logged
 * to the server console instead of being sent. That keeps local development and
 * the offline demo working without an inbox, while a real deployment only needs
 * SMTP_* set. Nothing here throws into a request path — callers fire and forget.
 */

interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

const DEFAULT_FROM = 'East Gate <no-reply@eastgate.ng>';

function env(name: string): string {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

/** True when a real SMTP server has been configured. */
export function emailConfigured(): boolean {
  return env('SMTP_HOST').length > 0;
}

export function mailFrom(): string {
  return env('MAIL_FROM') || DEFAULT_FROM;
}

/**
 * Dev email catcher. When SMTP is not configured but this flag is on, mail is
 * delivered to a throwaway Ethereal mailbox instead of only being logged, and
 * the console prints a preview URL for every message. That lets the full
 * verification / reset / inspection flows be exercised locally with no mailbox
 * and no credentials. Enabled by MAIL_DEV_CATCH, else it stays off so an offline
 * machine is never slowed by a network attempt.
 */
export function devCatchEnabled(): boolean {
  const value = env('MAIL_DEV_CATCH').toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

type TransportMode = 'smtp' | 'ethereal' | 'none';

let transporter: Transporter | null = null;
let transportMode: TransportMode | null = null;

/** Resolves (and memoises) the transport. Async because the dev catcher has to
 *  create its disposable SMTP account on first use. */
async function resolveTransport(): Promise<{ transporter: Transporter | null; mode: TransportMode }> {
  if (transportMode) return { transporter, mode: transportMode };

  if (emailConfigured()) {
    try {
      const port = Number(env('SMTP_PORT') || 587);
      transporter = nodemailer.createTransport({
        host: env('SMTP_HOST'),
        port,
        // Implicit TLS is used on 465; STARTTLS on 587/25 — let the env override.
        secure: env('SMTP_SECURE') ? env('SMTP_SECURE') === 'true' : port === 465,
        auth: env('SMTP_USER') ? { user: env('SMTP_USER'), pass: env('SMTP_PASS') } : undefined
      });
      transportMode = 'smtp';
    } catch (error) {
      console.error('[mailer] could not build SMTP transport; falling back to logging', error);
      transporter = null;
      transportMode = 'none';
    }
    return { transporter, mode: transportMode };
  }

  if (devCatchEnabled()) {
    try {
      const account = await nodemailer.createTestAccount();
      transporter = nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        auth: { user: account.user, pass: account.pass }
      });
      transportMode = 'ethereal';
      console.log(`[mailer] dev catch on — Ethereal inbox ${account.user} (previews print per message)`);
    } catch (error) {
      console.error('[mailer] could not create Ethereal dev inbox; falling back to logging', error);
      transporter = null;
      transportMode = 'none';
    }
    return { transporter, mode: transportMode };
  }

  transportMode = 'none';
  return { transporter: null, mode: 'none' };
}

/**
 * Sends one message. Resolves true when it was handed to a transport, false when
 * it was only logged. Never rejects — a mail failure must not surface as an API
 * error.
 */
export async function sendMail(message: MailMessage): Promise<boolean> {
  const from = mailFrom();

  try {
    const { transporter: mailer, mode } = await resolveTransport();

    if (!mailer) {
      // No transport configured. Log the envelope so a developer can still grab
      // the verification / reset link out of the terminal.
      console.log(
        `\n[mailer] (not sent — SMTP not configured)\n  To: ${message.to}\n  Subject: ${message.subject}\n${message.text}\n`
      );
      return false;
    }

    const info = await mailer.sendMail({
      from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html
    });

    if (mode === 'ethereal') {
      const preview = nodemailer.getTestMessageUrl(info);
      console.log(`[mailer] delivered (dev catch) "${message.subject}" to ${message.to}${preview ? ` — preview: ${preview}` : ''}`);
    }
    return true;
  } catch (error) {
    // An unreachable or misconfigured SMTP server is an operational problem, not
    // the caller's: log it and move on so registration / reset still complete.
    console.error(`[mailer] failed to send "${message.subject}" to ${message.to}`, error);
    return false;
  }
}

/* ----------------------------------------------------------------------------
   Templates. Kept here so wording lives in one place and the routes stay thin.
   ---------------------------------------------------------------------------- */

function layout(heading: string, body: string, cta?: { label: string; url: string }): string {
  const button = cta
    ? `<p style="margin:28px 0;"><a href="${cta.url}" style="background:#C6A15B;color:#111;padding:14px 26px;border-radius:6px;text-decoration:none;font-weight:600;">${cta.label}</a></p>
       <p style="font-size:13px;color:#8A877F;">Or paste this link into your browser:<br>${cta.url}</p>`
    : '';

  return `<div style="font-family:Inter,Arial,sans-serif;color:#111;max-width:560px;margin:0 auto;">
    <h1 style="font-family:'Playfair Display',Georgia,serif;font-size:22px;">${heading}</h1>
    ${body}
    ${button}
    <hr style="border:none;border-top:1px solid #eee;margin:28px 0;">
    <p style="font-size:12px;color:#8A877F;">East Gate Real-Estate — Find Your Place. Make It Home.</p>
  </div>`;
}

export function verificationEmail(name: string, url: string): { subject: string; text: string; html: string } {
  const safeName = name || 'there';
  return {
    subject: 'Verify your East Gate email address',
    text: `Hi ${safeName},\n\nWelcome to East Gate. Confirm your email address to activate your account:\n${url}\n\nIf you did not create this account you can ignore this message.`,
    html: layout(`Welcome, ${safeName}`, '<p>Thanks for joining East Gate. Please confirm your email address to activate your account.</p>', {
      label: 'Verify email',
      url
    })
  };
}

export function passwordResetEmail(name: string, url: string): { subject: string; text: string; html: string } {
  const safeName = name || 'there';
  return {
    subject: 'Reset your East Gate password',
    text: `Hi ${safeName},\n\nWe received a request to reset your password. This link expires in 30 minutes:\n${url}\n\nIf you did not request this, no action is needed.`,
    html: layout(
      `Reset your password, ${safeName}`,
      '<p>We received a request to reset your East Gate password. This link expires in 30 minutes.</p>',
      { label: 'Reset password', url }
    )
  };
}

export function inspectionBookedEmail(
  name: string,
  propertyTitle: string,
  date: string,
  timeSlot: string
): { subject: string; text: string; html: string } {
  const safeName = name || 'there';
  const line = `${propertyTitle} on ${date} (${timeSlot})`;
  return {
    subject: 'Your East Gate inspection is booked',
    text: `Hi ${safeName},\n\nYour inspection request has been received:\n${line}\n\nAn East Gate agent will confirm the appointment shortly.`,
    html: layout(
      'Inspection booked',
      `<p>Hi ${safeName}, your inspection request has been received:</p><p style="font-weight:600;">${line}</p><p>An East Gate agent will confirm the appointment shortly.</p>`
    )
  };
}
