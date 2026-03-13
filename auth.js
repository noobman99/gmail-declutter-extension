/**
 * auth.js
 * Handles Google OAuth2 authentication via Chrome Identity API.
 * All token management, refresh, and revocation live here.
 */

const AUTH_TOKEN_KEY = 'gmail_auth_token';

/**
 * Requests an OAuth2 access token interactively (shows Google sign-in popup).
 * @returns {Promise<string>} The access token.
 */
export async function getAuthToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!token) {
        reject(new Error('No token returned from identity API'));
      } else {
        resolve(token);
      }
    });
  });
}

/**
 * Removes the cached OAuth token and forces re-authentication next time.
 * @param {string} token - The token to revoke.
 */
export async function revokeToken(token) {
  return new Promise((resolve, reject) => {
    chrome.identity.removeCachedAuthToken({ token }, async () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      // Also revoke server-side so it doesn't linger on Google's end
      try {
        await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`);
      } catch (_) {
        // Best-effort revocation — ignore network errors
      }
      resolve();
    });
  });
}

/**
 * Fetches a fresh token silently (non-interactive).
 * Returns null if the user is not already signed in.
 */
export async function getSilentToken() {
  try {
    return await getAuthToken(false);
  } catch (_) {
    return null;
  }
}

/**
 * Checks whether the user is currently authenticated.
 * @returns {Promise<boolean>}
 */
export async function isAuthenticated() {
  const token = await getSilentToken();
  return token !== null;
}
