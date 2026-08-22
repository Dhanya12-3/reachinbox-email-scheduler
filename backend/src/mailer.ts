import nodemailer from 'nodemailer';
import env from './config';

let transportPromise: Promise<nodemailer.Transporter> | undefined;
async function transport() {
  if (!env.ETHEREAL_USER || !env.ETHEREAL_PASS) throw new Error('ETHEREAL_USER and ETHEREAL_PASS are required.');
  if (!transportPromise) transportPromise = Promise.resolve(nodemailer.createTransport({ host: 'smtp.ethereal.email', port: 587, secure: false, auth: { user: env.ETHEREAL_USER, pass: env.ETHEREAL_PASS } }));
  return transportPromise;
}
export async function sendEmail(input: { id: string; recipient: string; sender: string; subject: string; body: string }) {
  const result = await (await transport()).sendMail({ messageId: `<${input.id}@reachinbox.local>`, from: input.sender, to: input.recipient, subject: input.subject, text: input.body });
  return nodemailer.getTestMessageUrl(result);
}
