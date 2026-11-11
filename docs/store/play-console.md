# Google Play Console — App content answers (draft)

Drafts for Play Console › Policy › App content, checked 2026-10-14. Data safety:
`play-data-safety.md`. Behaviour source: docs/PRIVACY.md and the ADRs named below. Re-check
before each release that changes networking, permissions or SDKs.

## Privacy policy

URL: `https://anywecon.github.io/selis/privacy/` (website/, generated from docs/PRIVACY.md; Greek at
`/el/privacy/`). Play requires a public, non-PDF, non-geofenced page
(<https://support.google.com/googleplay/android-developer/answer/10144311>).

## Store listing languages

Default language: **English (United States) – en-US** (chosen when the app is created: Play
Console › Create app › Default language). Greek (el-GR) is added afterwards as a translation (Grow
users › Store presence › Main store listing › Manage translations › Add your own translations).
Texts: `fastlane/metadata/android/en-US/` (default) and `el-GR/` (ADR 0030).

**Store images are English-only** (owner decision, 2026-10-16; ADR 0024 amendment): icon, feature
graphic and phone screenshots exist only in `fastlane/metadata/android/en-US/images/`. The Greek
listing has its own texts and changelogs but no graphics, so Play (and F-Droid) show the en-US
images for it. No Greek store screenshots are made (`store-screenshots.sh` takes `en` only); Greek
UI pictures exist for tests only (Playwright visual snapshots). CI fails if
`fastlane/metadata/android/<locale>/images` exists for any locale other than en-US
(`scripts/check-store-images.sh`). In the Console, the Greek translation carries no graphics of
its own.

## App signing (before the first release of any kind)

Our own app signing key, not Google's default (ADR 0025): Protected with Play › Play Store
distribution › Go to Play app signing › Change the app signing key › Provide a copy of your app
signing key (PEPK), plus the upload certificate. Exact steps: `scripts/android-keystore.md`
step 5.

## App access

All functionality is available without special access (no login, no account).

## Ads

"No, my app does not contain ads."

## Content rating (IARC questionnaire)

Category: **All Other App Types** (utility / productivity). Answers:

| Question area | Answer | Note |
| --- | --- | --- |
| Violence, fear, sexuality, nudity, language, controlled substances, crude humour | No | The app shows only the user's own documents |
| Gambling / simulated gambling | No | |
| Users can interact or exchange content | **Yes** | Transfer sends documents to another device whose user scans the QR code or opens the link (often the user's own device, but it can be someone else's). No chat, no public profiles, no accounts, no content moderation needed |
| Shares the user's current physical location with other users | No | |
| Allows users to purchase digital goods | No | |
| Unrestricted internet access (browser, search engine) | No | Links in a PDF open in the system browser only when tapped (as any app hands a link to the browser) |
| Is the app a web browser or search engine | No | |

Expected result: lowest age rating in every region (e.g. PEGI 3 / ESRB Everyone) with the
"Users Interact" interactive element.

## Target audience and content

Target age groups: **13–15, 16–17, 18 and over** (not designed for children; choosing under 13
would put the app under the Families policy). The store listing does not target children.

## News, government, financial, health apps

Not a news app; not a government app; no financial features; no health features.

## Foreground service permissions (Android 14+)

**No declaration** (ADR 0027, checked 2026-10-15). Play asks apps targeting Android 14+ to
declare "any foreground service types that you use" and recommends "the user-initiated data
transfer job instead of the dataSync foreground service type" for transfers the user starts
(<https://support.google.com/googleplay/android-developer/answer/13392821>). Selis now:

- Android 14+: a user-initiated data transfer job (`RUN_USER_INITIATED_JOBS`,
  `TransferJobService` in `TransferPlugin.kt`) while a transfer the user started is running; the
  system shows its notification and lists it in the Task Manager.
- Android 8–13: a foreground service **without a type** (`FOREGROUND_SERVICE` with
  `maxSdkVersion="33"`); types and their permissions only apply from Android 14.
- The manifest has no `foregroundServiceType` and no `FOREGROUND_SERVICE_*` type permission,
  so nothing triggers the declaration. If the form appears anyway: no foreground service types.
- No demo video is needed. Behaviour checked by `transfer-background.yaml` (Maestro): the app in
  the background for 60 s, the job running and the receive progressing throughout.

## Data safety

See `play-data-safety.md` ("No data collected", relay IP note).

## Permissions declarations

No sensitive permissions that need a declaration form (no SMS, call log, location, all-files
access, accessibility, VPN). Camera, notifications and background transfers are explained in
the listing and the privacy policy.
