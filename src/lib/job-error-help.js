// Presentation-only help for job outcomes returned by the Railway API.
const ERROR_HELP = {
  "AI service busy": "Retry shortly; the AI provider is overloaded.",
  "AI could not read photo": "Retake or crop the photo, then retry AI fill.",
  "Missing image": "The item photo is missing. Re-upload the photo before retrying.",
  "Network offline": "Reconnect and retry the job.",
  "Permission denied": "Use an editor or admin account, or check permissions.",
  "Rate limited": "Wait a short while, then retry fewer items.",
  "Timeout": "Retry the job; if it repeats, use a smaller batch.",
  "Service unavailable": "Retry later; the server did not complete.",
  "Shop rejected item": "Fix the item details, price, SKU, or stock, then retry publication.",
  "Shop service unavailable": "Retry when the POS service is reachable.",
  "Unknown technical error": "Retry once; if it repeats, inspect the technical detail.",
};

export function jobErrorHelp(category) {
  return ERROR_HELP[category] || ERROR_HELP["Unknown technical error"];
}
