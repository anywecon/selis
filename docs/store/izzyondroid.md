# IzzyOnDroid — dropped (record only)

> **Dropped 2026-10-15 (ADR 0025, Amendment 1).** IzzyOnDroid's inclusion policy rejects apps
> created fully or in part with generative AI tools, and Selis's code is written with Claude Code.
> Nothing below is submitted; it is kept as a record. v1.0 ships on Google Play and GitHub
> Releases (README › Install).

Status 2026-10-15 (before the amendment): **prepared, not submitted.** Owner decision (ADR 0025): the F-Droid-client
launch channel is IzzyOnDroid with our developer-signed, reproducible APK; the main F-Droid
repository (PDFium and Tesseract WebAssembly built from source) is a later spike
(`fdroid/README.md`). Submitting needs a first tagged release with signed APKs and a Codeberg
account.

Sources, checked 2026-10-15: App Inclusion Policy
<https://izzyondroid.org/docs/general/AppInclusionPolicy/>, New app inclusions
<https://izzyondroid.org/contributing/NewAppInclusions/>, RB recipes
<https://izzyondroid.org/docs/reproducibleBuilds/PreparingRecipes/>, request tracker
<https://codeberg.org/IzzyOnDroid/repodata/issues>.

## Blocker to resolve first: IzzyOnDroid's AI policy

The inclusion policy (section "AI policy") says: "We are strongly opposed to apps which are fully
or in part created by generative AI tools … So if your app falls into this category, your request
for inclusion will most likely be rejected", "Vibe-coded apps will be rejected", documentation
may contain LLM text "but the code itself should be free of it", and "Any lack of transparency
discovered by us, can lead to the project being degraded to rejected state."

Selis's code is written with an AI coding assistant (the commits carry `Co-Authored-By: Claude`).
Under this policy a request will **most likely be rejected**, and submitting without saying so
would breach their transparency rule. The draft below therefore discloses it. Options for the
owner:

1. Submit with the disclosure anyway and accept a likely rejection.
2. Use **GitHub Releases + Obtainium** as the F-Droid-free channel at launch (already in place:
   signed per-ABI APKs and SHA-256 on the release and the website) and bring the main F-Droid
   repository forward. F-Droid has no adopted AI rule as of 2026-10-15; an interim policy based on
   Debian's (human review, disclosure encouraged) is proposed
   (<https://gitlab.com/fdroid/admin/-/work_items/699>).
3. Ask IzzyOnDroid first (an issue or their contact page) whether an AI-assisted, human-reviewed
   app is acceptable, before preparing a release for them.

## What they require, and where Selis stands

| Requirement (policy) | Selis |
| --- | --- |
| FOSS licence, OSI/FSF approved | Apache-2.0 |
| Public source on Codeberg / GitLab / GitHub | <https://github.com/anywecon/selis> |
| APK attached to a tagged GitHub release | `release.yml` attaches `selis-<v>-<abi>.apk` to `v<X.Y.Z>` releases |
| "up to 30 megabytes per app … the upper size limit for single .apk files" | arm64-v8a APK 28.1 MB (1.0.0-rc.1, `docs/release/1.0-rc.md`) — inside, with 1.9 MB to spare; armeabi-v7a smaller; universal APK too large (not offered to them) |
| Signed by the developer with a release key, not debuggable / testOnly | App signing key (ADR 0025); `check-release-apk.sh` in CI |
| No trackers, no ads, no proprietary components | None (`check-dependencies.ts`, `fdroid scanner` in CI) |
| Avoid `usesCleartextTraffic` | Manifest placeholder; release builds set it to false (`build.gradle.kts`) |
| Fastlane metadata in the repo (short + full description, icon, screenshots) | `fastlane/metadata/android/en-US` and `el-GR` |
| Releases tagged; tag names match versionName | `v1.0.0` ↔ versionName `1.0.0` |
| Reproducible build | Byte-identical unsigned arm64 APK from a second build in CI (`release-android.yml`, ADR 0021) |

Watch the size: 1.9 MB of headroom on arm64. A release that crosses 30 MB needs their
exception or a smaller APK (the OCR cores are the biggest WebAssembly files).

## Request (issue at codeberg.org/IzzyOnDroid/repodata/issues)

Title: `Selis — offline PDF reader, editor and scanner (com.anywecon.selis)`

```markdown
**App:** Selis — read, annotate, sign, scan and OCR PDFs on the phone, and move them between
your own devices end-to-end encrypted. No account, no ads, no analytics.

- Package name: `com.anywecon.selis`
- Source: https://github.com/anywecon/selis (Apache-2.0)
- Releases: https://github.com/anywecon/selis/releases — please use the `selis-<version>-arm64-v8a.apk`
  asset (28 MB; the universal APK is larger than your limit)
- Fastlane metadata: `fastlane/metadata/android/` (en-US, el-GR)
- Website and privacy policy: https://anywecon.github.io/selis/ · https://anywecon.github.io/selis/privacy/
- Signing certificate SHA-256: `<APP_SIGNING_CERT_SHA256>`

**Network:** none at start-up. The network is used only while the user has the Transfer screen
open. Transfers use iroh (QUIC, end-to-end encrypted): directly on the same Wi-Fi (mDNS) or over
the internet; when two devices cannot connect directly, by default the encrypted traffic goes
through a public relay run by n0 (the iroh developers), who see the IP addresses involved but not
the contents. Settings › Transfer has "Local network only" (no relay, no lookup service) and a
field for a self-hosted relay (iroh-relay, open source). This is stated in the description and
the privacy policy.

**Permissions:** INTERNET / ACCESS_NETWORK_STATE / CHANGE_WIFI_MULTICAST_STATE (transfer),
CAMERA (QR code of a transfer, document scan; optional), POST_NOTIFICATIONS and
RUN_USER_INITIATED_JOBS (progress of a running transfer, Android 14+), FOREGROUND_SERVICE (the
same on Android 8–13 only).

**Proprietary parts:** none. No Google Play Services, Firebase or ML Kit; QR codes with jsQR,
scan edge detection in our own Rust → WebAssembly, OCR with Tesseract (tesseract.js), PDF engine
PDFium (EmbedPDF) as WebAssembly. Checked in CI with `fdroid scanner`.

**Reproducible build:** every release is built twice in CI (different path and CARGO_HOME) and
the unsigned arm64 APK must be byte-identical. Recipe below; the build needs Node 22, Rust (from
`rust-toolchain.toml`), the Android NDK 27.3 and libclang. Embedded paths are remapped
(`--remap-path-prefix`, `-ffile-prefix-map`), so build directories do not matter.

**AI disclosure:** the code is written with an AI coding assistant (Claude) and reviewed and
tested by the maintainer (unit tests, end-to-end tests on devices, CI checks); commits carry
`Co-Authored-By: Claude`. We know your policy is opposed to this and say so up front.
```

## Reproducible-build recipe draft (their YAML format)

Their maintainers write the recipe; this draft follows their template and our CI's
`reproducible` job (`release-android.yml`). Paths in the image are theirs.

```yaml
repository: https://github.com/anywecon/selis.git
updates: releases
versions:
  - tag: v1.0.0
    apks:
      - apk_pattern: selis-1\.0\.0-arm64-v8a\.apk
        apk_url: https://github.com/anywecon/selis/releases/download/v1.0.0/selis-1.0.0-arm64-v8a.apk
        build:
          - curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain none
          - . "$HOME/.cargo/env" && rustup show active-toolchain || rustup toolchain install
          - . "$HOME/.cargo/env" && rustup target add aarch64-linux-android wasm32-unknown-unknown
          - curl -fsSL https://nodejs.org/dist/v22.23.1/node-v22.23.1-linux-x64.tar.xz | tar -xJ -C "$HOME"
          - export PATH="$HOME/node-v22.23.1-linux-x64/bin:$PATH" && npm ci
          - export NDK_HOME="$ANDROID_HOME/ndk/27.3.13750724"
          - . "$HOME/.cargo/env" && . scripts/reproducible-env.sh && export PATH="$HOME/node-v22.23.1-linux-x64/bin:$PATH" && npm run tauri -- android build --apk --split-per-abi --target aarch64
          - mv apps/app/src-tauri/gen/android/app/build/outputs/apk/arm64/release/app-arm64-release-unsigned.apk /outputs/unsigned.apk
        provisioning:
          image: debian:bookworm-slim
          jdk: openjdk-17-jdk-headless
          extra_packages:
            - curl
            - xz-utils
            - build-essential
            - libclang-dev
            - git
          verify_gradle_wrapper: true
```

The NDK and SDK platform come from their Android SDK image; if it has no NDK 27.3, add
`sdkmanager "ndk;27.3.13750724"` before the build.
