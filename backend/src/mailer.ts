import nodemailer from 'nodemailer';
import env from './config';

let transportPromise: Promise<nodemailer.Transporter> | undefined;
let verificationPromise: Promise<void> | undefined;

function mailError(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  const details = error as Error & { code?: string; responseCode?: number; command?: string };
  return [details.message, details.code, details.responseCode, details.command].filter(Boolean).join(' | ');
}

async function transport() {
  if (env.MAIL_PROVIDER !== 'smtp') throw new Error('SMTP transport is unavailable when MAIL_PROVIDER=resend.');
  if (!env.ETHEREAL_USER || !env.ETHEREAL_PASS) throw new Error('ETHEREAL_USER and ETHEREAL_PASS are required for SMTP.');
  if (!transportPromise) {
    console.log(`SMTP configured: host=${env.SMTP_HOST} port=${env.SMTP_PORT} secure=${env.SMTP_SECURE} authUserPresent=${Boolean(env.ETHEREAL_USER)} authPasswordPresent=${Boolean(env.ETHEREAL_PASS)}`);
    const transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: { user: env.ETHEREAL_USER, pass: env.ETHEREAL_PASS },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
    verificationPromise = transporter.verify()
      .then(() => console.log('SMTP transporter verification succeeded.'))
      .catch(error => {
        console.error(`SMTP transporter verification failed: ${mailError(error)}`);
        transportPromise = undefined;
        verificationPromise = undefined;
        throw error;
      });
    transportPromise = Promise.resolve(transporter);
  }
  await verificationPromise;
  return transportPromise;
}

async function sendWithResend(input: { id: string; recipient: string; sender: string; subject: string; body: string }) {
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is required when MAIL_PROVIDER=resend.');
  console.log(`Resend send starting: recipient=${input.recipient} from=${input.sender}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.RESEND_FROM || input.sender, to: [input.recipient], subject: input.subject, text: input.body, headers: { 'Message-ID': `<${input.id}@reachinbox.local>` } }),
    });
    const data = await response.json().catch(() => ({})) as { id?: string; message?: string };
    if (!response.ok) throw new Error(`Resend HTTP ${response.status}: ${data.message ?? 'request failed'}`);
    console.log(`Resend send succeeded: recipient=${input.recipient} messageId=${data.id ?? 'unknown'}`);
    return undefined;
  } catch (error) {
    const details = error instanceof Error && error.name === 'AbortError' ? 'HTTPS request timed out after 15000ms' : mailError(error);
    console.error(`Resend send failed: ${details}`);
    throw new Error(details);
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendEmail(input: { id: string; recipient: string; sender: string; subject: string; body: string }) {
  if (env.MAIL_PROVIDER === 'resend') return sendWithResend(input);
  console.log(`SMTP send starting: recipient=${input.recipient} from=${input.sender}`);
  try {
    const result = await (await transport()).sendMail({ messageId: `<${input.id}@reachinbox.local>`, from: input.sender, to: input.recipient, subject: input.subject, text: input.body });
    console.log(`SMTP send succeeded: recipient=${input.recipient} response=${result.response}`);
    return nodemailer.getTestMessageUrl(result);
  } catch (error) {
    console.error(`SMTP send failed: ${mailError(error)}`);
    throw error;
  }
}
