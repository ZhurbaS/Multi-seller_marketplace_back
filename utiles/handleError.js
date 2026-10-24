const handleError = (res, error, location = "Unknown") => {
  const message = error?.message || "Внутрішня помилка сервера";

  console.error(`❌ Error in ${location}:`, {
    message,
    stack:
      process.env.NODE_ENV === "development"
        ? error?.stack
        : "🔒 stack trace hidden in production",
  });

  // Клієнту повертаємо фіксований український текст, а технічне повідомлення
  // бібліотеки (часто англійською) лишається тільки в логах сервера.
  return res.status(500).json({
    error: "Внутрішня помилка сервера",
  });
};

module.exports = handleError;
