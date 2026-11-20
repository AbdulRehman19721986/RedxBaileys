<h1 align="center">
  <img alt="RedxBaileys logo" src="https://raw.githubusercontent.com/WhiskeySockets/Baileys/refs/heads/master/Media/logo.png" height="75"/>
</h1>

<div align="center">

# RedxBaileys — v7.0.0-rc16

**Fork of [@WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys) — patched for WhatsApp November 2026 compatibility.**

Maintained by **Abdul Rehman Rajpoot**

</div>

---

## What is RedxBaileys?

RedxBaileys is a patched fork of the Baileys WebSocket library for WhatsApp Web.  
It fixes all breaking issues introduced by WhatsApp's **November 2026** protocol update, so your bots and automations keep working without modification.

---

## ✅ Fixes in v7.0.0-rc16

### 1. `Platform.WEB` → `Platform.MACOS` (Critical)
**File:** `src/Utils/validate-connection.ts`

WhatsApp's November 2026 update began rejecting connections that identify as `Platform.WEB`. Non-Android companions now must use `Platform.MACOS`.

- `platform` field: `WEB` → `MACOS`
- `osVersion`: `'0.1'` → `'14.4.1'` (realistic macOS version)
- `device`: `'Desktop'` → `'Mac'`
- `osBuildNumber`: `'0.1'` → `'23E224'` (realistic macOS build)

---

### 2. Default Browser Changed to `androidPhone` (View-Once Fix)
**File:** `src/Defaults/index.ts`

Default browser changed from `Browsers.macOS('Chrome')` to `Browsers.androidPhone('Chrome')`.

WhatsApp only fanouts view-once messages to Android companions. Using `androidPhone` as default means view-once messages are received properly out of the box — no config needed.

---

### 3. New `Browsers.androidPhone` Added
**File:** `src/Utils/browser-utils.ts`  
**File:** `src/Types/index.ts`

Added a new `androidPhone` browser variant:
```ts
Browsers.androidPhone('Chrome') // → ['Chrome', 'Android', '15']
```
Registers as Android 15 companion. Use this explicitly if you override the browser config and still need view-once support.

---

### 4. `view_once_unavailable_fanout` Handled Gracefully
**File:** `src/Socket/messages-recv.ts`

Previously, `view_once_unavailable_fanout` messages were silently dropped with no event emitted. Now:
- A stub message is emitted with `messageStubParameters` containing `'view_once_unavailable'`
- Your app can display a "View once: unavailable" placeholder to the user
- Message is properly ACK'd to WhatsApp

---

### 5. `fetchLatestBaileysVersion` Now Uses Live WA Version
**File:** `src/Utils/generics.ts`

`fetchLatestBaileysVersion` previously fetched from GitHub (slow, often stale by days).  
Now delegates directly to `fetchLatestWaWebVersion`, which queries the live WhatsApp Web service worker (`sw.js`) for the real current version.

- Faster connection startup
- Always gets the actual current WA version
- Chrome user-agent updated to **136** to bypass WA anti-bot detection

---

### 6. npm Package Identity

`@redxmini/redx-baileys` is the independent npm package name for this fork. It is not the official upstream `@whiskeysockets/baileys` package. Update your dependency and import name when switching to this fork.

---

## Install

### From npm (recommended)
```bash
npm install @redxmini/redx-baileys
```

### From GitHub
```bash
npm install github:AbdulRehman19721986/RedxBaileys
```

### In your `package.json`
```json
"@redxmini/redx-baileys": "^7.0.0-rc16"
```

---

## Quick Start

```ts
import makeWASocket, { Browsers, useMultiFileAuthState } from '@redxmini/redx-baileys'

const { state, saveCreds } = await useMultiFileAuthState('auth')

const sock = makeWASocket({
    auth: state,
    // androidPhone is the default — view-once works out of the box
    // override only if needed:
    // browser: Browsers.androidPhone('Chrome')
})

sock.ev.on('creds.update', saveCreds)
```

---

## Disclaimer

This project is not affiliated with, associated with, authorized by, or endorsed by WhatsApp or Meta.  
"WhatsApp" and related marks are registered trademarks of their respective owners.  
Use responsibly and in accordance with WhatsApp's Terms of Service.

---

<div align="center">

**RedxBaileys v7.0.0-rc16** — Maintained by Abdul Rehman Rajpoot  
Based on [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys)

</div>

## November 2026 compatibility and performance updates

- The bundled WhatsApp Web fallback revision is synchronized to `2.3000.1054660005`, published by the upstream automated version-update PR on 15 November 2026. Runtime version discovery still checks `https://web.whatsapp.com/sw.js` and uses the bundled revision only when live discovery fails.
- Encrypted WhatsApp `MESSAGE_EDIT` envelopes are authenticated and decrypted into `messages.update` events when the original message is available through `getMessage` with its `messageContextInfo.messageSecret` intact. The application message store must preserve that field.
- Legacy `MESSAGE_EDIT` events without a target message ID are logged and skipped rather than being emitted with an incorrect message key.
- A view-once fanout explicitly marked unavailable on a non-Android companion is acknowledged and surfaced as an unavailable stub; the library no longer issues an additional placeholder resend for that known-unavailable case.
- PN↔LID mapping updates are serialized and unchanged mappings are a fast no-op. Forced Signal-session refresh is limited to new or changed mappings; known LIDs use normal session validation.
- Offline stanza backlogs use a head-index FIFO queue to avoid repeated `Array.shift()` reindexing while retaining ordered processing and event-loop yielding.

These changes target specific compatibility and hot-path issues. Actual throughput still depends on network latency, server-side WhatsApp behavior, host resources, and the application-provided message store.

## Safe API parity and built-in feature overview

RedxBaileys implements the useful WhatsApp multi-device APIs from the reference package without depending on or embedding `@rakku-kun/baileys`.

### Pairing, identity and LID/JID helpers

- Pairing code: `sock.requestPairingCode(phoneNumber)`
- Check numbers: `sock.onWhatsApp(phoneNumber)`
- Resolve PN to LID: `await sock.getLIDForPN('923000000000@s.whatsapp.net')`
- Resolve LID to PN: `await sock.getPNForLID('123456789@lid')`
- JID helpers: `jidEncode`, `jidDecode`, `jidNormalizedUser`, `isJidGroup`, `isJidNewsletter`, and related helpers are exported from the package.

### Messages, media and account operations

The socket includes message sending and media upload/download, forwarding, edit/delete, view-once, reactions, polls, receipts/read state, presence, profile picture/status/name updates, status lookup, business profile lookup, blocklist actions, chat modifications, disappearing messages, call events and call rejection.

### Groups, communities and newsletters

Group APIs include metadata, creation, participant updates, subject/description, invite links, settings, disappearing mode and join-approval requests. Community and newsletter sockets provide their respective metadata, management, follow/unfollow, mute/unmute, reactions and message operations.

### Optional in-memory store

The optional store collects chat, contact and message events, keeps a bounded message history per chat (1000 by default), supports message lookup for retry/decryption flows, and can read/write a JSON snapshot. It is not enabled automatically; bind it explicitly.

```ts
import makeWASocket, { makeInMemoryStore, useMultiFileAuthState } from '@redxmini/redx-baileys'

const store = makeInMemoryStore({ maxMessagesPerChat: 1000 })
store.readFromFile('./baileys_store.json')

const { state, saveCreds } = await useMultiFileAuthState('./auth')

const sock = makeWASocket({
  auth: state,
  getMessage: async key => {
    if (!key.remoteJid || !key.id) return undefined
    return store.loadMessage(key.remoteJid, key.id)?.message
  }
})

store.bind(sock.ev)
sock.ev.on('creds.update', saveCreds)

// Optional periodic snapshot; synchronous disk I/O is kept outside message handlers.
const storeSnapshot = setInterval(() => store.writeToFile('./baileys_store.json'), 10_000)
storeSnapshot.unref?.()

// Call this during your own graceful shutdown handler.
const saveStore = () => {
  clearInterval(storeSnapshot)
  store.writeToFile('./baileys_store.json')
  store.close()
}
```

For large production histories, use a database-backed message store instead of keeping unbounded history in process memory. The built-in store is intentionally bounded and optional.


## StableBail-compatible additions in rc16

- `checkStatusWA(number, options?)` provides a best-effort registration status signal (`active`, `banned`, `blocked`, `rate_limited`, or `error`) without connecting your bot account. WhatsApp may rate-limit or change this undocumented endpoint; it is not an official ban-verification API.
- WMex responses are parsed more defensively, including JSON embedded after binary prefixes.
- Newsletter metadata can be recovered from structured binary-node fields when the server returns a binary response. Opaque payloads with no decodable field boundaries fall back to channel-ID recovery rather than fabricated metadata.

Example:

```ts
import { checkStatusWA } from '@redxmini/redx-baileys'

const result = await checkStatusWA('923001234567')
console.log(result.status, result.isBanned)
```
