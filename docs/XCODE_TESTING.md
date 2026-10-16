# Run Takeoff on your iPhone with Xcode

Takeoff includes a real SwiftUI project at `ios/Takeoff.xcodeproj`. Open that project directly. The app targets **iPhone, iOS 17.0 or later**, uses Swift 5 language mode, and has no external Swift packages. Your reported iPhone on iOS 26.2 meets the deployment target. Xcode still needs the appropriate device support installed locally.

The source and project structure were checked in a Linux workspace. **An Xcode build and on-device run have not been performed here.** The included ten XCTest cases are ready to run on your Mac.

## 1. Upgrade your existing Railway backend first

Follow [MILESTONE_4_UPGRADE.md](MILESTONE_4_UPGRADE.md) when updating the working Milestone 3 app. Keep the existing project/signing configuration; the update only changes already-included Swift files. A fresh setup also needs the settings, store, note, inventory, and travel endpoints. Keep the same service URL and persistent `/data` volume.

You can test Discord sign-in and save a ZIP before enabling DG monitoring. An empty map is expected until the worker has valid DG credentials and at least one member has saved a ZIP and selected products.

Confirm these existing Railway values:

| Railway setting | Value |
| --- | --- |
| `PUBLIC_BASE_URL` | Your API's HTTPS origin, such as `https://takeoff-api-example.up.railway.app` |
| `APP_CALLBACK_URL` | `takeoff://auth/callback` |
| `ALLOWED_DISCORD_IDS` | Your numeric Discord user ID |
| `MODERATOR_DISCORD_IDS` | Your ID too, if you want to test public notes |

In the Discord Developer Portal, the registered OAuth redirect is **your Railway URL plus `/v1/auth/discord/callback`**. The `takeoff://` URL is the second hop, from your backend into the app; it is already registered in the project's Info.plist.

For an incremental update, merge the ZIP into the existing repository first. The ZIP is not a standalone Xcode project. All changed Swift types are in existing target members; keep your current project, signing Team and bundle ID.

## 2. Open the project

1. Unzip the download into a normal folder on your Mac. Keep the `ios/Takeoff`, `ios/TakeoffTests`, and `ios/Takeoff.xcodeproj` items together.
2. Open Xcode and finish any first-run component installation.
3. Choose **File → Open**, select `ios/Takeoff.xcodeproj`, and open it. You can also double-click that file in Finder.
4. In the left Project navigator, expand the **Takeoff** source group and open **AppConfiguration.swift**.
5. Replace this one line with your real Railway origin:

   ```swift
   static let apiBaseURL = "https://YOUR-BACKEND.up.railway.app"
   ```

   Use `https://`, with no `/v1`, `/health`, or callback path. This is the **only server value** the app needs. DG cookies, DG authorization headers, and the Discord client secret stay in Railway Variables.

## 3. Select your Apple account and signing team

1. Open **Xcode → Settings → Accounts** and add your Apple Account if it is not already listed.
2. Click the blue **Takeoff** project icon at the top of the Project navigator.
3. Under **TARGETS**, select **Takeoff** and open **Signing & Capabilities**.
4. Keep **Automatically manage signing** checked.
5. Choose your **Personal Team** in the Team menu.
6. Replace `com.yourname.takeoff` with a unique bundle identifier, for example `com.colinmichael.takeoff.dev`. If Apple reports that it is already used, choose another unique identifier.
7. If you run the tests on a physical device, also select **TakeoffTests**, choose the same Team, and set its bundle identifier to `com.colinmichael.takeoff.dev.tests` (matching your own chosen prefix).

There are no Push Notifications, App Attest, or shared-Keychain entitlements in this local-testing target. Ordinary app Keychain storage, Secure Enclave signing, MapKit display, and Discord browser sign-in do not need a shared-Keychain capability. Keep the bundle identifier stable across normal rebuilds so the app retains its installation identity.

## 4. Connect and prepare your iPhone

1. Connect your iPhone to the Mac, unlock it, and accept **Trust This Computer** if prompted.
2. In Xcode, open **Window → Devices and Simulators**. Confirm your iPhone appears and allow pairing/device preparation to finish.
3. Enable **Settings → Privacy & Security → Developer Mode** on the iPhone, restart when asked, then confirm Developer Mode. The setting may appear after you first pair with Xcode.
4. In the run destination menu near Xcode's Run button, choose **your actual iPhone** and the **Takeoff** scheme. `Any iOS Device` is an archive/build destination, not your connected phone.
5. Choose **Product → Run** or press **Command-R**. Follow any device trust prompts shown by Xcode/iOS. If iOS asks you to trust a developer profile, use **Settings → General → VPN & Device Management** for your own Apple account's profile.

Xcode may ask to download an iOS platform component. Use the component it requests. If it explicitly says the phone OS is unsupported, update Xcode/device support to a compatible version. You do not need to raise the app's minimum iOS version to the SDK version.

Official references: [running on a device](https://developer.apple.com/documentation/xcode/running-your-app-in-simulator-or-on-a-device), [Developer Mode](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device).

## 5. First run inside Takeoff

1. Tap **Continue with Discord**, approve the browser prompt, and sign in using the account on your server allowlist.
2. Enter one five-digit US ZIP, or tap **Use current location for ZIP**. Location fills the field once; press Save/Start to commit it. Traveling later will not move your monitoring area.
3. Select your products from the curated catalog and tap **Start exploring**. Selecting no products creates no monitoring work for your account.
4. Open **Discover**. Use the list/map toggle, item filter, and **Your area / All covered areas** control. The app refreshes approximately every 30 seconds while active; you can refresh manually.
5. Tap a store. Check product quantities and observation times, favorite/exclude it, and save a private note. Moderators can separately save a public note. Drive estimates are requested from your saved ZIP's center, on demand and gradually during foreground refresh. They can be unavailable. Store details also show opening-hours timing, confidence, and forecasts as clean samples accumulate.
6. Open **Inbox** for changes selected by your alert preferences from the last seven days. In **Settings → Alerts & pause**, choose event types or pause notifications. Paused events remain in the inbox.

A green pin means at least one filtered product is likely for sale; yellow means back stock when no filtered product is green; gray means uncertain data when neither green nor yellow applies; red means all observed filtered products are sold out. The store detail shows each observed product separately. Initial positive observations are gray until enough changes are observed. Observations older than nine minutes, or without an active subscription covering them, also show unknown.

The server uses DG coordinates if supplied. Otherwise it resolves public store addresses using the US Census geocoder. This runs separately from stock polling. Some addresses may not resolve; those stores still appear in the list when their distance is known. Geocoded coordinates are labeled in details. Use the Trips tab to suggest a one-way route, edit stops, and open it in Apple Maps. Full route handoff uses iOS 18.4 or later; older supported iOS opens only the first stop.

## 6. Run the included iOS checks

Choose an installed **iPhone simulator** as the destination, keep the **Takeoff** scheme selected, then press **Command-U**. The ten tests cover:

- Exact request-signing bytes and verification of a Node-generated P-256 DER signature.
- Callback origin/state validation and rejection of duplicate login codes.
- Stale stock losing its sale claim while retaining the last observed quantity.
- Partial preference updates omitting unrelated fields.
- New prediction payloads decoding without changing observed shelf status.
- Older inbox payloads without address/prediction fields remaining readable.
- Ordered Maps waypoints and the final one-way destination.
- Rejection of invalid coordinates, empty routes, and more than ten stops.
- Older alert preferences retaining choices while defaulting Trip changes on.
- Preview requests omitting unmeasured legs and owner fields.

These tests do not sign in or contact Railway. A simulator is a **different installation** if you later sign into it. Moving the same Discord account between your phone and a simulator invokes the six-hour transfer rule. The simulator uses a development-only software signing key; physical phones use Secure Enclave. For normal development, test the UI signed in on one installation at a time.

## 7. What the free Personal Team can do

| Capability | This local build with a free Personal Team |
| --- | --- |
| Install and run on your own iPhone | Yes, with Apple's free provisioning limits |
| Discord sign-in and Railway HTTPS requests | Yes |
| Refresh map/details while the app is open | Yes |
| Retrieve missed alerts on reopening | Yes |
| Native stock-change push while the app is closed | **No** |
| TestFlight distribution | **No** |

A real server-originated phone push requires the Apple Developer Program and the APNs work in Milestone 5. A local notification cannot discover a new server change while the app is suspended. This milestone does not add background polling or local reminder notifications.

Free provisioning profiles expire after seven days; reconnect and run from Xcode again when necessary. Rebuilding with the same signing identity/bundle identifier is preferable to deleting the app. Keychain identity can survive reinstalling, so deletion is not a way to reset the server's cooldown.

Sources: [Apple developer account overview](https://developer.apple.com/help/account/basics/about-your-developer-account), [membership comparison and Personal Team limits](https://developer.apple.com/support/compare-memberships/), [iOS capability availability](https://developer.apple.com/help/account/reference/supported-capabilities-ios).

## Troubleshooting

| What you see | What to check |
| --- | --- |
| `node: bad option: --test` on your Mac | Terminal is still using old Node. Install Node **24.x**, reopen Terminal, run `node --version` and `which node`, then run `npm test` from `backend`. Xcode does not run Node. |
| Signing requires a development team | Select your Personal Team on the **Takeoff target**, not only the project. Check TakeoffTests too if running tests on the phone. |
| Bundle identifier unavailable | Choose a unique bundle identifier and let automatic signing refresh. |
| Project opens but no files/build target appear | Open the supplied `.xcodeproj`; preserve the sibling source/test directories. Avoid dragging duplicate copies into a blank project. |
| “Set your Railway HTTPS URL” | Replace the placeholder in `Takeoff/AppConfiguration.swift`, then build again. |
| Server response does not match this app / endpoint missing | Deploy the Milestone 4 backend update to the API service, then retry. A healthy older API can still lack the new endpoints. |
| Discord invalid redirect | Match the exact HTTPS callback in Discord to Railway's `PUBLIC_BASE_URL`. |
| Discord access denied | Check the numeric user ID and the signed-in Discord account; apply the Railway allowlist change. |
| Invalid or expired sign-in code | Restart sign-in and complete the device-transfer prompt within two minutes. |
| Device transfer cooldown | Keep using the currently authorized installation, or wait for the stated deadline. Reinstalling/signing out does not remove it. |
| Request signature/time error | Turn on automatic date and time on the phone and confirm the backend clock. |
| Map remains empty | Check selected products, saved ZIP, `DG_MONITOR_ENABLED`, server credentials, and the monitor status in Settings. `/health/ready` checks database access, not live DG inventory. |
| Pins missing but stores appear in the list | Store coordinates may still be resolving or no unambiguous address match was found. |
| Gray stock | Early monitoring, lost coverage, or no successful fresh check. This is intentionally different from sold out. |
| Driving estimate unavailable | Keep using the stock/list information and try later. Network, Maps availability, signing environment, or missing coordinates can prevent estimates. |
| No phone notification while closed | Expected with this milestone/Personal Team. Read the inbox on reopening; APNs comes in Milestone 5. |

For build errors, copy the **first red compiler error and its file/line** from Xcode's Issue navigator (Command-5). Do not include credentials or full HTTP authorization logs.

## Later: TestFlight

After enrolling in the Apple Developer Program, Milestone 5 will connect APNs registration/delivery to the authorized installation, add server-validated App Attest, and prepare an App Store Connect app record. Real APNs can be tested on an Xcode-installed development build before TestFlight. TestFlight builds use the production APNs environment. Distribution also needs privacy/account-deletion/review preparation; a capability checkbox alone does not implement these features.

Use the paid Team, finalize the bundle ID, choose a device archive destination, and **Product → Archive → Organizer → Distribute App → App Store Connect** once that milestone is ready. Complete the required build information and add TestFlight testers; external testing may require beta review. Whop/payment entitlement integration remains deferred.

See [Apple's beta distribution guide](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases).
