# Calendar update · Takeoff 0.4.2

This update applies on top of the **Milestone 4.1** code you already received. It is an incremental ZIP, not a standalone project. It adds the calendar, moderator images, private events, calendar display options, inbox clearing, and the unchanged-stock overnight fix. Your free Personal Team remains sufficient for local testing. No paid Apple capability is added.

## 1. Back up the existing Railway database

Use a shell **inside the existing Railway API service**, in `/app`, with the existing `/data` volume attached:

```sh
npm run backup -- /data/before-calendar.sqlite
```

Choose a different filename if it exists. Keep a protected off-service copy through your existing backup workflow. A file on the same volume is useful for migration recovery but shares the volume's failure risk. Do not commit SQLite files, backups, `.env`, cookies, or credentials to GitHub.

The new server upgrades schema 4 to 5 transactionally, adding calendar tables without replacing existing settings, sessions, notes, favorites, stock or trips. Event images live in SQLite, so subsequent consistent backups include them. Existing schema 1–4 backups remain supported by `prepare-restore`; see [backend recovery](../backend/SETUP.md). Rolling code back to 0.4.1 alone cannot read schema 5. A database rollback requires the documented prepared-backup restore and loses post-backup changes, including new calendar events.

## 2. Merge the changed files and deploy Railway

1. Unzip **takeoff-calendar-update.zip** outside your existing project. Its top-level `backend`, `ios` and `docs` folders match your repository.
2. Copy the files into the same paths in your existing repository, replacing the matching files. **Merge folder contents; do not replace entire folders.** The ZIP contains only changed files. [CALENDAR_FILES.md](CALENDAR_FILES.md) lists every path.
3. Keep your existing `ios/Takeoff/AppConfiguration.swift`, `.xcodeproj`, Info.plist and `backend/catalog.json`. They are intentionally absent from the ZIP. Keep your Railway variables and volume.
4. From `backend` on your Mac, use Node **24.x**:

   ```sh
   node --version
   npm ci --ignore-scripts
   npm test
   ```

   The new pinned `sharp` dependency resizes and sanitizes moderator images. Upload **both** `package.json` and `package-lock.json`; do not upload `node_modules`. The existing Docker build installs dependencies, including the supported Linux native image package. No separate image service, storage account, API key or DG endpoint is needed.

5. Commit/upload the changed `backend` files to your private repository and let **the existing Railway API service** deploy. Keep its root directory `backend`, its `/data` volume, and one replica. Keep the existing monitor settings. Look for `Takeoff API v0.4.2 listening…` and healthy readiness.
6. To publish shared events, your Discord ID must be in **both** `ALLOWED_DISCORD_IDS` and `MODERATOR_DISCORD_IDS`. Reuse the moderator variable already used for public store notes; multiple IDs are comma-separated. Apply/redeploy a variable change. The account's numeric ID stays out of the app's Settings UI.

No Discord OAuth redirect changes are needed. The API origin stays `https://takeoff-app-production-966b.up.railway.app`.

## 3. Add the new file in Xcode

1. After merging the updated Swift files, open **your existing** `ios/Takeoff.xcodeproj`.
2. In the Project navigator, select the **Takeoff** source group containing AppModel.swift and Models.swift.
3. Choose **File → Add Files to “Takeoff”…** and select the new file at `ios/Takeoff/CalendarView.swift` in your existing project folder.
4. In the add dialog, make sure the **Takeoff app target** is checked. Do not add it to TakeoffTests. Since the file is already in the correct folder, reference it there rather than creating a second copy. Some Xcode versions label this choice “Reference files in place.”
5. Select CalendarView.swift in the navigator and check the right File inspector's **Target Membership → Takeoff**. If it was added automatically by your project, verify membership rather than adding a duplicate.
6. Keep your existing Team, bundle identifier, signing capabilities and Railway URL. Run the **Takeoff** scheme on your iPhone with **Command-R**.
7. Run **Command-U** with an iPhone simulator destination for the 14 included XCTest cases. These tests do not sign in or transfer your account.

If Xcode says `Cannot find 'CalendarView' in scope`, check step 5. If a type is declared twice, remove the duplicate file reference, keeping the source file on disk. The new Swift types in Models.swift and AppModel.swift require those files to be updated together.

The full project in source control also includes the new file reference. The incremental ZIP leaves your customized project untouched, so the manual membership step matters. After adding it locally, commit your updated project file if you use Git to keep your Mac's project in sync.

## 4. Use the calendar

Fully close and reopen the app after the backend deployment so it reloads your account capabilities and role. If Calendar still shows “Update Railway,” sign out and back in **on the same phone**. A normal sign-in on the same installation is not a device transfer.

- Open **Calendar**. Choose a day in the month grid; dots indicate events. Tap **Today** to return. Tap an event to see its image and details.
- Tap **+** to create a private event. Private events are visible only to their owner, including when another account is a moderator.
- For a shared event, a moderator chooses **Members · moderator post** under “Who can see this?” Enter a title, retailer, store/address, dates and description. Tap **Choose image** to select an image using the system photo picker, then Save.
- A moderator post with a five-digit area ZIP is shown to members whose saved ZIP centers are within 25 miles of it. Leave ZIP blank for an event shared with all members, such as a product release. Moderators can see and manage all moderator posts. Creating an event never starts monitoring that ZIP.
- Weekly repeats keep the event's local wall-clock time. The editor identifies that timezone; the calendar agenda displays times in the viewing iPhone's timezone. A repeat can run for about six months. Editing/deleting affects the entire series, not one occurrence.
- Tap the filter button for moderator/private visibility and **DG predictions → Favorites only / All nearby stores**. Predictions default to favorites, appear in a collapsed section, and group followed products into one card per store/date. The first three show before “Show all.” Excluded stores stay hidden.
- **Favorites** moved to the **star at the top left of Discover**. Existing favorites and exclusions are retained.

Moderator events are labeled by source; publishing a calendar post is not proof that a product is on a store shelf. Images are optional, resized to at most 1,200 pixels per side and re-encoded on the server with metadata removed. They are fetched through the authenticated device API, not public URLs. Existing images are preserved when editing text; use Remove image to delete one.

The DG section uses the existing medium/high-confidence forecasts for a **currently observed back-stock batch**. It does not invent recurring delivery weekdays from product counts. A separate model for predicting truck days needs distinct delivery episodes and continuous-coverage evidence; that remains future work. Display filters do not change polling or existing stock-alert preferences.

The calendar refreshes while visible and active, approximately every minute; pull down to refresh immediately. Calendar events do not create notification reminders in this release. The normal stock inbox still refreshes with the app. APNs/TestFlight remain the later paid-developer milestone.

## 5. Clear the inbox

Open **Inbox → Clear all notifications**, then confirm. This deletes that account's existing server inbox, including older pages. An alert arriving after the newest event shown when clearing is retained. Other accounts, stock history, timing averages, preferences, and future alerts are unaffected. There is no undo; the confirmation explains the deletion.

## 6. What happened with “resumed 2 → 2”

`resumed` was an internal observation-continuity label: the previous successful quantity was more than nine minutes old. It was **not a Railway restart log**. The old code reset stock to unknown even when the next fresh result was the same quantity. We have not inspected the production logs/database, so the cause of the exact 1:20 AM observation gap is not established.

The fix:

- A fresh unchanged result preserves the previous stock inference and pending quantity. Recent “likely in stock” signals still expire seven days after the latest decrease.
- Stale data remains gray until a fresh observation arrives. A changed quantity across a real gap follows the existing conservative rules; lower positive quantity still supplies a sale signal.
- Unchanged `resumed` entries are no longer written to stock history, and old unchanged entries are omitted when history is read. They do not create notifications.
- A normal closed-hours gap can preserve a clean timing batch when reliable unchanged hours show at most nine open-store minutes were missed. A real open-hours outage invalidates its timing sample. Closed hours never inflate the average.
- On startup, old unknown/back-stock resets are repaired only where the retained history establishes a prior back-stock state at the same quantity and all intervening gap observations are unchanged. Repair creates no new alert or timing sample. If that evidence has expired from the seven-day history or contains a conflicting quantity, the app waits for new evidence instead.

## 7. Check on your phone

1. Create a moderator event with a photo. A second allowed account can view it and its image but cannot edit/delete it. Check both an area ZIP event and an all-members event.
2. Create a private event; confirm another account, even a moderator, cannot see it. Use a separate allowed account/device for this check, rather than transferring your account between devices.
3. Edit text without choosing another image; confirm the image stays. Replace/remove it, check a weekly series, then relaunch/redeploy and verify persistence.
4. Clear the inbox and confirm existing items disappear while stock history remains. Check the next real eligible stock change still arrives in the inbox.
5. After the next fresh unchanged poll, inspect a store affected by the old overnight reset. If retained history supports repair, back stock should be yellow again. A stale store stays gray until fresh data arrives.
6. Confirm Favorites in Discover and both calendar prediction options. No prediction is expected without a fresh batch and sufficient timing confidence.

**Validation here:** 121 backend tests pass. All 16 Swift files pass grammar parsing. Xcode/iOS SDK compilation and photo-picker/on-device rendering are not available in this workspace; run the Mac checks above. No Railway deployment or GitHub push was performed here.

## Deferred by your request

Community stock posting is not included. The recorded rule for that future feature is: text-only reports are unverified; product photo evidence must be captured in-app, with no photo-library uploads. Moderator calendar artwork is a separate use case and supports loading existing images. Automatic truck-day predictions, calendar reminders/export, and other retailer monitoring remain future work.
