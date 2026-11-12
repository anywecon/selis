# Déclaration de fourniture d'un moyen de cryptologie — brouillon (Selis)

Status 2026-10-15: **draft, not filed.** Selis launches on the App Store without France
(`ios-export-compliance.md`, ADR 0025). This is the filled draft for when France is wanted. Not
legal advice. Fields marked **[à compléter]** need the owner's details.

Procedure checked 2026-10-15: since 31 March 2026 the declaration is made online on
<https://demarche.numerique.gouv.fr/commencer/declaration-relative-a-un-moyen-de-cryptologie>
(ANSSI, "Contrôle relatif à un moyen de cryptologie",
<https://cyber.gouv.fr/reglementation/reglementation-identite-confiance-numerique/controles-reglementaires-cryptographie/controle-moyen-de-cryptologie/>;
form guide "Notice relative au formulaire de déclaration d'un moyen de cryptologie",
<https://cyber.gouv.fr/documents/823/260331_Notice_V3.pdf>). Legal basis: loi n° 2004-575
(LCEN) art. 30, décret n° 2007-663. ANSSI e-mails an acknowledgement and then the
"attestation de déclaration"; that attestation is what App Store Connect › App Encryption
Documentation takes.

The sections below follow the online form (notice §B).

---

## Page 1 — Qualité du déclarant

« Pour vous » (le bénéficiaire fait la déclaration lui-même).

## 1. Bénéficiaire

| Champ | Valeur |
| --- | --- |
| Type | **[à compléter : personne morale (société) ou particulier]** |
| Dénomination / nom | Any WeCon **[à compléter : forme juridique]** |
| Adresse | **[à compléter]**, Grèce |
| Numéro d'immatriculation | **[à compléter : n° GEMI / n° de TVA]** — pour une personne morale déclarant pour la première fois, l'ANSSI demande un Kbis ou équivalent étranger et un document général présentant la société |
| Responsable administratif | **[à compléter : nom, fonction, e-mail, téléphone]** |
| Responsable technique | Identique au responsable administratif |

## 2. Le moyen de cryptologie

### 2.1 Informations générales

| Champ | Valeur |
| --- | --- |
| Marque de distribution | Selis |
| Dénomination | **Selis** (nom de l'application sur l'App Store) |
| Version | 1.0.0 (et versions ultérieures dont les fonctions cryptographiques sont identiques) |
| Référence commerciale | com.anywecon.selis (identifiant de l'application iOS / Android) |
| Date de mise sur le marché | **[à compléter : date de première publication en France]** |
| Fabricant | Le bénéficiaire (Any WeCon) |

### 2.2 Description fonctionnelle

- **Type :** logiciel.
- **Description générale :** Selis est une application mobile gratuite et open source (licence
  Apache-2.0, code source public : <https://github.com/anywecon/selis>) pour lire, annoter, signer,
  organiser, numériser et convertir des documents PDF sur un téléphone ou une tablette. Les
  documents restent sur l'appareil ; l'application n'a ni compte utilisateur, ni serveur, ni
  publicité, ni statistiques d'usage. Elle permet aussi à l'utilisateur de transférer ses
  documents entre ses propres appareils (ou vers l'appareil d'une personne de son choix) de façon
  chiffrée de bout en bout, d'exporter un ensemble de documents dans un fichier protégé par mot de
  passe, et de protéger un PDF par mot de passe.
- **Usage :** bureautique grand public (lecture et gestion de documents PDF).
- **Fonction principale :** « Entrer une autre option » → **Bureautique / gestion de documents
  PDF**. La cryptographie n'est pas la fonction principale ; elle protège les documents de
  l'utilisateur pendant les transferts et dans les fichiers qu'il choisit de protéger.

### 2.3 Description technique des services de cryptologie

**Cryptographie intégrée et usage :**

1. **Transfert entre appareils** (écran « Transfert », lancé par l'utilisateur) : connexion
   QUIC directe entre les deux appareils, ou via un relais réseau qui ne voit que des données
   chiffrées ; chiffrement de bout en bout TLS 1.3 ; les appareils s'authentifient par des clés
   Ed25519 et l'utilisateur confirme un code à 6 chiffres affiché sur les deux appareils.
2. **Fichier « .selispack » protégé** (export de documents choisi par l'utilisateur) : clé
   dérivée de la phrase de passe de l'utilisateur, chiffrement authentifié des documents.
3. **Protection d'un PDF par mot de passe** (outil « Protéger ») : chiffrement standard des PDF
   (ISO 32000-2) ; l'application ouvre aussi les PDF protégés par les anciennes méthodes.
4. **Intégrité** : empreintes des fichiers (détection de doublons, vérification après transfert).

**Catégories :** authentification, intégrité, confidentialité, signature.

**Protocoles sécurisés :** TLS 1.3 (RFC 8446) sur QUIC (RFC 9000 / RFC 9001) ; chiffrement des
PDF selon ISO 32000-2 (gestionnaire de sécurité standard, révision 6).

Aucun algorithme propriétaire ; toutes les implémentations sont des bibliothèques open source
publiques (rustls, RustCrypto, quinn / iroh, qpdf). Aucune clé n'est séquestrée ; l'éditeur n'a
accès à aucune clé ni à aucun document des utilisateurs. Le chiffrement n'est pas configurable
par l'utilisateur au-delà du choix des mots de passe.

### 2.4 Algorithmes cryptographiques

| Algorithme | Mode | Taille de clé | Utilisation |
| --- | --- | --- | --- |
| AES | GCM | 128 et 256 bits | Chiffrement des données du transfert (suite TLS 1.3) |
| ChaCha20-Poly1305 | AEAD (RFC 8439) | 256 bits | Chiffrement des données du transfert (suite TLS 1.3) |
| X25519 | ECDH (RFC 7748) | 256 bits | Échange de clés du transfert (TLS 1.3) |
| Ed25519 | EdDSA (RFC 8032) | 256 bits | Authentification des appareils, signature de la poignée de main TLS |
| HKDF-SHA-256 | — (RFC 5869) | 256 bits | Dérivation des clés de session TLS 1.3 |
| XChaCha20-Poly1305 | AEAD | 256 bits | Chiffrement des fichiers .selispack protégés |
| Argon2id | KDF (RFC 9106) | clé dérivée 256 bits | Dérivation de la clé d'un .selispack à partir de la phrase de passe |
| AES | CBC | 256 bits | Chiffrement des PDF protégés par l'utilisateur (ISO 32000-2) |
| AES / RC4 | CBC / flux | 128 / 40–128 bits | Déchiffrement seul des anciens PDF protégés (ISO 32000-1), pour les ouvrir |
| SHA-256, SHA-384, SHA-512 | — | — | Intégrité, TLS 1.3, mot de passe des PDF (ISO 32000-2) |
| BLAKE3 | — | — | Empreintes des fichiers, vérification après transfert |

## 3. Pièces à joindre

| Pièce | Obligatoire | Source dans le dépôt |
| --- | --- | --- |
| Brochure commerciale | Oui | La fiche App Store (`fastlane/metadata/ios/fr-FR` à créer, ou l'anglais `en-US/description.txt`) en PDF, avec le site <https://anywecon.github.io/selis/> |
| Brochure technique | Oui | Ce document (sections 2.2–2.4) plus `docs/store/ios-export-compliance.md` et les ADR 0010, 0011, 0012, 0015, en PDF |
| Attestation sur l'honneur | Oui | Modèle téléchargé dans la section « Pièces à joindre » du formulaire, rempli et signé par le bénéficiaire |
| Kbis (ou extrait GEMI) + présentation de la société | Oui pour une première déclaration d'une personne morale | **[à compléter]** |

Taille maximale par pièce : 200 Mo.

## Classement « grand public »

À demander dans la déclaration : Selis est distribué gratuitement au grand public par les
magasins d'applications, sans modification possible de la cryptographie par l'utilisateur et
sans assistance particulière à l'installation (décret 2007-663, annexe II, point 3). **[à vérifier
au moment du dépôt : la case ou le champ correspondant dans le formulaire en ligne.]**

## Après le dépôt

1. Accusé de réception puis attestation de déclaration (e-mail, et sur
   demarche.numerique.gouv.fr).
2. App Store Connect › App Information › App Encryption Documentation › + : téléverser
   l'attestation ; Apple renvoie un code.
3. `ITSEncryptionExportComplianceCode` = ce code dans `gen/apple/project.yml` et `Info.plist` ;
   ajouter la France dans Pricing and Availability.
4. Une nouvelle déclaration est nécessaire si les fonctions cryptographiques changent (nouvel
   algorithme, nouveau protocole).
