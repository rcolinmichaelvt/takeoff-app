# Backend dependencies

Milestone 3 adds two exact runtime dependencies, with transitive versions and integrity hashes recorded in `package-lock.json`:

| Package | Version | Purpose | Upstream |
| --- | --- | --- | --- |
| `@js-temporal/polyfill` | 0.5.1 | Timezone-aware calendar/opening-hours arithmetic | [Temporal polyfill](https://github.com/js-temporal/temporal-polyfill) |
| `geo-tz` | 8.1.10 | Server-side timezone lookup from a public store coordinate | [node-geo-tz](https://github.com/evansiroky/node-geo-tz) |

Install from `backend` using `npm ci --ignore-scripts`. Railway's Dockerfile uses the same lock with `--omit=dev`. The app has no new Swift packages. Dependency code and timezone data are installed by npm, not bundled into the source update ZIP; their license/notice files remain in the installed packages.

`geo-tz` performs geographic lookups locally using its packaged boundary data; store coordinates are not uploaded to another timezone service. Its polygon cache is bounded to 16 entries. Ambiguous boundary matches suppress timing predictions. Both the packaged boundary data and Node's timezone rules may need maintenance as jurisdictions change their clocks.

Apple Maps ETA requests use the existing native MapKit API: [MKDirections](https://developer.apple.com/documentation/mapkit/mkdirections). Only the saved ZIP center and public store destination are used. Prediction logic remains on the server; no server Apple Maps credentials are added to the app.

DG's public directory uses the store-info endpoint and `storeinfo` envelope; see [the Blacksburg directory](https://www.dollargeneral.com/store-directory/va/blacksburg). The exact authenticated hours payload still needs the live check described in the upgrade guide.
