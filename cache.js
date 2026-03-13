/**
 * cache.js
 * Persistent cache for inbox scan results using chrome.storage.local.
 *
 * Cache schema (stored under key "inboxCache"):
 * {
 *   version: 1,
 *   scannedAt: <unix ms timestamp>,
 *   newestMessageId: <string>,        // Most recent message ID seen in last scan
 *   messageIndex: { [id]: email },    // Every scanned message ID → sender email
 *   senderMeta: {                     // Display name per email (latest seen)
 *     [email]: { displayName: string }
 *   }
 * }
 *
 * On a re-scan we fetch only pages until we encounter newestMessageId,
 * then merge the fresh entries on top of the stored messageIndex.
 * Sender counts are recomputed from the full merged messageIndex.
 */

const STORAGE_KEY = 'inboxCache';
const CACHE_VERSION = 1;

/**
 * Loads the cache from chrome.storage.local.
 * Returns null if nothing is stored yet.
 * @returns {Promise<object|null>}
 */
export async function loadCache() {
    return new Promise((resolve) => {
        chrome.storage.local.get(STORAGE_KEY, (result) => {
            const cache = result[STORAGE_KEY];
            if (!cache || cache.version !== CACHE_VERSION) {
                resolve(null);
            } else {
                resolve(cache);
            }
        });
    });
}

/**
 * Persists an updated cache to chrome.storage.local.
 * @param {object} cache
 * @returns {Promise<void>}
 */
export async function saveCache(cache) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.set({ [STORAGE_KEY]: cache }, () => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve();
            }
        });
    });
}

/**
 * Clears the cache entirely.
 * @returns {Promise<void>}
 */
export async function clearCache() {
    return new Promise((resolve, reject) => {
        chrome.storage.local.remove(STORAGE_KEY, () => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve();
            }
        });
    });
}

/**
 * Builds a fresh empty cache object.
 * @returns {object}
 */
export function emptyCache() {
    return {
        version: CACHE_VERSION,
        scannedAt: null,
        newestMessageId: null,
        messageIndex: {},   // { [msgId]: email }
        senderMeta: {},     // { [email]: { displayName } }
    };
}

/**
 * Merges newly scanned messages into an existing cache object (mutates in place).
 * Also updates newestMessageId and scannedAt.
 *
 * @param {object} cache - Existing cache (from loadCache or emptyCache)
 * @param {Array<{ id, email, displayName }>} newMessages - Fresh results from API
 * @returns {object} The same cache object, mutated
 */
export function mergeIntoCache(cache, newMessages) {
    for (const { id, email, displayName } of newMessages) {
        cache.messageIndex[id] = email;
        // Always keep the most recent display name seen for this sender
        if (!cache.senderMeta[email] || displayName) {
            cache.senderMeta[email] = { displayName: displayName || email };
        }
    }

    cache.scannedAt = Date.now();
    return cache;
}

/**
 * Removes all entries belonging to a given sender email from the cache.
 * Called after a successful bulk-delete so the cache stays consistent.
 *
 * @param {object} cache
 * @param {string} email
 * @returns {object} Mutated cache
 */
export function evictSenderFromCache(cache, email) {
    for (const [id, senderEmail] of Object.entries(cache.messageIndex)) {
        if (senderEmail === email) {
            delete cache.messageIndex[id];
        }
    }
    delete cache.senderMeta[email];
    return cache;
}

/**
 * Derives the sorted sender list from the full message index in the cache.
 * This is O(n) over total cached messages — fast for any realistic inbox.
 *
 * @param {object} cache
 * @returns {Array<{ email, displayName, count }>} Sorted descending by count
 */
export function buildSenderList(cache) {
    const counts = {}; // email → count

    for (const email of Object.values(cache.messageIndex)) {
        counts[email] = (counts[email] || 0) + 1;
    }

    return Object.entries(counts)
        .map(([email, count]) => ({
            email,
            displayName: cache.senderMeta[email]?.displayName || email,
            count,
        }))
        .sort((a, b) => b.count - a.count);
}   