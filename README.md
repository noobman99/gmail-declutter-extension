# Gmail Declutterer — Chrome Extension

A Chrome extension that scans your Gmail inbox, surfaces the biggest email senders, and lets you bulk-delete them — all via the official Gmail API (no DOM scraping).

## Setup Instructions

### Step 1 — Create a Google Cloud Project

1. Go to [https://console.cloud.google.com](https://console.cloud.google.com)
2. Click **New Project**, give it a name (e.g. `Gmail Declutterer`), click **Create**
3. Make sure your new project is selected in the top dropdown

### Step 2 — Enable the Gmail API

1. In the left sidebar go to **APIs & Services → Library**
2. Search for **Gmail API**
3. Click it, then click **Enable**

### Step 3 — Configure the OAuth Consent Screen

1. Go to **APIs & Services → OAuth consent screen**
2. Choose **External** and click **Create**
3. Fill in:
   - App name: `Gmail Declutterer`
   - User support email: your email
   - Developer contact: your email
4. Click **Save and Continue** through Scopes (you'll add them later)
5. On **Test users**, add your own Gmail address (You can also publish it to allow all users)
6. Click **Save and Continue** → **Back to Dashboard**

### Step 4 — Load the Extension in Chrome

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right)
3. Click **Load unpacked**
4. Select the `gmail-cleaner-extension` folder
5. The extension will appear — copy its **Extension ID**
6. Go back to Google Cloud Console → Credentials → edit your OAuth client and paste the Extension ID

### Step 5 — Create an OAuth 2.0 Client ID

1. Go to **APIs & Services → Credentials**
2. Click **+ Create Credentials → OAuth client ID**
3. Application type: **Chrome Extension**
4. Name it anything (e.g. `Gmail Declutterer Extension`)
5. **Item ID** — you need your extension's ID first:
   - Load the extension (see Step 4), then copy the ID from `chrome://extensions`
   - Come back and paste it here, then save
6. Copy the **Client ID** shown (ends in `.apps.googleusercontent.com`)

### Step 6 — Update manifest.json and Reload Extension

Open `manifest.json` and replace:

```json
"client_id": "YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com"
```

with your actual Client ID from Step 4.

Now reload your chrome extensions from `chrome://extensions`

### Step 7 — Enjoy life

1. Click the extension icon in Chrome's toolbar
2. Click **Connect with Google** and sign in
3. Click **Start Scan** to begin scanning your inbox
4. Browse senders, click **View** to see emails, or **Delete all** to bulk-remove
