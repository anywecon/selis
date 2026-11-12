# iOS release and TestFlight — what the owner sets up

`.github/workflows/release-ios.yml` (ADR 0022) builds a signed App Store IPA on a `macos-26`
runner and uploads it to TestFlight. Signing is automatic with an App Store Connect API key:
Xcode makes and keeps the distribution certificate in Apple's cloud, so no `.p12` or
provisioning profile exists anywhere. Without the secrets the workflow skips with a notice.

## 1. Accounts (costs money — your call)

- Apple Developer Program: 99 USD / year (individual or organisation "Any WeCon"; an
  organisation needs a D-U-N-S number). <https://developer.apple.com/programs/enroll/>

## 2. App record (App Store Connect, once)

1. Certificates, Identifiers & Profiles › Identifiers: Xcode registers `com.anywecon.selis` on the
   first signed build; or add it by hand (App ID, no extra capabilities).
2. App Store Connect › Apps › + New App: platform iOS, name **Selis**, primary language English
   (U.S.), bundle ID `com.anywecon.selis`, SKU `selis`. Greek is added as a further localization
   (App Information › Localizable Information › language menu › Greek); texts in
   `fastlane/metadata/ios/en-US/` (primary) and `el/`, screenshots in `fastlane/screenshots/en-US/`.
   **Store images are English-only** (owner decision, 2026-10-16; ADR 0024 amendment): the Greek
   localization gets no screenshots of its own, so App Store Connect shows the primary language's
   (en-US) set for it. `ios-screenshots.yml` makes the English set only; CI fails if
   `fastlane/screenshots/<locale>` exists for any locale other than en-US
   (`scripts/check-store-images.sh`).
3. Note the app's **Apple ID** (App Information › General, a number) for the upload step.

## 3. API key and secrets

App Store Connect › Users and Access › Integrations › App Store Connect API › Team Keys › +:
name "Selis CI", access **Admin** (needed for cloud-managed distribution certificates). Download
the `.p8` once (it cannot be downloaded again). Note the **Key ID** and the **Issuer ID** (above
the table) and your **Team ID** (Membership details).

```powershell
gh secret set APPLE_API_KEY_ID -R anywecon/selis --body <KEY_ID>
gh secret set APPLE_API_ISSUER -R anywecon/selis --body <ISSUER_ID>
gh secret set APPLE_DEVELOPMENT_TEAM -R anywecon/selis --body <TEAM_ID>
Get-Content -Raw AuthKey_<KEY_ID>.p8 | gh secret set APPLE_API_KEY_P8 -R anywecon/selis
gh variable set APPSTORE_APP_APPLE_ID -R anywecon/selis --body <APP_APPLE_ID>
```

Keep the `.p8` in your password manager; revoke it in App Store Connect if it leaks.

## 4. Export compliance

Decided (ADR 0025): `ITSAppUsesNonExemptEncryption` = YES, no France at launch. Before the
first build: exclude France in Pricing and Availability, then answer the encryption questions as
`docs/store/ios-export-compliance.md` lists (standard algorithms, not in France: no document).

## 5. TestFlight on your iPhone

1. Actions › iOS release › Run workflow (or a tag, after I ask). The job summary says
   "TestFlight: uploaded 1.0.0 (1000001)".
2. App Store Connect › Selis › TestFlight: the build is "Processing" for ~10–30 min, then answer
   export compliance if asked.
3. Internal Testing › + group "Owner", add yourself (your Apple ID must be a user of the team).
4. On the iPhone: install **TestFlight** from the App Store, accept the invite, install Selis.

Internal testers need no Beta App Review; external testers do.
