/**
 * spamApi.js
 * Communicates with the local FastAPI spam-classification server.
 *
 * The server must be running at http://127.0.0.1:5001
 * (start it with: ./start.sh inside the spam_server/ folder)
 *
 * Public API:
 *   isServerAvailable()            → Promise<boolean>
 *   classifyBatch(token, msgIds)   → Promise<Map<id, { label, score }>>
 */

const SERVER_BASE = 'http://127.0.0.1:5001';
const HEALTH_URL = `${SERVER_BASE}/health`;
const BATCH_URL = `${SERVER_BASE}/classify_batch`;

// Max items per /classify_batch call (server enforces 500)
const BATCH_CHUNK = 100;

// Gmail API base for fetching message snippets
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

// Spam confidence threshold — scores above this are marked SPAM
export const SPAM_THRESHOLD = 0.80;

// ─── Server health ────────────────────────────────────────────────────────────

/**
 * Pings the local server to check it is up and the model is loaded.
 * @returns {Promise<boolean>}
 */
export async function isServerAvailable() {
    try {
        const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return false;
        const data = await res.json();
        return data.model_loaded === true;
    } catch {
        return false;
    }
}

// ─── Gmail snippet fetching ───────────────────────────────────────────────────

/**
 * Fetches the subject + snippet for a single Gmail message.
 * Uses format=metadata so we only pull Subject header + the short snippet.
 *
 * @param {string} token   - OAuth access token
 * @param {string} msgId   - Gmail message ID
 * @returns {Promise<{ id: string, text: string }>}
 */
async function fetchMessageText(token, msgId) {
    const params = new URLSearchParams({
        format: 'metadata',
        metadataHeaders: 'Subject',
    });
    const url = `${GMAIL_BASE}/messages/${msgId}?${params}`;
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) return { id: msgId, text: '' };

    const data = await res.json();
    const subjectHeader = data.payload?.headers?.find(
        (h) => h.name.toLowerCase() === 'subject'
    );
    const subject = subjectHeader?.value || '';
    const snippet = data.snippet || '';

    // Combine subject + snippet as the text to classify
    return { id: msgId, text: `${subject} ${snippet}`.trim() };
}

/**
 * Fetches subject+snippet for multiple messages concurrently (max 5 at once).
 *
 * @param {string}   token
 * @param {string[]} msgIds
 * @param {function} onProgress  - (completed, total)
 * @returns {Promise<Array<{ id, text }>>}
 */
async function fetchMessageTexts(token, msgIds, onProgress) {
    const CONCURRENCY = 5;
    const results = [];
    let completed = 0;

    for (let i = 0; i < msgIds.length; i += CONCURRENCY) {
        const chunk = msgIds.slice(i, i + CONCURRENCY);
        const chunkResults = await Promise.all(
            chunk.map((id) => fetchMessageText(token, id).catch(() => ({ id, text: '' })))
        );
        results.push(...chunkResults);
        completed += chunk.length;
        if (onProgress) onProgress(completed, msgIds.length);
    }

    return results;
}

// ─── Classification ───────────────────────────────────────────────────────────

/**
 * Sends a chunk of { id, text } items to the FastAPI /classify_batch endpoint.
 *
 * @param {Array<{ id: string, text: string }>} items
 * @returns {Promise<Array<{ id, label, score }>>}
 */
async function callClassifyBatch(items) {
    const res = await fetch(BATCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(items.map(({ id, text }) => ({ id, text }))),
        signal: AbortSignal.timeout(60_000), // 60 s per chunk — BERT is slow on CPU
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `Server error ${res.status}`);
    }

    return res.json();
}

/**
 * Full spam-classification pipeline for a list of message IDs:
 *   1. Fetch subject+snippet from Gmail API for each message.
 *   2. Send to the local BERT server in chunks.
 *   3. Return a Map of msgId → { label: 'SPAM'|'LEGITIMATE', score: 0–1 }
 *
 * @param {string}   token     - OAuth access token
 * @param {string[]} msgIds    - Array of Gmail message IDs to classify
 * @param {object}   callbacks
 * @param {function} callbacks.onFetchProgress    - (completed, total) while fetching
 * @param {function} callbacks.onClassifyProgress - (completed, total) while classifying
 * @returns {Promise<Map<string, { label: string, score: number }>>}
 */
export async function classifyMessages(token, msgIds, { onFetchProgress, onClassifyProgress } = {}) {
    if (msgIds.length === 0) return new Map();

    // Step 1: Fetch text content for every message
    const messageTexts = await fetchMessageTexts(token, msgIds, onFetchProgress);

    // Filter out messages where we couldn't get any text
    const validItems = messageTexts.filter((m) => m.text.length > 0);

    // Step 2: Send to BERT server in chunks
    const resultMap = new Map();
    let classified = 0;

    for (let i = 0; i < validItems.length; i += BATCH_CHUNK) {
        const chunk = validItems.slice(i, i + BATCH_CHUNK);
        const results = await callClassifyBatch(chunk);

        for (const { id, label, score } of results) {
            resultMap.set(id, { label, score });
        }

        classified += chunk.length;
        if (onClassifyProgress) onClassifyProgress(classified, validItems.length);
    }

    return resultMap;
}

/**
 * Extracts the IDs of messages classified as SPAM above the confidence threshold.
 *
 * @param {Map<string, { label, score }>} classifyResults
 * @returns {string[]} Spam message IDs
 */
export function extractSpamIds(classifyResults) {
    const spamIds = [];
    for (const [id, { label, score }] of classifyResults) {
        if (label === 'SPAM' && score >= SPAM_THRESHOLD) {
            spamIds.push(id);
        }
    }
    return spamIds;
}