import nodemailer from 'nodemailer';
import { env } from '../config/env';

let transporter: nodemailer.Transporter | null = null;

export async function initEmailService() {
  if (env.EMAIL_USER && env.EMAIL_PASS) {
    transporter = nodemailer.createTransport({
      host: env.EMAIL_HOST,
      port: env.EMAIL_PORT,
      secure: env.EMAIL_PORT === 465, // true for 465, false for other ports
      auth: {
        user: env.EMAIL_USER,
        pass: env.EMAIL_PASS,
      },
    });
    console.log('Nodemailer SMTP transporter initialized.');
  } else {
    // Generate Ethereal test account on the fly for development
    try {
      console.log('Creating Ethereal test email account...');
      const testAccount = await nodemailer.createTestAccount();
      transporter = nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        auth: {
          user: testAccount.user,
          pass: testAccount.pass,
        },
      });
      console.log(`Ethereal test email account created!`);
      console.log(`User: ${testAccount.user}`);
      console.log(`Password: ${testAccount.pass}`);
    } catch (err) {
      console.error('Failed to create Ethereal test account:', err);
    }
  }
}

export async function sendEmail({ to, subject, html, attachments }: { to: string; subject: string; html: string; attachments?: any[] }) {
  if (!transporter) {
    console.warn('Email service not initialized. Outputting mail to console:');
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(`Body: ${html.substring(0, 300)}...`);
    return;
  }

  try {
    const info = await transporter.sendMail({
      from: '"Ticketing System" <noreply@ticketing.com>',
      to,
      subject,
      html,
      attachments,
    });

    console.log(`Email sent successfully: ${info.messageId}`);
    // If using Ethereal, print the preview URL
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) {
      console.log(`[Preview Email] View at: ${previewUrl}`);
    }
  } catch (err) {
    console.error('Error sending email:', err);
  }
}

export async function sendTicketEmail(to: string, bookingRef: string, eventName: string, date: string, seatInfo: string, qrCodeDataUrl: string) {
  const html = `
    <div style="font-family: Arial, sans-serif; padding: 20px; color: #333; background-color: #f7f9fc; border-radius: 8px; max-width: 600px; margin: 0 auto; border: 1px solid #e1e8ed;">
      <h2 style="color: #2b6cb0; border-bottom: 2px solid #2b6cb0; padding-bottom: 10px;">Your Booking Confirmation</h2>
      <p>Thank you for your purchase! Here is your event ticket details:</p>
      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        <tr>
          <td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #e1e8ed;">Event:</td>
          <td style="padding: 8px; border-bottom: 1px solid #e1e8ed;">${eventName}</td>
        </tr>
        <tr>
          <td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #e1e8ed;">Date/Time:</td>
          <td style="padding: 8px; border-bottom: 1px solid #e1e8ed;">${date}</td>
        </tr>
        <tr>
          <td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #e1e8ed;">Seat:</td>
          <td style="padding: 8px; border-bottom: 1px solid #e1e8ed;">${seatInfo}</td>
        </tr>
        <tr>
          <td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #e1e8ed;">Reference:</td>
          <td style="padding: 8px; border-bottom: 1px solid #e1e8ed;"><code>${bookingRef}</code></td>
        </tr>
      </table>
      <p style="text-align: center; margin: 30px 0;">
        <img src="cid:qrcode" alt="QR Code Ticket" style="width: 200px; height: 200px; border: 1px solid #e1e8ed; padding: 10px; background-color: #fff;" />
      </p>
      <p style="font-size: 12px; color: #718096; text-align: center;">Please show this QR code at the entrance to gain entry to the venue.</p>
    </div>
  `;

  await sendEmail({
    to,
    subject: `Ticket Booking Confirmation - ${bookingRef}`,
    html,
    attachments: [
      {
        filename: 'ticket-qr.png',
        path: qrCodeDataUrl,
        cid: 'qrcode',
      },
    ],
  });
}

export async function sendWaitlistOfferEmail(to: string, eventName: string, category: string, confirmLink: string) {
  const html = `
    <div style="font-family: Arial, sans-serif; padding: 20px; color: #333; background-color: #f7f9fc; border-radius: 8px; max-width: 600px; margin: 0 auto; border: 1px solid #e1e8ed;">
      <h2 style="color: #d69e2e; border-bottom: 2px solid #d69e2e; padding-bottom: 10px;">Good News! Seat Available on Waitlist</h2>
      <p>A seat has opened up in the <strong>${category}</strong> category for the event <strong>${eventName}</strong>.</p>
      <p>Since you are next on the waitlist, this seat is reserved for you. However, you must confirm your booking within <strong>15 minutes</strong>, or the seat will be offered to the next person in line.</p>
      <p style="text-align: center; margin: 30px 0;">
        <a href="${confirmLink}" style="background-color: #319795; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold; font-size: 16px; display: inline-block; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
          Confirm & Book Ticket Now
        </a>
      </p>
      <p style="font-size: 12px; color: #e53e3e; text-align: center; font-weight: bold;">This link will expire in 15 minutes.</p>
    </div>
  `;

  await sendEmail({
    to,
    subject: `Waitlist Seat Available! Action Required - ${eventName}`,
    html,
  });
}
