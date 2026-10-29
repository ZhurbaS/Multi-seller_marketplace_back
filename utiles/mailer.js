// Відправка листів без додаткових залежностей — через HTTP API сервісу Resend (resend.com,
// безкоштовний тариф достатній для старту). Налаштування в .env:
//   RESEND_API_KEY=...            ключ з кабінету Resend
//   MAIL_FROM="Назва <no-reply@ваш-домен.ua>"   відправник (домен треба підтвердити в Resend)
// Якщо ключа немає — лист НЕ надсилається, а лише пишеться в лог (функція повертає false).

const isConfigured = () => !!process.env.RESEND_API_KEY && !!process.env.MAIL_FROM;

// attachments: [{ filename, content: Buffer }] (передаються в Resend як base64)
async function sendMail({ to, subject, text, attachments }) {
  if (!isConfigured()) {
    console.log(`📧 Лист не надіслано (пошту не налаштовано): ${to} — ${subject}`);
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.MAIL_FROM,
        to: [to],
        subject,
        text,
        ...(attachments?.length
          ? {
              attachments: attachments.map((a) => ({
                filename: a.filename,
                content: Buffer.from(a.content).toString("base64"),
              })),
            }
          : {}),
      }),
    });
    if (!res.ok) {
      console.error(`📧 Resend ${res.status}: ${await res.text()}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error("📧 Помилка відправки листа:", error.message);
    return false;
  }
}

module.exports = { sendMail, isConfigured };
