# App Store — App Privacy ("nutrition label") and review notes (draft)

Drafts for App Store Connect › App Privacy, checked 2026-10-14
(<https://developer.apple.com/app-store/app-privacy-details/>). Behaviour source: docs/PRIVACY.md;
privacy manifest: `apps/app/src-tauri/gen/apple/selis-app_iOS/PrivacyInfo.xcprivacy`.

## Data collection

"Do you or your third-party partners collect data from this app?" → **No, we do not collect data
from this app.** Label shown: **Data Not Collected**.

Why this is accurate under Apple's definitions ("collect" = transmitted off the device in a way
that allows the developer or partners to access it for longer than needed to service the
request in real time):

- Documents, settings, signatures and the device key stay on the device. Nothing is sent to the
  developer; there is no server of ours.
- Transfers go from one of the user's devices to a device the user chooses, end-to-end
  encrypted. When no direct path exists, encrypted packets pass through n0's public relay
  (open source, replaceable in Settings, off with "Local network only"); the relay sees IP
  addresses only to forward packets in real time and cannot read content — not collection by
  the developer, and no data is retained by us. Mentioned in the privacy policy.
- No analytics, crash reporting, advertising or tracking SDKs; `NSPrivacyTracking` is false and
  there are no tracking domains.

## Privacy policy URL

`https://anywecon.github.io/selis/privacy/` (and `/el/privacy/`).

## Notes for App Review

- No account; every feature works without sign-in.
- Transfer needs a second device: the reviewer can open Transfer › Receive to see the QR scanner
  and the "Local network only" switch in Settings; a video of a transfer can be linked here.
- Camera: QR codes and document scan. Photos: the system picker (no library permission); "Save
  Image" from the share sheet asks for add-only access.
- Export compliance: see `ios-export-compliance.md` (decision pending).
- No donation links inside the iOS app (SPEC risk table); donations only on the website/README.

## App Store screenshots (required sizes)

The App Store needs iPhone 6.9" screenshots (1320 × 2868 or 1290 × 2796) and, because the app
also runs on iPad, 13" iPad screenshots (2064 × 2752). They come from the same six screens as
Play (`store-screenshots.md`); they cannot be made on the Android AVD — to be produced from the
iOS simulator in CI or on the owner's devices before the first App Store submission (TestFlight
does not need them).
