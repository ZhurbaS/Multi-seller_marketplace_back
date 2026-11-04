// Транзакційні листи підписки (double opt-in): «підтвердіть підписку» і «ви вже підписані».
// Надсилаються через звичайний utiles/mailer.js (footer "plain"), не через маркетинговий мейлер:
// це відповідь на дію людини, а не реклама. Див. MARKETING_SPEC.md §5.

const { publicFrontUrl } = require("../payments/config");
const tokens = require("./marketingTokens");

const confirmLink = (contactId) => `${publicFrontUrl()}/subscribe/confirm?t=${encodeURIComponent(tokens.sign("confirm", contactId))}`;
const preferencesLink = (contactId) => `${publicFrontUrl()}/preferences?t=${encodeURIComponent(tokens.sign("pref", contactId))}`;

// ---- чисті шаблони

function confirmMail({ link, brand = "TechScout" }) {
  return {
    subject: `Підтвердіть підписку на розсилку ${brand}`,
    text:
      `Вітаємо!\n\n` +
      `Ви (або хтось від вашого імені) підписалися на новини та пропозиції ${brand}. ` +
      `Щоб почати отримувати листи, підтвердьте підписку за посиланням:\n\n${link}\n\n` +
      `Посилання діє 7 днів. Якщо ви не підписувалися — просто проігноруйте цей лист: без підтвердження ми не надсилатимемо розсилок.`,
  };
}

function alreadyMail({ link, brand = "TechScout" }) {
  return {
    subject: `Ви вже підписані на розсилку ${brand}`,
    text:
      `Вітаємо!\n\nЦя адреса вже підписана на новини та пропозиції ${brand} — нічого робити не потрібно.\n\n` +
      `Змінити теми розсилки або відписатися можна тут:\n${link}`,
  };
}

// ---- відправка

async function brand() {
  try {
    return (await require("./marketingSettings").load()).senderName || "TechScout";
  } catch {
    return "TechScout";
  }
}

async function sendConfirm(contact) {
  const m = confirmMail({ link: confirmLink(contact._id), brand: await brand() });
  return require("./mailer").sendMail({ to: contact.email, ...m, footer: "plain" });
}

async function sendAlreadySubscribed(contact) {
  const m = alreadyMail({ link: preferencesLink(contact._id), brand: await brand() });
  return require("./mailer").sendMail({ to: contact.email, ...m, footer: "plain" });
}

module.exports = { confirmMail, alreadyMail, confirmLink, preferencesLink, sendConfirm, sendAlreadySubscribed };
