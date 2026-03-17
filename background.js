/**
 * background.js — Service Worker
 *
 * Handles all long-running tasks: inbox scanning, spam classification,
 * and bulk trash. Maintains runningState so the popup can restore itself.
 *
 * Message types (popup → background):
 *   GET_AUTH_TOKEN      → { token } | { error }
 *   SIGN_OUT            → { success } | { error }
 *   START_SCAN          → incremental inbox scan
 *   FORCE_FULL_SCAN     → clear cache + full inbox scan
 *   RUN_SPAM_SCAN       → classify all unclassified messages via local BERT server
 *   DELETE_SENDER       → trash all emails from a sender
 *   TRASH_SPAM          → trash all cached spam messages
 *   GET_CACHE_INFO      → { scannedAt, totalCached, spamCount, spamClassifiedAt }
 *   GET_UI_STATE        → { uiState }
 *   ACK_DELETED         → sync totalDeleted back from popup
 *
 * Progress events broadcast to popup:
 *   SCAN_PROGRESS       → { phase, completed, total, isIncremental }
 *   SCAN_COMPLETE       → { senders, scannedAt, wasIncremental, newCount }
 *   SCAN_ERROR          → { message }
 *   SPAM_SCAN_PROGRESS  → { phase, completed, total }
 *   SPAM_SCAN_COMPLETE  → { spamSenders, spamCount, spamClassifiedAt }
 *   SPAM_SCAN_ERROR     → { message }
 *   DELETE_PROGRESS     → { phase, completed }
 *   DELETE_COMPLETE     → { email, trashed }
 *   DELETE_ERROR        → { message }
 */

import { getAuthToken, revokeToken } from './auth.js';
import { scanNewMessages, getAllMessageIds, batchTrashMessages } from './gmailApi.js';
import {
  loadCache, saveCache, clearCache, emptyCache,
  mergeIntoCache, evictSenderFromCache, buildSenderList,
  mergeSpamResults, buildSpamSenderList, totalSpamCount, getUnclassifiedIds,
} from './cache.js';
import { classifyMessages, isServerAvailable } from './spamApi.js';

// ─── Running state ────────────────────────────────────────────────────────────

let runningState = {
  status: 'idle',   // 'idle'|'scanning'|'scan_complete'|'spam_scanning'|'deleting'
  progress: null,
  scanResult: null,
  spamResult: null,     // { spamSenders, spamCount, spamClassifiedAt }
  deleteTarget: null,
  totalDeleted: 0,
};

// ─── Message router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {
    case 'GET_AUTH_TOKEN':
      handleGetToken(sendResponse);
      return true;

    case 'SIGN_OUT':
      handleSignOut(payload.token, sendResponse);
      return true;

    case 'START_SCAN':
      if (runningState.status === 'scanning') {
        sendResponse({ started: false, alreadyRunning: true }); return false;
      }
      handleStartScan(payload.token, false);
      sendResponse({ started: true });
      return false;

    case 'FORCE_FULL_SCAN':
      if (runningState.status === 'scanning') {
        sendResponse({ started: false, alreadyRunning: true }); return false;
      }
      handleStartScan(payload.token, true);
      sendResponse({ started: true });
      return false;

    case 'RUN_SPAM_SCAN':
      if (runningState.status === 'spam_scanning') {
        sendResponse({ started: false, alreadyRunning: true }); return false;
      }
      handleSpamScan(payload.token);
      sendResponse({ started: true });
      return false;

    case 'DELETE_SENDER':
      handleDeleteSender(payload.token, payload.email);
      sendResponse({ started: true });
      return false;

    case 'TRASH_SPAM':
      handleTrashSpam(payload.token);
      sendResponse({ started: true });
      return false;

    case 'GET_CACHE_INFO':
      handleGetCacheInfo(sendResponse);
      return true;

    case 'GET_UI_STATE':
      sendResponse({ uiState: runningState });
      return false;

    case 'ACK_DELETED':
      runningState.totalDeleted = payload.totalDeleted;
      return false;

    default:
      sendResponse({ error: `Unknown message type: ${type}` });
      return false;
  }
});

// ─── Auth handlers ────────────────────────────────────────────────────────────

async function handleGetToken(sendResponse) {
  try {
    const token = await getAuthToken(true);
    sendResponse({ token });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

async function handleSignOut(token, sendResponse) {
  try {
    if (token) await revokeToken(token);
    await clearCache();
    runningState = { status: 'idle', progress: null, scanResult: null, spamResult: null, deleteTarget: null, totalDeleted: 0 };
    sendResponse({ success: true });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

async function handleGetCacheInfo(sendResponse) {
  const cache = await loadCache();
  sendResponse({
    scannedAt: cache?.scannedAt ?? null,
    totalCached: cache ? Object.keys(cache.messageIndex).length : 0,
    spamCount: cache ? totalSpamCount(cache) : 0,
    spamClassifiedAt: cache?.spamClassifiedAt ?? null,
  });
}

// ─── Inbox scan ───────────────────────────────────────────────────────────────

async function handleStartScan(token, forceFull) {
  runningState.status = 'scanning';
  runningState.progress = { phase: 'listing', completed: 0, total: null, isIncremental: false };
  runningState.scanResult = null;

  try {
    if (forceFull) await clearCache();

    const cache = (await loadCache()) ?? emptyCache();
    const newestKnownId = cache.newestMessageId;
    const knownIds = new Set(Object.keys(cache.messageIndex));
    const wasIncremental = !forceFull && newestKnownId !== null;

    runningState.progress.isIncremental = wasIncremental;
    broadcastToPopup({ type: 'SCAN_PROGRESS', payload: runningState.progress });

    const { newMessages, newestSeenId } = await scanNewMessages(
      token,
      { newestKnownId, knownIds },
      {
        onPageFetched: (count, isIncremental) => {
          runningState.progress = { phase: 'listing', completed: count, total: null, isIncremental };
          broadcastToPopup({ type: 'SCAN_PROGRESS', payload: runningState.progress });
        },
        onMetadataProgress: (completed, total) => {
          runningState.progress = { phase: 'metadata', completed, total, isIncremental: wasIncremental };
          broadcastToPopup({ type: 'SCAN_PROGRESS', payload: runningState.progress });
        },
      }
    );

    mergeIntoCache(cache, newMessages);
    if (newestSeenId) cache.newestMessageId = newestSeenId;
    await saveCache(cache);

    const senders = buildSenderList(cache);
    const result = { senders, scannedAt: cache.scannedAt, wasIncremental, newCount: newMessages.length };

    runningState.status = 'scan_complete';
    runningState.progress = null;
    runningState.scanResult = result;

    // Carry over any existing spam result
    if (cache.spamClassifiedAt) {
      runningState.spamResult = {
        spamSenders: buildSpamSenderList(cache),
        spamCount: totalSpamCount(cache),
        spamClassifiedAt: cache.spamClassifiedAt,
      };
    }

    broadcastToPopup({ type: 'SCAN_COMPLETE', payload: result });
  } catch (err) {
    console.error('Scan failed:', err);
    runningState.status = 'idle';
    runningState.progress = null;
    broadcastToPopup({ type: 'SCAN_ERROR', payload: { message: err.message } });
  }
}

// ─── Spam scan ────────────────────────────────────────────────────────────────

async function handleSpamScan(token) {
  runningState.status = 'spam_scanning';

  try {
    // 1. Check server is up
    const available = await isServerAvailable();
    if (!available) {
      runningState.status = runningState.scanResult ? 'scan_complete' : 'idle';
      broadcastToPopup({
        type: 'SPAM_SCAN_ERROR',
        payload: { message: 'Spam classifier server is not running. Start it with: ./spam_server/start.sh' },
      });
      return;
    }

    const cache = await loadCache();
    if (!cache || Object.keys(cache.messageIndex).length === 0) {
      runningState.status = 'idle';
      broadcastToPopup({ type: 'SPAM_SCAN_ERROR', payload: { message: 'No emails scanned yet. Run a scan first.' } });
      return;
    }

    // 2. Only classify messages not yet in the spam index
    const unclassifiedIds = getUnclassifiedIds(cache);

    broadcastToPopup({
      type: 'SPAM_SCAN_PROGRESS',
      payload: { phase: 'fetching', completed: 0, total: unclassifiedIds.length },
    });

    // 3. Classify
    const classifyResults = await classifyMessages(token, unclassifiedIds, {
      onFetchProgress: (completed, total) => {
        broadcastToPopup({
          type: 'SPAM_SCAN_PROGRESS',
          payload: { phase: 'fetching', completed, total },
        });
      },
      onClassifyProgress: (completed, total) => {
        broadcastToPopup({
          type: 'SPAM_SCAN_PROGRESS',
          payload: { phase: 'classifying', completed, total },
        });
      },
    });

    // 4. Merge results into cache
    mergeSpamResults(cache, classifyResults);
    await saveCache(cache);

    const spamSenders = buildSpamSenderList(cache);
    const spamCount = totalSpamCount(cache);
    const spamClassifiedAt = cache.spamClassifiedAt;

    const spamResult = { spamSenders, spamCount, spamClassifiedAt };
    runningState.spamResult = spamResult;
    runningState.status = runningState.scanResult ? 'scan_complete' : 'idle';

    broadcastToPopup({ type: 'SPAM_SCAN_COMPLETE', payload: spamResult });
  } catch (err) {
    console.error('Spam scan failed:', err);
    runningState.status = runningState.scanResult ? 'scan_complete' : 'idle';
    broadcastToPopup({ type: 'SPAM_SCAN_ERROR', payload: { message: err.message } });
  }
}

// ─── Delete / trash handlers ──────────────────────────────────────────────────

async function handleDeleteSender(token, email) {
  runningState.status = 'deleting';
  runningState.deleteTarget = email;

  try {
    const allIds = await getAllMessageIds(token, `from:${email}`, (count) => {
      broadcastToPopup({ type: 'DELETE_PROGRESS', payload: { phase: 'listing', completed: count } });
    });

    if (allIds.length === 0) {
      runningState.status = runningState.scanResult ? 'scan_complete' : 'idle';
      runningState.deleteTarget = null;
      broadcastToPopup({ type: 'DELETE_COMPLETE', payload: { email, trashed: 0 } });
      return;
    }

    await batchTrashMessages(token, allIds);

    const cache = await loadCache();
    if (cache) { evictSenderFromCache(cache, email); await saveCache(cache); }

    if (runningState.scanResult) {
      runningState.scanResult.senders = runningState.scanResult.senders.filter(s => s.email !== email);
    }
    if (runningState.spamResult) {
      runningState.spamResult.spamSenders = runningState.spamResult.spamSenders.filter(s => s.email !== email);
      runningState.spamResult.spamCount = Math.max(0, runningState.spamResult.spamCount - allIds.length);
    }

    runningState.totalDeleted += allIds.length;
    runningState.status = runningState.scanResult ? 'scan_complete' : 'idle';
    runningState.deleteTarget = null;

    broadcastToPopup({ type: 'DELETE_COMPLETE', payload: { email, trashed: allIds.length } });
  } catch (err) {
    console.error('Delete failed:', err);
    runningState.status = runningState.scanResult ? 'scan_complete' : 'idle';
    runningState.deleteTarget = null;
    broadcastToPopup({ type: 'DELETE_ERROR', payload: { message: err.message } });
  }
}

async function handleTrashSpam(token) {
  runningState.status = 'deleting';

  try {
    const cache = await loadCache();
    if (!cache) {
      runningState.status = 'idle';
      broadcastToPopup({ type: 'DELETE_ERROR', payload: { message: 'No cache found.' } });
      return;
    }

    const spamIds = Object.keys(cache.spamIndex);
    if (spamIds.length === 0) {
      runningState.status = runningState.scanResult ? 'scan_complete' : 'idle';
      broadcastToPopup({ type: 'DELETE_COMPLETE', payload: { email: '__spam__', trashed: 0 } });
      return;
    }

    broadcastToPopup({ type: 'DELETE_PROGRESS', payload: { phase: 'listing', completed: spamIds.length } });

    await batchTrashMessages(token, spamIds);

    // Remove trashed messages from cache
    for (const id of spamIds) {
      const email = cache.messageIndex[id];
      delete cache.messageIndex[id];
      delete cache.spamIndex[id];
      if (email) {
        // If sender has no messages left, evict their meta
        const remaining = Object.values(cache.messageIndex).filter(e => e === email);
        if (remaining.length === 0) delete cache.senderMeta[email];
      }
    }
    await saveCache(cache);

    // Rebuild results
    if (runningState.scanResult) {
      runningState.scanResult.senders = buildSenderList(cache);
    }
    runningState.spamResult = { spamSenders: [], spamCount: 0, spamClassifiedAt: cache.spamClassifiedAt };
    runningState.totalDeleted += spamIds.length;
    runningState.status = runningState.scanResult ? 'scan_complete' : 'idle';

    broadcastToPopup({ type: 'DELETE_COMPLETE', payload: { email: '__spam__', trashed: spamIds.length } });
  } catch (err) {
    console.error('Trash spam failed:', err);
    runningState.status = runningState.scanResult ? 'scan_complete' : 'idle';
    broadcastToPopup({ type: 'DELETE_ERROR', payload: { message: err.message } });
  }
}

// ─── Broadcast helper ─────────────────────────────────────────────────────────

function broadcastToPopup(message) {
  chrome.runtime.sendMessage(message).catch(() => { });
}