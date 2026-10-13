# Xcode, iPhone testing, and notifications

**There is no Xcode project in Milestone 1.** The current code is the server foundation. This guide records the signing and device setup for the SwiftUI project in Milestone 2; it is not asking you to create a blank replacement app now.

Your reported setup is macOS Tahoe 26.3, Xcode 26.4.1, and an iPhone 17 running iOS 26.2. The first app should target iPhone and set its minimum iOS version no higher than 26.2 so it can run on that phone. The Mac/Xcode combination and installed device support still need to be checked in your local Xcode; this Linux workspace cannot compile an iOS app or verify those versions firsthand.

## What the free account can do

| Capability | Free Personal Team | Paid Apple Developer Program |
| --- | --- | --- |
| Build and install on your own iPhone from Xcode | Yes, with signing limits | Yes |
| Sign in with Discord and use the Railway HTTPS API | Yes | Yes |
| Fetch inventory/inbox while the app is open | Yes, after those features are implemented | Yes |
| Fetch missed alerts when you reopen the app | Yes, after the client exists | Yes |
| Schedule a local notification on the phone | Yes, with permission and app implementation | Yes |
| Receive native APNs pushes from Railway | No | Yes, after APNs setup |
| TestFlight distribution | No | Yes, after App Store Connect setup |
| App Attest integration | Not available with the needed Personal Team capability | Available with supported devices and setup |

A local notification is scheduled by the phone based on information it already has. It can fire later, but it cannot learn about a new server-side stock change while the app is suspended. Keeping a network connection open, using background refresh, or scheduling a repeating task is not a reliable substitute for APNs.

Apple's free provisioning profiles expire after seven days, so expect to rebuild/reinstall periodically. The paid program is currently listed at US $99 annually, with regional pricing/taxes potentially differing. You can test real APNs in an Xcode-installed development build after enrolling; publishing to the App Store first is unnecessary. Local test notifications are not proof that server push is working.

Sources: [Apple developer account limits](https://developer.apple.com/help/account/basics/about-your-developer-account), [supported iOS capabilities](https://developer.apple.com/help/account/reference/supported-capabilities-ios), [program membership](https://developer.apple.com/programs/), [local notification scheduling](https://developer.apple.com/documentation/usernotifications/scheduling-a-notification-locally-from-your-app).

## Prepare Xcode and your iPhone

1. Open Xcode, finish its first-run component installation, then open **Xcode → Settings → Accounts** and add your Apple Account. It should show a Personal Team when you are not enrolled in the paid program.
2. Connect and unlock the iPhone. Accept Trust This Computer when prompted. Open **Window → Devices and Simulators** in Xcode and confirm the phone is paired and available. Install the required platform/device support if Xcode requests it.
3. On the iPhone, enable **Settings → Privacy & Security → Developer Mode**, restart, and confirm. This option may appear only after pairing with Xcode. See [Apple's Developer Mode instructions](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device).
4. When the Takeoff project is supplied, open its `.xcodeproj`, select the Takeoff app target, and choose **Signing & Capabilities**. Enable automatic signing, select your Personal Team, and use a unique bundle identifier such as `com.yourname.takeoff`.
5. Keep the free-testing target free of paid-only entitlements such as Push Notifications and App Attest. The Discord callback scheme is `takeoff`; the project will register its URL type. This scheme is separate from the HTTPS callback registered in Discord.
6. Set the app's environment configuration to the new Railway HTTPS API base URL. Only the base URL belongs in the app configuration; Discord's client secret and DG credentials stay in Railway.
7. Select the physical iPhone as the run destination and use **Product → Run**. Follow any device trust instructions shown by Xcode/iOS. The phone must be online to authenticate and load server data.

See [Apple's device run instructions](https://help.apple.com/xcode/mac/current/en.lproj/dev5a825a1ca.html). The project-specific filenames and build settings will be included with the actual Milestone 2 source; they do not exist yet in this delivery.

## First device checks when the client is ready

- Start Discord sign-in inside Takeoff, accept the browser prompt, and return to the app. Verify your displayed Discord account and catalog.
- Configure your one saved ZIP, select approved products, and compare the map with server observations. Early/unknown data must not be labeled ready for sale.
- Close and reopen the app to check session restoration and the missed-alert inbox.
- Test an explicit device transfer using a second installation. The first installation must lose API access; a further transfer must respect six hours.
- Test after a Railway redeployment to verify that your preferences, sessions, and stock history remain on the volume once those features are connected.

The simulator is a separate installation from the physical phone. Treat changing between them as a device transfer for the same Discord account. A simulator cannot establish a real Secure Enclave/App Attest result. Use separate allowed test accounts if frequent transfers would interfere with development; do not disable the six-hour rule in production.

## Later: APNs and TestFlight

1. Enroll in the Apple Developer Program and select that paid team in Xcode. Confirm the intended bundle ID and ownership before creating the App Store Connect app record.
2. Enable Push Notifications for the app identifier and target. Create an APNs authentication key and store the `.p8` private key, Key ID, Team ID, and bundle ID on the backend. Never include the `.p8` key in the app or repository.
3. Implement notification permission requests, APNs device registration, server registration bound to the active session, delivery retries, invalid-token handling, and device-transfer revocation. Development builds use the appropriate development APNs environment; TestFlight uses production. Keep token/environment pairs distinct.
4. Test actual server-originated changes on the physical iPhone, including background delivery, denied permissions, app reopening, old-device revocation, and missed events. Push delivery is best effort; the server inbox remains the record of missed alerts.
5. Implement and verify App Attest separately. Turning on a capability alone does not implement server validation.
6. Create the App Store Connect record, configure signing, select a device archive destination, and use **Product → Archive**. In Organizer, validate and distribute to App Store Connect. Complete the requested build/privacy/export information, then add TestFlight testers. External testing can require beta review.

TestFlight is for beta distribution. Payment access through Whop and final App Store release requirements will be designed later; no external-payment flow is being implemented or promised approval here. Recheck the applicable distribution and payment rules when that milestone starts.

See [Apple's beta distribution guide](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases) and [APNs token authentication](https://developer.apple.com/help/account/capabilities/communicate-with-apns-using-authentication-tokens).
