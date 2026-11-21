import nodemailer from 'nodemailer';

export interface MailMessage { to: string[]; subject: string; text: string; html: string; replyTo?: string }
/** Envoi d'un e-mail ; une erreur levée signifie « non envoyé ». */
export interface MailService { send(m: MailMessage): Promise<void> }

export interface SmtpConfig { host: string; port: number; secure: boolean; user?: string; pass?: string; from: string }

export class SmtpMailService implements MailService {
  private transport;
  constructor(private cfg: SmtpConfig) {
    this.transport = nodemailer.createTransport({
      host: cfg.host, port: cfg.port, secure: cfg.secure, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
      ...(cfg.user ? { auth: { user: cfg.user, pass: cfg.pass ?? '' } } : {}),
    });
  }
  async send(m: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.cfg.from, to: m.to, replyTo: m.replyTo, subject: m.subject, text: m.text, html: m.html });
  }
}

/** Configuration SMTP de l'environnement ; undefined si SMTP_HOST ou SMTP_FROM manquent : les routes d'e-mail répondent alors 503. */
export function mailFromEnv(env: NodeJS.ProcessEnv = process.env): MailService | undefined {
  if (!env.SMTP_HOST || !env.SMTP_FROM) return undefined;
  const port = Number(env.SMTP_PORT ?? 587);
  return new SmtpMailService({
    host: env.SMTP_HOST, port, secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
    user: env.SMTP_USER || undefined, pass: env.SMTP_PASS || undefined, from: env.SMTP_FROM,
  });
}
