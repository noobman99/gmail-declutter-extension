/**
 * cache.js
 * Persistent cache for inbox scan results using chrome.storage.local.
 *
 * Cache schema (stored under key "inboxCache"):
 * {
 *   version: 2,
 *   scannedAt: <unix ms>,
 *   newestMessageId: <string>,
 *   messageIndex: { [id]: email },
 *   senderMeta: { [email]: { displayName } },
 *   spamIndex: { [id]: { label, score } },   // ← NEW: per-message spam results
 *   spamClassifiedAt: <unix ms> | null,       // ← NEW: when spam scan last ran
 * }
 */

const STORAGE_KEY = 'inboxCache';
const CACHE_VERSION = 2;

// ─── Core load/save/clear ─────────────────────────────────────────────────────

export async function loadCache() {
    return new Promise((resolve) => {
        chrome.storage.local.get(STORAGE_KEY, (result) => {
            const cache = result[STORAGE_KEY];
            // Accept v1 caches and migrate them on the fly
            if (!cache) { resolve(null); return; }
            if (cache.version === 1) {
                cache.version = CACHE_VERSION;
                cache.spamIndex = {};
                cache.spamClassifiedAt = null;
            }
            if (cache.version !== CACHE_VERSION) { resolve(null); return; }
            resolve(cache);
        });
    });
}

export async function saveCache(cache) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.set({ [STORAGE_KEY]: cache }, () => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve();
        });
    });
}

export async function clearCache() {
    return new Promise((resolve, reject) => {
        chrome.storage.local.remove(STORAGE_KEY, () => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve();
        });
    });
}

export function emptyCache() {
    return {
        version: CACHE_VERSION,
        scannedAt: null,
        newestMessageId: null,
        messageIndex: {},
        senderMeta: {},
        spamIndex: {},
        spamClassifiedAt: null,
    };
}

// ─── Inbox merge helpers ──────────────────────────────────────────────────────

export function mergeIntoCache(cache, newMessages) {
    for (const { id, email, displayName } of newMessages) {
        cache.messageIndex[id] = email;
        if (!cache.senderMeta[email] || displayName) {
            cache.senderMeta[email] = { displayName: displayName || email };
        }
    }
    cache.scannedAt = Date.now();
    return cache;
}

export function evictSenderFromCache(cache, email) {
    for (const [id, senderEmail] of Object.entries(cache.messageIndex)) {
        if (senderEmail === email) {
            delete cache.messageIndex[id];
            delete cache.spamIndex[id];
        }
    }
    delete cache.senderMeta[email];
    return cache;
}

export function buildSenderList(cache) {
    const counts = {};
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

// ─── Spam helpers ─────────────────────────────────────────────────────────────

/**
 * Merges a Map<msgId, { label, score }> from the classifier into cache.spamIndex.
 * Only stores SPAM results to keep the cache lean.
 *
 * @param {object} cache
 * @param {Map<string, { label, score }>} classifyResults
 */
export function mergeSpamResults(cache, classifyResults) {
    for (const [id, { label, score }] of classifyResults) {
        if (label === 'SPAM') {
            cache.spamIndex[id] = { label, score };
        } else {
            // Remove if previously marked spam and now re-classified
            delete cache.spamIndex[id];
        }
    }
    cache.spamClassifiedAt = Date.now();
    return cache;
}

/**
 * Returns all message IDs in the cache that are classified as SPAM,
 * grouped by sender email.
 *
 * @param {object} cache
 * @returns {Map<string, string[]>}  email → [msgId, …]
 */
export function getSpamBySender(cache) {
    const map = new Map(); // email → [id]
    for (const [id, { label }] of Object.entries(cache.spamIndex)) {
        if (label !== 'SPAM') continue;
        const email = cache.messageIndex[id];
        if (!email) continue; // message evicted
        if (!map.has(email)) map.set(email, []);
        map.get(email).push(id);
    }
    return map;
}

/**
 * Returns a sorted list of spam senders with counts.
 *
 * @param {object} cache
 * @returns {Array<{ email, displayName, spamCount }>}
 */
export function buildSpamSenderList(cache) {
    const spamBySender = getSpamBySender(cache);
    return Array.from(spamBySender.entries())
        .map(([email, ids]) => ({
            email,
            displayName: cache.senderMeta[email]?.displayName || email,
            spamCount: ids.length,
        }))
        .sort((a, b) => b.spamCount - a.spamCount);
}

/**
 * Total number of cached spam messages.
 * @param {object} cache
 */
export function totalSpamCount(cache) {
    return Object.keys(cache.spamIndex).length;
}

/**
 * Message IDs not yet run through the spam classifier.
 * Used so incremental scans only classify new messages.
 *
 * @param {object} cache
 * @returns {string[]}
 */
export function getUnclassifiedIds(cache) {
    return Object.keys(cache.messageIndex).filter(
        (id) => !(id in cache.spamIndex)
    );
}