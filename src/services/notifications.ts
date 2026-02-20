import nodemailer from 'nodemailer';
import { config } from '../config';

// Email configuration from environment variables
// Supports Gmail (smtp.gmail.com) or Microsoft (smtp.office365.com)
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || process.env.EMAIL_SENDER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const FROM_EMAIL = process.env.EMAIL_FROM || process.env.EMAIL_SENDER || SMTP_USER;
const FROM_NAME = process.env.FROM_NAME || 'Tilting Heads Support';

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (!SMTP_USER || !SMTP_PASS) {
    console.warn('SMTP credentials not configured. Email notifications disabled.');
    return null;
  }

  if (!transporter) {
    const isGmail = SMTP_HOST.includes('gmail.com');
    const options: nodemailer.TransportOptions = {
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
      },
    };
    // Gmail: use default TLS. Office 365: use legacy ciphers option
    if (!isGmail && SMTP_HOST.includes('office365')) {
      (options as any).tls = {
        ciphers: 'SSLv3',
        rejectUnauthorized: false,
      };
    }
    transporter = nodemailer.createTransport(options);
  }

  return transporter;
}

/** Send email notification to admin when a new help request is created (cancel/return/refund) */
export async function notifyAdminNewHelpRequest(
  adminEmail: string,
  type: string,
  customerName: string,
  customerEmail: string,
  orderNumber: string,
  reason: string | null,
  requestId: string
): Promise<void> {
  const mailer = getTransporter();
  if (!mailer) {
    console.log(`[Email] Would notify admin ${adminEmail} about new ${type} request from ${customerName}`);
    return;
  }

  const adminUrl = `${process.env.ADMIN_URL || 'http://localhost:5299'}/admin/${requestId}`;
  const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
  const subject = `New ${typeLabel} request - ${customerName} - Order #${orderNumber}`;

  const reasonHtml = reason?.trim()
    ? `<p><strong>Reason / notes:</strong></p><p style="background: white; padding: 15px; border-left: 3px solid #0d9488; margin: 15px 0;">${reason.trim().substring(0, 500)}${reason.length > 500 ? '...' : ''}</p>`
    : '';

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #0d9488; color: white; padding: 20px; text-align: center; }
        .content { background: #f9fafb; padding: 20px; }
        .button { display: inline-block; background: #0d9488; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 20px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Tilting Heads Support</h1>
        </div>
        <div class="content">
          <h2>New ${typeLabel} request</h2>
          <p><strong>Customer:</strong> ${customerName}</p>
          <p><strong>Email:</strong> ${customerEmail}</p>
          <p><strong>Order Number:</strong> #${orderNumber}</p>
          ${reasonHtml}
          <a href="${adminUrl}" class="button">View & resolve in Admin</a>
        </div>
      </div>
    </body>
    </html>
  `;

  const text = `New ${typeLabel} request from ${customerName} (Order #${orderNumber})\nEmail: ${customerEmail}${reason ? `\nReason: ${reason.trim().substring(0, 300)}` : ''}\n\nView: ${adminUrl}`;

  try {
    await mailer.sendMail({
      from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
      to: adminEmail,
      subject,
      html,
      text,
    });
    console.log(`[Email] New help request notification sent to admin: ${adminEmail}`);
  } catch (e) {
    console.error('[Email] Failed to send new help request notification to admin:', e);
  }
}

/** Send confirmation email to customer when their help request is received */
export async function notifyCustomerRequestReceived(
  customerEmail: string,
  customerName: string,
  type: string,
  orderNumber: string,
  reference: string,
  requestId: string
): Promise<void> {
  const mailer = getTransporter();
  if (!mailer) {
    console.log(`[Email] Would send confirmation to customer ${customerEmail} for request ${reference}`);
    return;
  }

  const customerUrl = `${process.env.CUSTOMER_URL || 'http://localhost:5299'}/help/success?id=${requestId}&email=${encodeURIComponent(customerEmail)}`;
  const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
  const subject = `We received your ${typeLabel} request – Order #${orderNumber}`;

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #0d9488; color: white; padding: 20px; text-align: center; }
        .content { background: #f9fafb; padding: 20px; }
        .ref { font-family: monospace; font-size: 1.1em; background: #e5e7eb; padding: 2px 8px; border-radius: 4px; }
        .button { display: inline-block; background: #0d9488; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 20px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Tilting Heads Support</h1>
        </div>
        <div class="content">
          <h2>Hi ${customerName},</h2>
          <p>We've received your <strong>${typeLabel}</strong> request for order <strong>#${orderNumber}</strong>.</p>
          <p>Your reference number is: <span class="ref">${reference}</span>. Please quote this if you contact us.</p>
          <p>We typically respond within 24–48 hours. You can check the status of your request or message us anytime using the link below.</p>
          <a href="${customerUrl}" class="button">View request & message us</a>
        </div>
      </div>
    </body>
    </html>
  `;

  const text = `Hi ${customerName},\n\nWe've received your ${typeLabel} request for order #${orderNumber}.\nReference: ${reference}\n\nView status and message us: ${customerUrl}`;

  try {
    await mailer.sendMail({
      from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
      to: customerEmail,
      subject,
      html,
      text,
    });
    console.log(`[Email] Confirmation sent to customer: ${customerEmail}`);
  } catch (e) {
    console.error('[Email] Failed to send customer confirmation:', e);
  }
}

/** Send email notification to admin when customer sends a message */
export async function notifyAdminNewMessage(
  adminEmail: string,
  customerName: string,
  orderNumber: string,
  messagePreview: string,
  requestId: string
): Promise<void> {
  const mailer = getTransporter();
  if (!mailer) {
    console.log(`[Email] Would notify admin ${adminEmail} about new message from ${customerName}`);
    return;
  }

  const adminUrl = `${process.env.ADMIN_URL || 'http://localhost:5299'}/admin/${requestId}`;
  const subject = `New message from ${customerName} - Order #${orderNumber}`;

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #0d9488; color: white; padding: 20px; text-align: center; }
        .content { background: #f9fafb; padding: 20px; }
        .button { display: inline-block; background: #0d9488; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 20px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Tilting Heads Support</h1>
        </div>
        <div class="content">
          <h2>New Message Received</h2>
          <p><strong>Customer:</strong> ${customerName}</p>
          <p><strong>Order Number:</strong> #${orderNumber}</p>
          <p><strong>Message Preview:</strong></p>
          <p style="background: white; padding: 15px; border-left: 3px solid #0d9488; margin: 15px 0;">
            ${messagePreview.substring(0, 200)}${messagePreview.length > 200 ? '...' : ''}
          </p>
          <a href="${adminUrl}" class="button">View & Reply</a>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    await mailer.sendMail({
      from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
      to: adminEmail,
      subject,
      html,
      text: `New message from ${customerName} (Order #${orderNumber}):\n\n${messagePreview}\n\nView: ${adminUrl}`,
    });
    console.log(`[Email] Notification sent to admin: ${adminEmail}`);
  } catch (e) {
    console.error('[Email] Failed to send notification to admin:', e);
  }
}

/** Send email notification to customer when admin sends a message */
export async function notifyCustomerNewMessage(
  customerEmail: string,
  customerName: string,
  orderNumber: string,
  messagePreview: string,
  requestId: string
): Promise<void> {
  const mailer = getTransporter();
  if (!mailer) {
    console.log(`[Email] Would notify customer ${customerEmail} about new message`);
    return;
  }

  const chatUrl = `${process.env.CUSTOMER_URL || 'http://localhost:5299'}/help/success?id=${requestId}&email=${encodeURIComponent(customerEmail)}`;
  const subject = `Update on your request - Order #${orderNumber}`;

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #0d9488; color: white; padding: 20px; text-align: center; }
        .content { background: #f9fafb; padding: 20px; }
        .button { display: inline-block; background: #0d9488; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 20px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Tilting Heads Support</h1>
        </div>
        <div class="content">
          <h2>Hello ${customerName},</h2>
          <p>We have an update on your request for Order #${orderNumber}:</p>
          <p style="background: white; padding: 15px; border-left: 3px solid #0d9488; margin: 15px 0;">
            ${messagePreview.substring(0, 300)}${messagePreview.length > 300 ? '...' : ''}
          </p>
          <a href="${chatUrl}" class="button">View & Reply</a>
          <p style="margin-top: 30px; font-size: 14px; color: #666;">
            If you have any questions, please reply to this email or use the chat link above.
          </p>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    await mailer.sendMail({
      from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
      to: customerEmail,
      subject,
      html,
      text: `Hello ${customerName},\n\nUpdate on your request for Order #${orderNumber}:\n\n${messagePreview}\n\nView: ${chatUrl}`,
    });
    console.log(`[Email] Notification sent to customer: ${customerEmail}`);
  } catch (e) {
    console.error('[Email] Failed to send notification to customer:', e);
  }
}
