# Notifications

uniharn's gateway watches sessions, tasks and Git and turns what needs you into notifications. They are shown in the app while it is open, and delivered as **Web Push** to browsers and installed PWAs when the app is closed. Native Android (FCM) and iOS (APNs) push are **not** shipped; the reasons and what they would need are below.

## Events

| Event | Fires when | Lock-screen text (details hidden) |
| --- | --- | --- |
| `approval_requested` | An agent asks for permission to run a tool | A session is waiting for your approval. |
| `task_completed` | A session goes `running` → `idle`, or a task exits with code 0 | A session finished its work. |
| `execution_failed` | A session goes `running` → `error`, a task exits non-zero, or a subagent fails | A session stopped with an error. |
| `subagent_completed` | The orchestrator emits `subagent_completed` on the harness registry (`notifySubagentCompleted`) | A subagent finished its task. |
| `git_conflict` | `git.status` reports conflicted files (once per new set of files per repo) | A repository has merge conflicts. |
| `gateway_disconnected` | The gateway receives `SIGINT`/`SIGTERM` (pushed before exit), or the app loses the gateway for more than 2 s (local, in-app/system notification) | The gateway went offline. |
| `attention_needed` | An approval stays unanswered for the attention timeout (default 5 min), or a `running` session shows no activity for twice that | A session needs your attention. |

## How it works

- `gateway/src/notifications.ts` (`NotificationService`) assigns each notification a monotonic `seq`, keeps the newest 200 in memory, and broadcasts `notification`, `notification_read` and `notifications_cleared` over the WebSocket. `hello` carries `notifications.unreadCount` and `notifications.lastSeq`.
- **Duplicates**: each notification has a `dedupKey` (e.g. one per permission request or task id); the same key is dropped inside `dedupWindowMs` (default 60 s). Repeated `git.status` polls with the same conflict set fire once.
- **Reconnect consistency**: after every reconnect the app calls `notifications.list({ sinceSeq })` and adds what it missed, banners only the newest one, and resets its list if the gateway restarted (lower `lastSeq`).
- **Sensitive content**: titles and bodies are always scrubbed of bearer tokens, `sk-…`, `ghp_…`, `tskey-…`, `xox…-`, AWS keys, private keys, `#token=` and `password=` style values. With *Hide details on lock screen* (default on) Web Push and system notifications carry only the generic text in the table above; the full text stays inside the authenticated app.
- **Web Push**: the gateway generates a VAPID key pair on first start and sends RFC 8291 `aes128gcm`-encrypted messages with [`web-push`](https://github.com/web-push-libs/web-push). Subscriptions answered with HTTP 404/410 are deleted. `app/static/sw.js` shows the notification (unless a focused app window is already showing the banner) and opens the related session on tap.

Files in the gateway data dir (`~/.local/share/uniharn`), all mode `0600`:

| File | Contents |
| --- | --- |
| `notifications-prefs.json` | Preferences |
| `notifications-vapid.json` | VAPID key pair (ignored when `UNIHARN_VAPID_PUBLIC_KEY` / `UNIHARN_VAPID_PRIVATE_KEY` are set) |
| `notifications-push-subs.json` | Push subscriptions (endpoint + keys) |

`UNIHARN_VAPID_SUBJECT` sets the VAPID contact (default `mailto:uniharn@localhost`). Changing the VAPID key invalidates existing subscriptions; the app re-subscribes on its next connect.

## Settings

Settings → Notifications: master switch, in-app banners, *Hide details on lock screen*, Web Push on/off for this device, one switch per event, and *Send test notification*. Preferences live on the gateway, so they apply to every device. The timeouts can be changed with `notifications.prefs.set` (`dedupWindowMs`, `attentionTimeoutMs`).

RPCs: `notifications.list`, `.read`, `.clear`, `.prefs.get`, `.prefs.set`, `.capabilities`, `.test`, `.push.publicKey`, `.push.subscribe`, `.push.unsubscribe`, `.push.list`.

## Platform support

| Platform | Status | Works when the app is closed |
| --- | --- | --- |
| In-app (any client) | Available | No |
| Web Push: Chrome, Edge, Firefox (desktop, Android) | Available over HTTPS or localhost | Yes |
| Web Push: Safari macOS 13+ | Available over HTTPS | Yes |
| Web Push: iOS/iPadOS 16.4+ | Only from a PWA added to the Home Screen, over HTTPS | Yes |
| Android native app (Tauri APK) | FCM **not implemented**, needs external setup | No |
| iOS native app (unsigned / personal-team IPA) | APNs **blocked by signing** | No |

### Web Push needs HTTPS: use `tailscale serve`

Browsers only allow service workers and push on secure origins. The gateway listens on plain HTTP, so put Tailscale's HTTPS proxy in front of it:

```sh
tailscale serve --bg 8787          # https://<machine>.<tailnet>.ts.net → http://127.0.0.1:8787
```

Open `https://<machine>.<tailnet>.ts.net` on the phone, pair as usual, then Settings → Notifications → Web Push → Turn on. On iPhone/iPad, first tap Share → Add to Home Screen and open uniharn from the Home Screen icon. The push itself travels from the gateway to the browser vendor's push service (FCM for Chrome, Mozilla autopush, Apple's web push service), so the gateway needs outbound internet access; it does not need to be reachable from the internet.

### Android native push (FCM): requires external setup

The Tauri APK's WebView has no Web Push. Native push would need:

1. A Firebase project, with the app id `me.gomq.devinmobile` registered and `google-services.json` built into the APK.
2. A Firebase Messaging plugin for Tauri v2 (there is no official one) to obtain the FCM token and show notifications.
3. A Firebase service-account key on the gateway to call the FCM HTTP v1 API.
4. Android 13+ `POST_NOTIFICATIONS` runtime permission.

None of these exist in this repository or its CI, so `notifications.capabilities` reports `androidFcm: requires_external_setup` and the feature is not treated as done. Workaround today: open the gateway's `tailscale serve` URL in Chrome on Android (or install it as a PWA) and turn on Web Push; this works with the app closed.

### iOS native push (APNs): blocked by signing

APNs delivery requires the `aps-environment` entitlement in the signed app. That entitlement can only be granted through a provisioning profile from a **paid Apple Developer Program** team with an App ID that has the Push Notifications capability. Consequences:

- **Unsigned IPA** (what CI builds, sideloaded with AltStore/Sideloadly/TrollStore-style tools): re-signing with a free Apple ID strips or cannot add `aps-environment`; `registerForRemoteNotifications` fails, so no device token exists.
- **Personal (free) team signing** in Xcode: the Push Notifications capability is not available to personal teams at all.
- Even with a paid account, the gateway would also need an APNs auth key (`.p8`, key id, team id) and the app a native plugin to register and forward the device token.

So `notifications.capabilities` reports `iosApns: blocked_by_signing`. Workaround today: on iOS/iPadOS 16.4+, add the `tailscale serve` URL to the Home Screen and turn on Web Push there; Apple delivers it with the PWA closed, without any developer account.

### In-app

While the app is open and connected, every enabled event shows a banner and lands in the bell menu on the home screen. If the app is in the background without Web Push, it falls back to a system notification when the OS permission was granted (this only works while the OS keeps the socket alive).

## Tests

`gateway/test/notifications.test.ts` covers all seven events, dedup inside/after the window, catch-up by `seq`, redaction and lock-screen-safe payloads, preference persistence (`0600`), attention timers and their clearing, real VAPID + `aes128gcm` delivery to a local HTTPS push endpoint (decrypted in the test) with HTTP 410 cleanup, env VAPID keys, and the reported platform capabilities.
