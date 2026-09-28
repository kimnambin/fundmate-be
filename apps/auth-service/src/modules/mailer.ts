import nodemailer, { Transporter } from 'nodemailer';

let transporter: Transporter | null = null;

const getTransporter = () => {
  transporter ??= nodemailer.createTransport({
    service: process.env.SMTP_SERVICE,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
  });
  return transporter;
};

export const sendVerificationMail = async (to: string, code: string) => {
  await getTransporter().sendMail({
    from: `"Fundmate" <${process.env.SMTP_USER}>`,
    to,
    subject: '[Fundmate] 이메일 인증 코드입니다.',
    text: `인증 코드는 ${code}이며, 5분 후 만료됩니다. 시간 내에 입력해 주세요.`,
  });
};
