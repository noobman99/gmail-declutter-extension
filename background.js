/**
 * background.js — Service Worker
 *
 * Handles long-running tasks and owns the cache lifecycle.
 * Also maintains a `runningState` snapshot so the popup can restore
 * itself to the correct screen after being closed and reopened.
 *
 * Message types (popup → background):
 *   GET_AUTH_TOKEN   → { token } | { error }
 *   SIGN_OUT         → { success } | { error }
 *   START_SCAN       → starts incremental scan; streams progress events
 *   FORCE_FULL_SCAN  → clears cache first, then full scan
 *   DELETE_SENDER    → bulk-deletes + evicts sender from cache
 *   GET_CACHE_INFO   → { scannedAt, totalCached }
 *   GET_UI_STATE     → { uiState } — full snapshot for popup restore
 *
 * Progress events broadcast to popup:
 *   SCAN_PROGRESS    → { phase, completed, total, isIncremental }
 *   SCAN_COMPLETE    → { senders, scannedAt, wasIncremental, newCount }
 *   SCAN_ERROR       → { message }
 *   DELETE_PROGRESS  → { phase, completed }
 *   DELETE_COMPLETE  → { email, deleted }
 *   DELETE_ERROR     → { message }
 */

import { getAuthToken, revokeToken } from './auth.js';
import { scanNewMessages, getAllMessageIds, batchTrashMessages } from './gmailApi.js';
import {
  loadCache, saveCache, clearCache, emptyCache,
  mergeIntoCache, evictSenderFromCache, buildSenderList,
} from './cache.js';

// ─── Persistent UI state ──────────────────────────────────────────────────────
//
// Kept in the service-worker's memory (survives popup close/reopen as long as
// the SW is alive; Chrome keeps it alive while a task is running).
//
// Shape:
// {
//   status: 'idle' | 'scanning' | 'scan_complete' | 'deleting',
//   progress: { phase, completed, total, isIncremental } | null,
//   scanResult: { senders, scannedAt, wasIncremental, newCount } | null,
//   deleteTarget: string | null,   // email being deleted
//   totalDeleted: number,
// }

let runningState = {
  status: 'idle',
  progress: null,
  scanResult: null,
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
      // Ignore if already scanning
      if (runningState.status === 'scanning') {
        sendResponse({ started: false, alreadyRunning: true });
        return false;
      }
      handleStartScan(payload.token, false);
      sendResponse({ started: true });
      return false;

    case 'FORCE_FULL_SCAN':
      if (runningState.status === 'scanning') {
        sendResponse({ started: false, alreadyRunning: true });
        return false;
      }
      handleStartScan(payload.token, true);
      sendResponse({ started: true });
      return false;

    case 'DELETE_SENDER':
      handleDeleteSender(payload.token, payload.email);
      sendResponse({ started: true });
      return false;

    case 'GET_CACHE_INFO':
      handleGetCacheInfo(sendResponse);
      return true;

    case 'GET_UI_STATE':
      // Popup calls this on open to restore itself
      sendResponse({ uiState: runningState });
      return false;

    case 'ACK_DELETED':
      // Popup confirms it has processed a delete; update running total
      runningState.totalDeleted = payload.totalDeleted;
      return false;

    default:
      sendResponse({ error: `Unknown message type: ${type}` });
      return false;
  }
});

// ─── Handlers ─────────────────────────────────────────────────────────────────

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
    runningState = { status: 'idle', progress: null, scanResult: null, deleteTarget: null, totalDeleted: 0 };
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
  });
}

async function handleStartScan(token, forceFull) {
  // Update state to scanning
  runningState.status = 'scanning';
  runningState.progress = { phase: 'listing', completed: 0, total: null, isIncremental: false };
  runningState.scanResult = null;

  try {
    if (forceFull) await clearCache();

    const cache = (await loadCache()) ?? emptyCache();
    const newestKnownId = cache.newestMessageId;
    const knownIds = new Set(Object.keys(cache.messageIndex));
    const wasIncremental = !forceFull && newestKnownId !== null;

    // Update incremental flag in progress
    runningState.progress.isIncremental = wasIncremental;

    const progressEvent = { phase: 'listing', completed: 0, total: null, isIncremental: wasIncremental };
    broadcastToPopup({ type: 'SCAN_PROGRESS', payload: progressEvent });

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

    // Store completed result so popup can restore it after reopening
    runningState.status = 'scan_complete';
    runningState.progress = null;
    runningState.scanResult = result;

    broadcastToPopup({ type: 'SCAN_COMPLETE', payload: result });
  } catch (err) {
    console.error('Scan failed:', err);
    runningState.status = 'idle';
    runningState.progress = null;
    broadcastToPopup({ type: 'SCAN_ERROR', payload: { message: err.message } });
  }
}

async function handleDeleteSender(token, email) {
  runningState.status = 'deleting';
  runningState.deleteTarget = email;

  try {
    const query = `from:${email}`;

    const allIds = await getAllMessageIds(token, query, (count) => {
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
    if (cache) {
      evictSenderFromCache(cache, email);
      await saveCache(cache);
    }

    // Update the cached scan result to remove this sender
    if (runningState.scanResult) {
      runningState.scanResult.senders = runningState.scanResult.senders.filter(
        (s) => s.email !== email
      );
    }

    runningState.totalDeleted += allIds.length; // counts trashed emails
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function broadcastToPopup(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Popup may be closed — that's fine, state is preserved in runningState
  });
}