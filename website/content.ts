/** Website copy, English (default, at /) and Greek (at /el/). Store texts: fastlane/metadata. */

export type Lang = "en" | "el";

export type Feature = { title: string; body: string; shot?: string };

export type Copy = {
  htmlLang: string;
  locale: string;
  nav: { home: string; features: string; privacy: string; download: string; menu: string; language: string; otherLanguage: string };
  meta: { description: string };
  home: {
    title: string;
    tagline: string;
    lead: string;
    cta: string;
    secondary: string;
    pillars: [string, string, string, string];
    highlightsTitle: string;
    highlights: Feature[];
    privacyTitle: string;
    privacyBody: string;
    privacyLink: string;
    openTitle: string;
    openBody: string;
    aiNote: string;
    openLink: string;
  };
  features: { title: string; lead: string; groups: Array<{ title: string; items: string[] }> };
  privacy: { title: string };
  download: {
    title: string;
    lead: string;
    stores: string;
    comingSoon: string;
    github: string;
    githubBody: string;
    noRelease: string;
    releasesLink: string;
    file: string;
    abi: string;
    size: string;
    sha256: string;
    which: string;
    verifyTitle: string;
    verifyBody: string;
    certificate: string;
    certificatePending: string;
    obtainium: string;
    obtainiumBody: string;
  };
  footer: { license: string; source: string; trademarks: string };
  notFound: { title: string; body: string; home: string };
};

export const COPY: Record<Lang, Copy> = {
  en: {
    htmlLang: "en",
    locale: "en_US",
    nav: { home: "Selis", features: "Features", privacy: "Privacy", download: "Download", menu: "Main", language: "Language", otherLanguage: "Ελληνικά" },
    meta: { description: "Selis is a free, open-source PDF editor for your phone: read, annotate, sign, scan and send PDFs. No account, no cloud storage, no tracking." },
    home: {
      title: "Selis — PDF editor for your phone",
      tagline: "Your PDFs, on your phone.",
      lead: "Read, annotate, sign, fill in forms, organise pages, scan and send documents to your other devices. Free and open source; your library stays on your phone, and nothing is sent unless you send it.",
      cta: "Download",
      secondary: "See all features",
      pillars: ["No ads", "No tracking", "No account", "No cloud storage"],
      highlightsTitle: "Everything you do with PDFs",
      highlights: [
        { title: "Read anything", body: "Smooth even at 1000+ pages. Search, select and copy text, night mode for pages.", shot: "2-viewer" },
        { title: "Annotate", body: "Highlight, underline, pen, shapes, text and notes, with undo for everything.", shot: "3-annotate" },
        { title: "Sign and fill in", body: "Fill in PDF forms and place your signature — drawn, typed or from a picture.", shot: "4-sign" },
        { title: "Scan and tools", body: "Scan paper with the camera, make it searchable with on-device OCR, protect, compress or repair PDFs.", shot: "6-tools" },
        { title: "Send to your devices", body: "End-to-end encrypted transfer between your phones and tablets, with a QR code.", shot: "5-transfer" },
        { title: "Never lose the original", body: "Imports are copies and every save is a version you can go back to.", shot: "1-library" },
      ],
      privacyTitle: "Private by design",
      privacyBody:
        "No analytics, no crash reporting, no account and no server of ours. The network is used only while you transfer documents, and you can keep that to your own Wi‑Fi.",
      privacyLink: "Read the privacy policy",
      openTitle: "Open source",
      openBody: "Selis is licensed under the Apache License 2.0. Read the code, report issues, or build it yourself.",
      aiNote: "Developed with AI assistance (Claude Code); every change is reviewed and tested by the maintainer.",
      openLink: "Source code on GitHub",
    },
    features: {
      title: "Features",
      lead: "Selis 1.0 for Android and iOS. Desktop versions follow.",
      groups: [
        { title: "Read", items: ["Smooth scrolling in documents of 1000+ pages", "Pinch and double-tap zoom, thumbnails, outline", "Full-text search, text selection and copy", "Night mode for pages; light, dark and sepia themes"] },
        { title: "Annotate and sign", items: ["Highlight, underline, strike-through, pen, shapes, text and sticky notes", "Fill in PDF forms and flatten them", "Visual signatures — drawn, typed or from a picture — saved for next time", "Undo and redo for every tool"] },
        { title: "Organise pages", items: ["Reorder by drag, rotate, duplicate, delete", "Insert a blank page or pages from another PDF; form fields stay fillable", "Extract and split"] },
        { title: "Redact for real", items: ["Content under a redaction box is removed from the file, not just covered", "Whiteout with new text", "Earlier versions that still hold the text can be deleted"] },
        { title: "Scan and recognise text", items: ["Camera scan with edge detection, perspective correction and filters", "On-device text recognition (English and Greek) makes scans searchable", "Photos to PDF; save a page as PNG or JPEG"] },
        { title: "Tools", items: ["Protect a PDF with a password or remove one", "Compress, optimise for the web, repair damaged files"] },
        { title: "Transfer", items: ["Direct, end-to-end encrypted transfer with a QR code or link and a 6-digit confirmation code", "Resumes after a dropped connection", "Trusted devices and moving your whole library to a new phone", "Selis pack files (.selispack), optionally protected with a passphrase"] },
      ],
    },
    privacy: { title: "Privacy" },
    download: {
      title: "Download Selis",
      lead: "Free, with no ads and no in-app purchases.",
      stores: "App stores",
      comingSoon: "Coming soon",
      github: "Android APK from GitHub",
      githubBody: "Signed APKs of every release, with SHA-256 checksums. Most phones need arm64-v8a; the universal APK runs everywhere.",
      noRelease: "The first release is being prepared. It will appear here and on GitHub Releases.",
      releasesLink: "All releases on GitHub",
      file: "File",
      abi: "For",
      size: "Size",
      sha256: "SHA-256",
      which: "Not sure? Pick arm64-v8a.",
      verifyTitle: "Check your download",
      verifyBody: "Compare the file's SHA-256 with the table above: on Windows run Get-FileHash <file> in PowerShell, on Linux or macOS sha256sum <file> (macOS: shasum -a 256 <file>).",
      certificate: "APK signing certificate (SHA-256)",
      certificatePending: "published with the first signed release",
      obtainium: "Obtainium",
      obtainiumBody: "Get updates straight from GitHub Releases: in Obtainium, add https://github.com/Fiouri/selis and set the APK filter to arm64-v8a\\.apk$ (or universal\\.apk$). Turn on pre-releases to get release candidates too.",
    },
    footer: { license: "Apache License 2.0", source: "Source code", trademarks: "Google Play and the Google Play logo are trademarks of Google LLC. App Store is a service mark of Apple Inc." },
    notFound: { title: "Page not found", body: "This page does not exist.", home: "Go to the home page" },
  },
  el: {
    htmlLang: "el",
    locale: "el_GR",
    nav: { home: "Selis", features: "Δυνατότητες", privacy: "Απόρρητο", download: "Λήψη", menu: "Κύριο μενού", language: "Γλώσσα", otherLanguage: "English" },
    meta: { description: "Το Selis είναι ένας δωρεάν επεξεργαστής PDF ανοιχτού κώδικα για το κινητό: διάβασε, σχολίασε, υπόγραψε, σάρωσε και στείλε PDF. Χωρίς λογαριασμό, αποθήκευση στο cloud ή παρακολούθηση." },
    home: {
      title: "Selis — επεξεργαστής PDF για το κινητό",
      tagline: "Τα PDF σου, στο κινητό σου.",
      lead: "Διάβασε, σχολίασε, υπόγραψε, συμπλήρωσε φόρμες, οργάνωσε σελίδες, σάρωσε και στείλε έγγραφα στις άλλες συσκευές σου. Δωρεάν και ανοιχτού κώδικα· η βιβλιοθήκη σου μένει στο κινητό σου και τίποτα δεν στέλνεται, εκτός αν το στείλεις εσύ.",
      cta: "Λήψη",
      secondary: "Όλες οι δυνατότητες",
      pillars: ["Χωρίς διαφημίσεις", "Χωρίς παρακολούθηση", "Χωρίς λογαριασμό", "Χωρίς αποθήκευση στο cloud"],
      highlightsTitle: "Ό,τι κάνεις με τα PDF",
      highlights: [
        { title: "Διάβασε τα πάντα", body: "Ομαλά ακόμη και σε 1000+ σελίδες. Αναζήτηση, επιλογή και αντιγραφή κειμένου, νυχτερινή λειτουργία.", shot: "2-viewer" },
        { title: "Σχολίασε", body: "Επισήμανση, υπογράμμιση, στυλό, σχήματα, κείμενο και σημειώσεις, με αναίρεση σε όλα.", shot: "3-annotate" },
        { title: "Υπόγραψε και συμπλήρωσε", body: "Συμπλήρωσε φόρμες PDF και βάλε την υπογραφή σου — σχέδιο, κείμενο ή εικόνα.", shot: "4-sign" },
        { title: "Σάρωση και εργαλεία", body: "Σάρωσε χαρτιά με την κάμερα, κάν' τα αναζητήσιμα με OCR πάνω στη συσκευή, προστάτεψε, συμπίεσε ή επισκεύασε PDF.", shot: "6-tools" },
        { title: "Στείλε στις συσκευές σου", body: "Μεταφορά με κρυπτογράφηση από άκρο σε άκρο ανάμεσα σε κινητά και tablet, με κωδικό QR.", shot: "5-transfer" },
        { title: "Το αρχικό μένει ανέπαφο", body: "Η εισαγωγή κάνει αντίγραφο και κάθε αποθήκευση είναι έκδοση στην οποία μπορείς να επιστρέψεις.", shot: "1-library" },
      ],
      privacyTitle: "Ιδιωτικότητα εκ σχεδιασμού",
      privacyBody:
        "Χωρίς αναλύσεις χρήσης, αναφορές σφαλμάτων, λογαριασμό ή δικό μας διακομιστή. Το δίκτυο χρησιμοποιείται μόνο όσο μεταφέρεις έγγραφα, και μπορείς να το περιορίσεις στο δικό σου Wi‑Fi.",
      privacyLink: "Διάβασε την πολιτική απορρήτου",
      openTitle: "Ανοιχτός κώδικας",
      openBody: "Το Selis διατίθεται με την άδεια Apache 2.0. Διάβασε τον κώδικα, ανέφερε προβλήματα ή χτίσ' το μόνος σου.",
      aiNote: "Αναπτύσσεται με τη βοήθεια AI (Claude Code)· κάθε αλλαγή ελέγχεται και δοκιμάζεται από τον συντηρητή.",
      openLink: "Ο κώδικας στο GitHub",
    },
    features: {
      title: "Δυνατότητες",
      lead: "Selis 1.0 για Android και iOS. Οι εκδόσεις για υπολογιστή ακολουθούν.",
      groups: [
        { title: "Ανάγνωση", items: ["Ομαλή κύλιση σε έγγραφα 1000+ σελίδων", "Μεγέθυνση με τσίμπημα και διπλό πάτημα, μικρογραφίες, περιεχόμενα", "Αναζήτηση σε όλο το κείμενο, επιλογή και αντιγραφή", "Νυχτερινή λειτουργία σελίδων· φωτεινό, σκούρο και σέπια θέμα"] },
        { title: "Σχόλια και υπογραφές", items: ["Επισήμανση, υπογράμμιση, διακριτή διαγραφή, στυλό, σχήματα, κείμενο και σημειώσεις", "Συμπλήρωση φορμών PDF και κλείδωμά τους", "Οπτικές υπογραφές — σχέδιο, κείμενο ή εικόνα — αποθηκευμένες για την επόμενη φορά", "Αναίρεση και επανάληψη σε κάθε εργαλείο"] },
        { title: "Οργάνωση σελίδων", items: ["Αναδιάταξη με σύρσιμο, περιστροφή, διπλασιασμός, διαγραφή", "Προσθήκη κενής σελίδας ή σελίδων από άλλο PDF· τα πεδία φορμών μένουν συμπληρώσιμα", "Εξαγωγή και διαχωρισμός"] },
        { title: "Πραγματική απόκρυψη", items: ["Ό,τι βρίσκεται κάτω από το πλαίσιο απόκρυψης αφαιρείται από το αρχείο", "Λευκή επικάλυψη με νέο κείμενο", "Οι παλαιότερες εκδόσεις που έχουν ακόμη το κείμενο μπορούν να διαγραφούν"] },
        { title: "Σάρωση και αναγνώριση κειμένου", items: ["Σάρωση με την κάμερα: εντοπισμός άκρων, διόρθωση προοπτικής, φίλτρα", "Αναγνώριση κειμένου πάνω στη συσκευή (ελληνικά και αγγλικά) για αναζητήσιμες σαρώσεις", "Φωτογραφίες σε PDF· αποθήκευση σελίδας ως PNG ή JPEG"] },
        { title: "Εργαλεία", items: ["Προστασία PDF με κωδικό ή αφαίρεσή του", "Συμπίεση, βελτιστοποίηση για το web, επισκευή κατεστραμμένων αρχείων"] },
        { title: "Μεταφορά", items: ["Απευθείας μεταφορά με κρυπτογράφηση από άκρο σε άκρο, με QR ή σύνδεσμο και εξαψήφιο κωδικό επιβεβαίωσης", "Συνέχιση μετά από διακοπή σύνδεσης", "Αξιόπιστες συσκευές και μετακόμιση όλης της βιβλιοθήκης σε νέο κινητό", "Αρχεία πακέτου Selis (.selispack), προαιρετικά με συνθηματικό"] },
      ],
    },
    privacy: { title: "Απόρρητο" },
    download: {
      title: "Λήψη του Selis",
      lead: "Δωρεάν, χωρίς διαφημίσεις και αγορές μέσα από την εφαρμογή.",
      stores: "Καταστήματα εφαρμογών",
      comingSoon: "Σύντομα",
      github: "APK για Android από το GitHub",
      githubBody: "Υπογεγραμμένα APK κάθε έκδοσης, με αθροίσματα ελέγχου SHA-256. Τα περισσότερα κινητά θέλουν arm64-v8a· το universal APK τρέχει παντού.",
      noRelease: "Η πρώτη έκδοση ετοιμάζεται. Θα εμφανιστεί εδώ και στα GitHub Releases.",
      releasesLink: "Όλες οι εκδόσεις στο GitHub",
      file: "Αρχείο",
      abi: "Για",
      size: "Μέγεθος",
      sha256: "SHA-256",
      which: "Δεν είσαι σίγουρος; Διάλεξε arm64-v8a.",
      verifyTitle: "Έλεγξε τη λήψη σου",
      verifyBody: "Σύγκρινε το SHA-256 του αρχείου με τον πίνακα: στα Windows τρέξε Get-FileHash <αρχείο> στο PowerShell, σε Linux ή macOS sha256sum <αρχείο> (macOS: shasum -a 256 <αρχείο>).",
      certificate: "Πιστοποιητικό υπογραφής APK (SHA-256)",
      certificatePending: "δημοσιεύεται με την πρώτη υπογεγραμμένη έκδοση",
      obtainium: "Obtainium",
      obtainiumBody: "Ενημερώσεις κατευθείαν από τα GitHub Releases: στο Obtainium πρόσθεσε το https://github.com/Fiouri/selis και βάλε φίλτρο APK arm64-v8a\\.apk$ (ή universal\\.apk$). Άνοιξε τις προ-εκδόσεις για να παίρνεις και τις υποψήφιες εκδόσεις.",
    },
    footer: { license: "Άδεια Apache 2.0", source: "Πηγαίος κώδικας", trademarks: "Τα Google Play και το λογότυπο Google Play είναι εμπορικά σήματα της Google LLC. Το App Store είναι σήμα υπηρεσιών της Apple Inc." },
    notFound: { title: "Η σελίδα δεν βρέθηκε", body: "Αυτή η σελίδα δεν υπάρχει.", home: "Στην αρχική σελίδα" },
  },
};

/** Store badges: shown as official artwork only once the app is live there (each store's rules). */
export type Store = { id: "play" | "appstore" | "fdroid"; name: string; url: string; live: boolean; badge: Record<Lang, string | null> };

export const STORES: Store[] = [
  { id: "play", name: "Google Play", url: "https://play.google.com/store/apps/details?id=com.anywecon.selis", live: false, badge: { en: "badges/google-play-en.png", el: "badges/google-play-el.png" } },
  // Apple's badge artwork is added with the App Store listing (Apple marketing guidelines).
  { id: "appstore", name: "App Store", url: "https://apps.apple.com/app/selis", live: false, badge: { en: null, el: null } },
  { id: "fdroid", name: "F-Droid", url: "https://f-droid.org/packages/com.anywecon.selis/", live: false, badge: { en: "badges/f-droid-en.png", el: "badges/f-droid-el.png" } },
];
