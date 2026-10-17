# Takeoff product ideas — proposals awaiting approval

These ideas are not implemented or added to the agreed milestones. The current patch contains only the four requested fixes. Keep the free local build while validating the experience; choose the next feature before implementation.

The most useful product question is: “Where should I go, what evidence says it is worth the drive, and what should I know before arriving?” Each addition should improve that decision. A large general chat feed would make it harder to find an actionable report.

## A calendar that stays readable

Start with an agenda showing Today and the next seven days, with an optional month view. Month cells show small indicators and a count; tapping a day opens details. Keep three independently selectable sources:

| Source | Example | Default behavior |
| --- | --- | --- |
| Moderator events | Product release; confirmed local store event | Show when relevant to followed products, retailers or area |
| Private events | “Check my Target Thursday”; personal reminder | Visible only to its owner; editable and recurring |
| Suggested restock windows | “DG on Main Street often restocks Wednesday afternoon” | Collapsed suggestions for favorite stores; never presented as a confirmed appointment |

For automatic suggestions, show at most three cards per day followed by “Show 4 more.” Limit them to favorite stores by default, with an optional watchlist later. Use one card per store and date, grouping all relevant products inside. Do not create separate events for every UPC increase. Predictions should be a computed calendar layer, not hundreds of permanent recurring events written to the user's calendar.

Example: “Wednesday · DG, 123 Main St · Possible shelf window 1–4 PM · Medium confidence · Based on 5 distinct deliveries.” Expanding it shows followed products and the evidence. The example is illustrative; these are not measurements from your account.

A moderator can post a specific store, a local area, a retailer-wide release, or a general product launch. A national release does not mean every local store has stock. Event cards should say Confirmed, Reported, or Predicted according to their source. Source-specific badges should use text and icons as well as color, without competing with the map's stock colors.

Personal recurring events can be simple weekly reminders. A generated prediction has different behavior: recompute it as data changes, retain a stable store/date identity, and withdraw it when its evidence becomes insufficient. A user-created reminder must not move just because a prediction changes. If a moderator event and prediction concern the same store and day, group them visually while preserving their separate sources and editable records.

Suggested reminders should initially be off. Let users explicitly remind themselves about a particular event, favorite store, or followed release. Delivery changes should update that event instead of producing repeated reminders. Private scheduled reminders could use local notifications later; server-driven live changes still need APNs for reliable delivery when the app is closed.

## Teaching DG restock patterns without inventing certainty

There are two predictions: which day stock may arrive, and how much open-store time it usually takes to begin selling. Keep them separate. A Wednesday delivery near closing might predict shelf availability on Thursday.

The current timing model counts clean product batches, so its existing day counts must not be treated as independent trucks. The future calendar model should:

1. Retain compact store-level arrival episodes and monitoring-coverage intervals. Merge increases for several products close together at one store into a candidate delivery episode. The merge window needs calibration against your real logs; a time cluster is not proof of one truck.
2. Learn from roughly the latest 8–12 weeks, with recent observations weighted more strongly. This is a proposed starting window. Preserve uncertainty for outages, overlapping deliveries and partial monitoring.
3. Count distinct observed deliveries. A possible initial threshold is at least four episodes across three different weeks before suggesting a weekday; validate the threshold during the pilot.
4. Consider the days the store was actually observed. Four Wednesday deliveries while monitoring only Wednesdays cannot establish “Wednesday is the best day.” Also, monitoring a few Pokémon UPCs observes their arrivals, not every truck at the store.
5. Produce a broad time window and low/medium/high confidence rather than a precise percentage unsupported by validation. Use store-local hours to carry pending time into the next open day.
6. Downgrade or hide the suggestion when patterns move, coverage lapses, samples get old, or outcomes repeatedly miss the window. Let members dismiss a suggestion or mark “This pattern seems wrong” for review.

After a real increase, replace the general expectation on that store's card with the live batch estimate. After a qualifying decrease, show the observed result. Keep one card instead of adding another. An expected time alone must never turn a pin green.

Evaluate predictions prospectively: did the next observed shelf signal fall within the displayed window, how wide was that window, and was coverage continuous? Do not count a period with no monitoring as a successful prediction or a definite miss. Historical events can be retained as small aggregates beyond the one-week public history, with a separate retention decision for private/community content.

## Community reports across retailers

Retailer support and automated monitoring are separate. Target, Walmart, GameStop, Costco, Sam's Club, Best Buy, grocery stores and independent card shops could start with curated store entries and member reports. Each retailer can gain a server adapter later only when its data source is understood and suitable. Do not promise automated stock for every retailer before verifying access and quality.

The first reporting flow should take a few taps: choose a store, select a product or set, choose what you personally saw, and record when you saw it. Offer “On shelf,” “Only a few left,” “Checked and empty,” and “Store says later.” Separate firsthand sightings from staff estimates. Optional notes/photos add evidence; exact quantity should not be required when someone cannot count it reliably. A broad “Pokémon products” report must not imply every followed SKU is present.

Keep product selection curated. Let members suggest a missing product/store into a review queue rather than creating unrestricted public catalog records. Store identity should use retailer plus branch identity; two retailers can both have store number 100. Normalize store addresses and merge duplicates through moderation. Product identity should retain package size, retailer SKU and UPC distinctions so a single pack is not confused with a multipack.

For each store/product, show a current report summary and an expandable timeline. Distinguish the time seen from the time uploaded. Group duplicate reports within a short window, and count one account's repeated updates as one source. A one-tap “Still here” or “Checked and gone” confirmation is more useful than an unstructured comment thread.

Community freshness should decay much faster than DG's seven-day sale-signal rule. A starting experiment could highlight a hot product sighting for 30–60 minutes, then label it old until reconfirmed; exact expiration should be calibrated by local demand. “Expired” means unknown, never proof of sold out. A new empty-shelf report does not erase an older report from history.

When sources conflict, show the conflict: “DG inferred stock; member found empty shelf 8 minutes ago.” Preserve both. A manual report must not overwrite the monitor's raw quantity or train its clean truck-to-sale average. A future route can warn about that conflict or let the user require recent confirmations.

Keep report visibility within the members/areas the owner approves. Make reporter display names optional and do not publish a person's precise location or movements. Optional location verification can attest that a report was submitted near a store, without showing the coordinate; it still cannot prove what was on the shelf. Photos should have location metadata removed and support removing unrelated people or receipt information before upload.

Community posting needs a small moderation workflow before it launches: report content, hide a reporter, remove incorrect posts, correct duplicate stores/products, and restrict abuse. Reuse Discord-ID moderator roles. Rate limits, one current report per account/store/product, server timestamps, and an audit trail help keep a small pilot manageable. Reward corroborated useful reports rather than volume; avoid a leaderboard that encourages spam or rushing to stores. These are proposed community features, not new admin controls in this patch.

## Features worth considering

| Idea | How it helps a shopper | Suggested stage |
| --- | --- | --- |
| Cross-retailer want list | Follow a set or exact product once and see all supported stores | After a common product/store catalog |
| Official retailer links | Open the exact product page to check ordering or pickup separately | Early; verify links and distinguish pickup from shelf stock |
| Store shopping guide | Where cards are located, behind-counter rules, limits and usual process | Early; public suggestions reviewed by moderators |
| Store policy history | Show who confirmed a limit and when; older policies become unverified | With community reports |
| “Worth the drive” list | Rank fresh relevant sightings by drive time, confidence, hours and product match | After report freshness is dependable |
| Shopping time budget | Build a route that fits 45 minutes and a chosen stop limit | Later trip improvement |
| Desired quantity / found it | Track a private shopping goal; optionally stop suggesting an item once obtained | After want lists |
| Detour suggestions | Offer a relevant nearby stop during a trip, with added driving time | Later; requires explicit foreground replan |
| Visited / skip stop | Remove completed stores and replan from current location | Useful next trip increment |
| Plan B store | Offer a replacement if the first store sells out or closes | Once live reports and trip updates work reliably |
| Private trip outcome | Record found, empty shelf, or skipped; ask separately before sharing a public report | With community reporting |
| Launch pages | Release date, package variants, verified retail price, limits and relevant events | With moderator calendar |
| Availability map by retailer | Filter the same map without mixing inferred and reported evidence | After canonical store identity |
| Price sightings | Compare recent store-reported prices with source/time, including member-only pricing labels | Later; no resell estimate presented as retail price |
| Stock-duration patterns | Estimate how quickly a store's stock usually disappears after a shelf signal | Only after enough complete observations; use ranges |
| Daily planning card | A few relevant events and fresh nearby sightings when the app opens | After calendar/report relevance is good |
| Optional alert controls | Quiet hours, per-product thresholds or “confirmed sightings only” | Later; requires your approval because current alerts are simpler |
| Calendar export | Add a chosen personal or moderator event to Apple Calendar | Later; explicit opt-in, with cancellation/update behavior defined |
| Store suggestions | Members propose an unsupported branch; moderators verify it | Before broad geographic expansion |
| Offline trip summary | Retain addresses and notes, with stock clearly labeled last known | Later travel convenience |

Keep announcements separate from urgent availability, but link an announcement to its product or calendar event. Favorites should eventually unify watched stores, products and upcoming events so users have one place to manage what matters. This may justify revisiting tab navigation later; adding a separate tab for every new feature would overcrowd the app.

## A practical development order

First validate the four fixes on your phone. Then, if approved, build the calendar with moderator and private events plus explicit recurrence rules; leave automatic predictions in a collapsed experimental layer until the model has independent episodes. Next pilot structured reports at a small set of local stores, with moderation and source labels from the start. Add other retailers through this shared store/report model before promising broad automated monitoring.

After the calendar and reports prove useful, connect them to want lists and routes. Buy Apple membership when you are ready to test real remote alerts and distribute the beta. Paid membership does not itself implement notifications, account entitlements, App Attest or moderation.

The most useful pilot measures are how often a fresh report leads to a successful visit, false “available” signals, time from sighting to report, active contributors per area, missed predictions during continuous coverage, and moderation effort. Raw post count or total map pins would be weaker measures of usefulness.

## Decisions before implementation

1. Calendar or community reports first? Recommendation: a small calendar first, unless reports from other retailers are your main immediate need.
2. Should new members' reports publish immediately with an Unverified label, or wait for a moderator? Recommendation: start with invited trusted reporters, then widen access once rate limits and reporting tools are tested.
3. Should automatic calendar suggestions show only favorite stores or all stores in the saved area? Recommendation: favorite stores, collapsed, with an explicit option to expand.
4. Can members submit product/store suggestions, or should moderators exclusively maintain the catalogs? Recommendation: submissions enter a private review queue.
5. For the initial pilot, should community reports be visible only near the saved ZIP, or across all supported areas? This is separate from the DG polling rule; reading a report must not start extra monitoring.

References for platform behavior: [Apple account and Personal Team overview](https://developer.apple.com/help/account/basics/about-your-developer-account), [membership pricing](https://developer.apple.com/programs/enroll/), [membership services](https://developer.apple.com/programs/whats-included/), [unified Maps URLs](https://developer.apple.com/documentation/mapkit/unified-map-urls). All feature priorities and thresholds above are proposals for this app, not retailer commitments or measured product outcomes.
