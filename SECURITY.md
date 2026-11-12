# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through GitHub's
[private vulnerability reporting](https://github.com/anywecon/selis/security/advisories/new).

Include the affected version/commit, platform, steps to reproduce and impact. If a malicious
PDF is involved, attach it to the private report (never to a public issue).

We aim to acknowledge reports within 7 days and to agree on a disclosure timeline with you.

## Supported versions

Selis has not been released yet. Once it is, security fixes target the latest release.

## Scope and design notes

- PDFs are parsed by PDFium compiled to WebAssembly, inside a Web Worker. PDF JavaScript is
  not executed.
- The WebView runs under a strict Content Security Policy with no remote sources.
- Tauri capabilities are least-privilege per platform; app commands are deny-by-default.
- The app makes no network requests unless the user starts a device-to-device transfer (P3).
