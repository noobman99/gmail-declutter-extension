/**
 * gmailApi.js
 * Encapsulates all interactions with the Gmail REST API.
 * Uses fetch() with OAuth bearer tokens obtained from auth.js.
 */

import { extractEmail, extractDisplayName, sleep, chunkArray } from './utils.js';

const BASE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me';

// Maximum IDs per batchDelete call (Gmail API limit)
const BATCH_DELETE_LIMIT = 1000;

// Max concurrent metadata requests to avoid rate limiting
const MAX_CONCURRENT = 5;

// Back-off delay (ms) when rate-limited (HTTP 429)
const RATE_LIMIT_DELAY = 2000;

// ─── Core fetch wrapper ──────────────────────────────────────────────────────

/**
 * Authenticated fetch with automatic 429 back-off.
 * @param {string} url
 * @param {string} token
 * @param {object} options
 * @returns {Promise<any>}
 */
async function apiFetch(url, token, options = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...options.headers,
  };

  const response = await fetch(url, { ...options, headers });

  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : RATE_LIMIT_DELAY;
    await sleep(delay);
    return apiFetch(url, token, options);
  }

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    const message = errorBody?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Gmail API error: ${message}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

// ─── Message listing ──────────────────────────────────────────────────────────

/**
 * Fetches one page of message stubs from the inbox.
 * @param {string} token
 * @param {string|null} pageToken
 * @param {string} query
 * @returns {Promise<{ messages, nextPageToken, resultSizeEstimate }>}
 */
export async function listMessages(token, pageToken = null, query = '') {
  const params = new URLSearchParams({ labelIds: 'INBOX', maxResults: '500' });
  if (pageToken) params.set('pageToken', pageToken);
  if (query) params.set('q', query);

  const data = await apiFetch(`${BASE_URL}/messages?${params}`, token);
  return {
    messages: data.messages || [],
    nextPageToken: data.nextPageToken || null,
    resultSizeEstimate: data.resultSizeEstimate || 0,
  };
}

/**
 * Collects message IDs from the inbox, stopping early once a known ID is seen.
 *
 * Gmail returns messages newest-first. If we already have newestKnownId in our
 * cache, we stop paginating as soon as we encounter it — everything after that
 * point is already cached.
 *
 * @param {string} token
 * @param {string} query
 * @param {string|null} newestKnownId  - Stop when this ID appears in a page
 * @param {Set<string>} knownIds       - Full set of already-cached IDs to skip
 * @param {function} onProgress        - (newCount, isIncremental) progress cb
 * @returns {Promise<{ newIds: string[], newestSeenId: string|null }>}
 */
export async function collectNewMessageIds(
  token,
  query = '',
  newestKnownId = null,
  knownIds = new Set(),
  onProgress
) {
  const newIds = [];
  let pageToken = null;
  let done = false;
  let newestSeenId = null; // Track the very first ID returned (newest in inbox)

  do {
    const { messages, nextPageToken } = await listMessages(token, pageToken, query);

    if (messages.length === 0) break;

    // The first message on the very first page is the newest in the inbox
    if (!newestSeenId) newestSeenId = messages[0].id;

    for (const msg of messages) {
      // Hit the watermark — everything from here on is already cached
      if (newestKnownId && msg.id === newestKnownId) {
        done = true;
        break;
      }
      // Skip IDs we already have metadata for
      if (!knownIds.has(msg.id)) {
        newIds.push(msg.id);
      }
    }

    pageToken = nextPageToken;
    if (onProgress) onProgress(newIds.length, !!newestKnownId);
  } while (pageToken && !done);

  return { newIds, newestSeenId };
}

/**
 * Collects ALL message IDs matching a query (full scan, no cache awareness).
 * Used for delete operations where we need every matching ID.
 *
 * @param {string} token
 * @param {string} query
 * @param {function} onProgress
 * @returns {Promise<string[]>}
 */
export async function getAllMessageIds(token, query = '', onProgress) {
  const allIds = [];
  let pageToken = null;

  do {
    const { messages, nextPageToken } = await listMessages(token, pageToken, query);
    for (const msg of messages) allIds.push(msg.id);
    pageToken = nextPageToken;
    if (onProgress) onProgress(allIds.length);
  } while (pageToken);

  return allIds;
}

// ─── Metadata fetching ────────────────────────────────────────────────────────

/**
 * Fetches metadata for a single message.
 * @param {string} token
 * @param {string} messageId
 * @returns {Promise<{ id, email, displayName }>}
 */
export async function getMessageMetadata(token, messageId) {
  const params = new URLSearchParams({
    format: 'metadata',
    metadataHeaders: 'From',
  });

  const data = await apiFetch(`${BASE_URL}/messages/${messageId}?${params}`, token);
  const fromHeader = data.payload?.headers?.find(
    (h) => h.name.toLowerCase() === 'from'
  );
  const fromValue = fromHeader?.value || '';

  return {
    id: data.id,
    email: extractEmail(fromValue),
    displayName: extractDisplayName(fromValue),
  };
}

/**
 * Fetches metadata for multiple messages concurrently (rate-limit safe).
 *
 * @param {string} token
 * @param {string[]} messageIds
 * @param {function} onProgress - (completed, total)
 * @returns {Promise<Array<{ id, email, displayName }>>}
 */
export async function getMessagesBatch(token, messageIds, onProgress) {
  const results = [];
  const chunks = chunkArray(messageIds, MAX_CONCURRENT);
  let completed = 0;

  for (const chunk of chunks) {
    const chunkResults = await Promise.all(
      chunk.map((id) =>
        getMessageMetadata(token, id).catch((err) => {
          console.warn(`Failed to fetch message ${id}:`, err.message);
          return null;
        })
      )
    );

    for (const result of chunkResults) {
      if (result) results.push(result);
      completed++;
      if (onProgress) onProgress(completed, messageIds.length);
    }
  }

  return results;
}

// ─── High-level scan ──────────────────────────────────────────────────────────

/**
 * Incremental inbox scan.
 *
 * If cache data is provided, only fetches messages newer than newestKnownId,
 * then fetches metadata only for those new IDs. Dramatically reduces API calls
 * on subsequent scans.
 *
 * @param {string} token
 * @param {object} cacheData
 *   @param {string|null}  cacheData.newestKnownId   - Watermark message ID
 *   @param {Set<string>}  cacheData.knownIds         - Set of all cached msg IDs
 * @param {object} callbacks
 *   @param {function} callbacks.onPageFetched        - (count, isIncremental)
 *   @param {function} callbacks.onMetadataProgress   - (completed, total)
 * @returns {Promise<{ newMessages: Array<{id,email,displayName}>, newestSeenId: string|null }>}
 */
export async function scanNewMessages(
  token,
  { newestKnownId = null, knownIds = new Set() } = {},
  { onPageFetched, onMetadataProgress } = {}
) {
  // Step 1: Page through inbox, stopping at the watermark
  const { newIds, newestSeenId } = await collectNewMessageIds(
    token,
    '',
    newestKnownId,
    knownIds,
    onPageFetched
  );

  if (newIds.length === 0) {
    return { newMessages: [], newestSeenId };
  }

  // Step 2: Fetch metadata only for genuinely new messages
  const newMessages = await getMessagesBatch(token, newIds, onMetadataProgress);

  return { newMessages, newestSeenId };
}

// ─── Batch trash ──────────────────────────────────────────────────────────────

/**
 * Moves message IDs to Trash in batches of 1000 (Gmail API limit per call).
 * Uses batchModify to add the TRASH label and remove INBOX — this is
 * recoverable (emails stay in Trash for 30 days) unlike batchDelete.
 *
 * @param {string} token
 * @param {string[]} messageIds
 * @returns {Promise<void>}
 */
export async function batchTrashMessages(token, messageIds) {
  if (messageIds.length === 0) return;

  for (const chunk of chunkArray(messageIds, BATCH_DELETE_LIMIT)) {
    await apiFetch(`${BASE_URL}/messages/batchModify`, token, {
      method: 'POST',
      body: JSON.stringify({
        ids: chunk,
        addLabelIds: ['TRASH'],
        removeLabelIds: ['INBOX'],
      }),
    });
  }
}