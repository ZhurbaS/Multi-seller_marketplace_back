const handleError = (res, error, location = "Unknown") => {
  const message = error?.message || "Internal Server Error";

  console.error(`❌ Error in ${location}:`, {
    message,
    stack:
      process.env.NODE_ENV === "development"
        ? error?.stack
        : "🔒 stack trace hidden in production",
  });

  return res.status(500).json({
    error: message,
  });
};

module.exports = handleError;
