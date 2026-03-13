/**
 * utils.js
 * Shared utility helpers used across the extension.
 */

/**
 * Parses a raw "From" header value and extracts just the email address.
 * Handles both:
 *   "Display Name <email@example.com>"
 *   "email@example.com"
 *
 * @param {string} fromHeader - The raw From header string.
 * @returns {string} The extracted email address (lowercase).
 */
export function extractEmail(fromHeader) {
  if (!fromHeader) return 'unknown';

  // Match email inside angle brackets first
  const angleMatch = fromHeader.match(/<([^>]+)>/);
  if (angleMatch) return angleMatch[1].trim().toLowerCase();

  // Fallback: treat entire string as email if it looks like one
  const emailMatch = fromHeader.match(/[\w.+%-]+@[\w.-]+\.[a-z]{2,}/i);
  if (emailMatch) return emailMatch[0].toLowerCase();

  return fromHeader.trim().toLowerCase();
}

/**
 * Extracts the display name portion from a "From" header.
 * Falls back to the email address if no name is present.
 *
 * @param {string} fromHeader
 * @returns {string}
 */
export function extractDisplayName(fromHeader) {
  if (!fromHeader) return 'Unknown';

  // "Display Name <email>"
  const nameMatch = fromHeader.match(/^"?([^"<]+)"?\s*</);
  if (nameMatch) return nameMatch[1].trim();

  // No angle brackets — just return the email part
  return extractEmail(fromHeader);
}

/**
 * Formats a large number with locale-aware commas.
 * @param {number} n
 * @returns {string}
 */
export function formatNumber(n) {
  return n.toLocaleString();
}

/**
 * Sleeps for a given number of milliseconds. Useful for rate-limit back-off.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Splits an array into chunks of a given size.
 * Used for batching Gmail API requests.
 *
 * @param {Array} arr
 * @param {number} size
 * @returns {Array<Array>}
 */
export function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Creates a human-readable relative time string.
 * @param {number} timestamp - Unix ms timestamp.
 * @returns {string}
 */
export function relativeTime(timestamp) {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
