//! Two (or three) transfer services in one process, local network only (no
//! relay, no lookups): the handshake, the code, the gate, expiry, single use
//! and resume, end to end over real QUIC connections.

use std::{path::Path, time::Duration};

use iroh::SecretKey;
use iroh_blobs::{HashAndFormat, store::mem::MemStore};
use selis_transfer::{
    Network, OfferItem, OfferVersion, ReceiveState, SendState, ServiceConfig, TransferError,
    TransferService, TransferTicket,
};

type Result<T = ()> = anyhow::Result<T>;

/// A fresh identity per service: tests run in parallel and find each other over
/// mDNS, so a shared key would let a receiver reach another test's sender.
fn key() -> SecretKey {
    SecretKey::generate()
}

async fn service(
    dir: &Path,
    name: &str,
    key: SecretKey,
    lifetime: Duration,
) -> Result<TransferService> {
    let mut cfg = ServiceConfig::new(key, dir.join(name), Network::LocalOnly);
    cfg.ticket_lifetime = lifetime;
    Ok(TransferService::start(cfg).await?)
}

fn write(dir: &Path, name: &str, len: usize, seed: u8) -> Result<std::path::PathBuf> {
    let path = dir.join(name);
    let data: Vec<u8> = (0..len)
        .map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed))
        .collect();
    std::fs::write(&path, data)?;
    Ok(path)
}

async fn until<T>(mut f: impl FnMut() -> Option<T>) -> Result<T> {
    // Debug builds move a few MB/s: the resume test needs up to a minute.
    for _ in 0..12_000 {
        if let Some(v) = f() {
            return Ok(v);
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    anyhow::bail!("timed out")
}

async fn send_code(s: &TransferService, id: &str) -> Result<String> {
    until(|| match s.send_state(id) {
        Some(SendState::Confirm { code }) => Some(code),
        _ => None,
    })
    .await
}

async fn receive_code(s: &TransferService, id: &str) -> Result<String> {
    until(|| match s.receive_state(id) {
        Some(ReceiveState::Confirm { code }) => Some(code),
        _ => None,
    })
    .await
}

async fn receive_end(s: &TransferService, id: &str) -> Result<ReceiveState> {
    until(|| match s.receive_state(id) {
        Some(st @ (ReceiveState::Done { .. } | ReceiveState::Failed { .. })) => Some(st),
        _ => None,
    })
    .await
}

const LIFETIME: Duration = Duration::from_secs(600);

#[tokio::test(flavor = "multi_thread")]
async fn sends_two_documents_with_history_after_the_code_is_confirmed() -> Result {
    let dir = tempfile::tempdir()?;
    let sender = service(dir.path(), "a", key(), LIFETIME).await?;
    let receiver = service(dir.path(), "b", key(), LIFETIME).await?;
    let a = write(dir.path(), "a.pdf", 300_000, 1)?;
    let a_v1 = write(dir.path(), "a-v1.pdf", 250_000, 2)?;
    let b = write(dir.path(), "b.pdf", 1_000, 3)?;
    let (sid, ticket) = sender
        .offer(vec![
            OfferItem {
                title: "Συμβόλαιο".into(),
                name: "Συμβόλαιο.pdf".into(),
                path: a.clone(),
                history: vec![OfferVersion {
                    path: a_v1.clone(),
                    created_at: 7,
                }],
                ..Default::default()
            },
            OfferItem {
                title: "".into(),
                name: "b.pdf".into(),
                path: b.clone(),
                history: vec![],
                ..Default::default()
            },
        ])
        .await?;
    // Through the link, as scanned or pasted.
    let ticket = TransferTicket::parse(&ticket.to_link())?;
    let rid = receiver.receive(ticket, dir.path().join("in"))?;

    // Both screens show the same code; nothing moves before the sender confirms.
    let (sc, rc) = (
        send_code(&sender, &sid).await?,
        receive_code(&receiver, &rid).await?,
    );
    assert_eq!(sc, rc);
    assert_eq!(sc.len(), 6);
    assert!(matches!(
        receiver.receive_state(&rid),
        Some(ReceiveState::Confirm { .. })
    ));
    sender.decide(&sid, true)?;

    let ReceiveState::Done { items, .. } = receive_end(&receiver, &rid).await? else {
        anyhow::bail!("receive failed: {:?}", receiver.receive_state(&rid));
    };
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].title, "Συμβόλαιο");
    assert_eq!(items[0].name, "Συμβόλαιο.pdf");
    assert_eq!(std::fs::read(&items[0].path)?, std::fs::read(&a)?);
    assert_eq!(
        std::fs::read(&items[0].history[0].path)?,
        std::fs::read(&a_v1)?
    );
    assert_eq!(items[0].history[0].created_at, 7);
    assert_eq!(std::fs::read(&items[1].path)?, std::fs::read(&b)?);
    assert_eq!(
        items[0].blake3,
        blake3::hash(&std::fs::read(&a)?).to_hex().to_string()
    );
    until(|| matches!(sender.send_state(&sid), Some(SendState::Done)).then_some(())).await?;

    sender.close(true).await;
    receiver.close(true).await;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_declined_code_sends_nothing_and_the_ticket_is_single_use() -> Result {
    let dir = tempfile::tempdir()?;
    let sender = service(dir.path(), "a", key(), LIFETIME).await?;
    let receiver = service(dir.path(), "b", key(), LIFETIME).await?;
    let f = write(dir.path(), "f.pdf", 10_000, 9)?;
    let (sid, ticket) = sender
        .offer(vec![OfferItem {
            title: "f".into(),
            name: "f.pdf".into(),
            path: f,
            history: vec![],
            ..Default::default()
        }])
        .await?;
    let rid = receiver.receive(ticket.clone(), dir.path().join("in"))?;
    send_code(&sender, &sid).await?;
    sender.decide(&sid, false)?;
    assert_eq!(
        receive_end(&receiver, &rid).await?,
        ReceiveState::Failed {
            error: TransferError::Declined
        }
    );
    assert!(
        !dir.path().join("in").exists()
            || std::fs::read_dir(dir.path().join("in"))?.next().is_none()
    );

    // The same ticket again (any device): refused.
    let again = receiver.receive(ticket, dir.path().join("in"))?;
    assert_eq!(
        receive_end(&receiver, &again).await?,
        ReceiveState::Failed {
            error: TransferError::AlreadyUsed
        }
    );
    sender.close(true).await;
    receiver.close(true).await;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn an_expired_ticket_is_refused_on_both_sides() -> Result {
    let dir = tempfile::tempdir()?;
    let sender = service(dir.path(), "a", key(), Duration::from_secs(1)).await?;
    let receiver = service(dir.path(), "b", key(), LIFETIME).await?;
    let f = write(dir.path(), "f.pdf", 10_000, 9)?;
    let (sid, ticket) = sender
        .offer(vec![OfferItem {
            title: "f".into(),
            name: "f.pdf".into(),
            path: f,
            history: vec![],
            ..Default::default()
        }])
        .await?;
    tokio::time::sleep(Duration::from_millis(2100)).await;
    // The sender's clock decides: an expired ticket is refused there, whatever
    // the receiver's clock says (it allows some skew).
    assert_eq!(
        sender.send_state(&sid),
        Some(SendState::Failed {
            error: TransferError::Expired
        })
    );
    let rid = receiver.receive(ticket.clone(), dir.path().join("in"))?;
    assert_eq!(
        receive_end(&receiver, &rid).await?,
        ReceiveState::Failed {
            error: TransferError::Expired
        }
    );
    // Clearly expired by the receiver's clock too: refused locally, nothing sent.
    let mut stale = ticket;
    stale.expires_at = 1;
    assert!(receiver.receive(stale, dir.path().join("in")).is_err());
    sender.close(true).await;
    receiver.close(true).await;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unconfirmed_peer_cannot_fetch_the_blobs() -> Result {
    let dir = tempfile::tempdir()?;
    let sender = service(dir.path(), "a", key(), LIFETIME).await?;
    let f = write(dir.path(), "f.pdf", 100_000, 4)?;
    let (_sid, ticket) = sender
        .offer(vec![OfferItem {
            title: "f".into(),
            name: "f.pdf".into(),
            path: f.clone(),
            history: vec![],
            ..Default::default()
        }])
        .await?;

    // A stranger that learned the address and the hash (e.g. saw the QR code) goes
    // straight to the blobs protocol, skipping the code.
    let ep = iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
        .relay_mode(iroh::RelayMode::Disabled)
        .secret_key(key())
        .bind()
        .await?;
    let store = MemStore::new();
    let conn = ep.connect(ticket.addr.clone(), iroh_blobs::ALPN).await;
    let fetched = match conn {
        Ok(conn) => store
            .remote()
            .fetch(conn, HashAndFormat::hash_seq(ticket.collection))
            .await
            .is_ok(),
        Err(_) => false,
    };
    assert!(!fetched, "an unconfirmed peer must be refused");
    let blob = iroh_blobs::Hash::new(std::fs::read(&f)?);
    assert!(!matches!(
        store.blobs().status(blob).await?,
        iroh_blobs::api::proto::BlobStatus::Complete { .. }
    ));
    ep.close().await;
    sender.close(true).await;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn an_interrupted_receive_resumes_without_fetching_again() -> Result {
    let dir = tempfile::tempdir()?;
    let sender = service(dir.path(), "a", key(), LIFETIME).await?;
    let big = write(dir.path(), "big.pdf", 192 * 1024 * 1024, 5)?;
    let (sid, ticket) = sender
        .offer(vec![OfferItem {
            title: "big".into(),
            name: "big.pdf".into(),
            path: big.clone(),
            history: vec![],
            ..Default::default()
        }])
        .await?;

    // The same device (same key) before and after the interruption.
    let receiver_key = key();
    let first = service(dir.path(), "b", receiver_key.clone(), LIFETIME).await?;
    let rid = first.receive(ticket, dir.path().join("in"))?;
    send_code(&sender, &sid).await?;
    sender.decide(&sid, true)?;
    // Stop it (like the app being killed) once some data arrived.
    until(|| match first.receive_state(&rid) {
        Some(ReceiveState::Receiving { bytes, .. }) if bytes > 8 * 1024 * 1024 => Some(()),
        _ => None,
    })
    .await?;
    let info = first
        .resume_info(&rid)
        .ok_or_else(|| anyhow::anyhow!("no resume info"))?;
    first.close(false).await;

    // Same device (same key), same store: continues where it stopped.
    let second = service(dir.path(), "b", receiver_key, LIFETIME).await?;
    let rid2 = second.resume(info, dir.path().join("in"));
    let start = until(|| match second.receive_state(&rid2) {
        Some(ReceiveState::Receiving { bytes, total, .. }) => Some((bytes, total)),
        Some(ReceiveState::Done { .. }) => Some((u64::MAX, 0)),
        _ => None,
    })
    .await?;
    if start.0 != u64::MAX {
        assert!(
            start.0 >= 8 * 1024 * 1024 && start.0 < start.1,
            "resumed at {} of {}",
            start.0,
            start.1
        );
    }
    let ReceiveState::Done { items, .. } = receive_end(&second, &rid2).await? else {
        anyhow::bail!("resume failed: {:?}", second.receive_state(&rid2));
    };
    assert_eq!(
        blake3::hash(&std::fs::read(&items[0].path)?),
        blake3::hash(&std::fs::read(&big)?)
    );
    sender.close(true).await;
    second.close(true).await;
    Ok(())
}

/// Two devices that trust each other (after a first transfer and "Save device").
async fn trusted_pair(dir: &Path) -> Result<(TransferService, TransferService)> {
    let a = service(dir, "a", key(), LIFETIME).await?;
    let b = service(dir, "b", key(), LIFETIME).await?;
    a.set_trusted([b.endpoint_id()]);
    b.set_trusted([a.endpoint_id()]);
    Ok((a, b))
}

async fn send_end(s: &TransferService, id: &str) -> Result<SendState> {
    until(|| match s.send_state(id) {
        Some(st @ (SendState::Done | SendState::Failed { .. })) => Some(st),
        _ => None,
    })
    .await
}

#[tokio::test(flavor = "multi_thread")]
async fn a_trusted_device_with_receive_open_gets_a_push_without_code() -> Result {
    let dir = tempfile::tempdir()?;
    let (a, b) = trusted_pair(dir.path()).await?;
    let f = write(dir.path(), "f.pdf", 120_000, 6)?;
    // Not on the Receive screen: refused.
    assert!(!a.ping(b.endpoint_id()).await.map_err(anyhow::Error::msg)?);
    let refused = a
        .push(
            b.endpoint_id(),
            vec![OfferItem {
                title: "f".into(),
                name: "f.pdf".into(),
                path: f.clone(),
                ..Default::default()
            }],
            None,
        )
        .await?;
    assert_eq!(
        send_end(&a, &refused).await?,
        SendState::Failed {
            error: TransferError::NotReady
        }
    );

    b.set_receiving(Some(dir.path().join("in")));
    assert!(a.ping(b.endpoint_id()).await.map_err(anyhow::Error::msg)?);
    let sid = a
        .push(
            b.endpoint_id(),
            vec![OfferItem {
                title: "f".into(),
                name: "f.pdf".into(),
                path: f.clone(),
                ..Default::default()
            }],
            None,
        )
        .await?;
    let incoming = until(|| {
        let v = b.take_incoming();
        (!v.is_empty()).then_some(v)
    })
    .await?;
    assert_eq!(incoming[0].1, a.endpoint_id());
    let ReceiveState::Done { items, .. } = receive_end(&b, &incoming[0].0).await? else {
        anyhow::bail!("push receive failed: {:?}", b.receive_state(&incoming[0].0));
    };
    assert_eq!(std::fs::read(&items[0].path)?, std::fs::read(&f)?);
    assert_eq!(send_end(&a, &sid).await?, SendState::Done);
    assert_eq!(b.pushed_by(&incoming[0].0), Some(a.endpoint_id()));
    a.close(true).await;
    b.close(true).await;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn an_untrusted_device_cannot_push_or_ping() -> Result {
    let dir = tempfile::tempdir()?;
    let a = service(dir.path(), "a", key(), LIFETIME).await?;
    let b = service(dir.path(), "b", key(), LIFETIME).await?;
    // A trusts B, but B does not trust A.
    a.set_trusted([b.endpoint_id()]);
    b.set_receiving(Some(dir.path().join("in")));
    assert_eq!(a.ping(b.endpoint_id()).await, Err(TransferError::NotReady));
    let f = write(dir.path(), "f.pdf", 1_000, 1)?;
    let sid = a
        .push(
            b.endpoint_id(),
            vec![OfferItem {
                title: "f".into(),
                name: "f.pdf".into(),
                path: f,
                ..Default::default()
            }],
            None,
        )
        .await?;
    assert_eq!(
        send_end(&a, &sid).await?,
        SendState::Failed {
            error: TransferError::NotReady
        }
    );
    assert!(b.take_incoming().is_empty());
    a.close(true).await;
    b.close(true).await;
    Ok(())
}

/// Security audit run-1, lead 5: a sender from a ticket must not learn which blobs the
/// receiver holds, so a ticket receive fetches every blob (the app dedupes on import).
#[tokio::test(flavor = "multi_thread")]
async fn a_ticket_receive_fetches_every_blob_even_one_the_receiver_has() -> Result {
    use selis_transfer::Have;
    let dir = tempfile::tempdir()?;
    let a = service(dir.path(), "a", key(), LIFETIME).await?;
    let known = write(dir.path(), "known.pdf", 50_000, 7)?;
    let known_hash = iroh_blobs::Hash::new(std::fs::read(&known)?);
    let known_path = known.clone();
    let mut cfg = ServiceConfig::new(key(), dir.path().join("b"), Network::LocalOnly);
    cfg.have = Some(Have(std::sync::Arc::new(move |h| {
        (*h == known_hash).then(|| known_path.clone())
    })));
    let b = TransferService::start(cfg).await?;
    let (sid, ticket) = a
        .offer_with(
            vec![OfferItem {
                title: "Known".into(),
                name: "k.pdf".into(),
                path: known.clone(),
                ..Default::default()
            }],
            None,
            None,
        )
        .await?;
    let rid = b.receive(ticket, dir.path().join("in"))?;
    send_code(&a, &sid).await?;
    a.decide(&sid, true)?;
    let ReceiveState::Done { items, .. } = receive_end(&b, &rid).await? else {
        anyhow::bail!("receive failed: {:?}", b.receive_state(&rid));
    };
    assert_ne!(items[0].path, known);
    assert_eq!(std::fs::read(&items[0].path)?, std::fs::read(&known)?);
    assert_eq!(b.blob_status_for_test(known_hash).await, Some(true));
    a.close(true).await;
    b.close(true).await;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_library_move_carries_tags_signatures_and_settings() -> Result {
    use selis_transfer::{Have, OfferLibrary, OfferSignature};
    let dir = tempfile::tempdir()?;
    let a = service(dir.path(), "a", key(), LIFETIME).await?;
    let known = write(dir.path(), "known.pdf", 50_000, 7)?;
    let known_hash = iroh_blobs::Hash::new(std::fs::read(&known)?);
    let known_path = known.clone();
    // The receiver already has `known` (same BLAKE3): fetched anyway (a ticket, not a trusted push).
    let mut cfg = ServiceConfig::new(key(), dir.path().join("b"), Network::LocalOnly);
    cfg.have = Some(Have(std::sync::Arc::new(move |h| {
        (*h == known_hash).then(|| known_path.clone())
    })));
    let b = TransferService::start(cfg).await?;
    let fresh = write(dir.path(), "fresh.pdf", 80_000, 8)?;
    let sig = write(dir.path(), "sig.png", 900, 9)?;
    let mut settings = serde_json::Map::new();
    settings.insert("theme".into(), serde_json::json!("sepia"));
    let (sid, ticket) = a
        .offer_with(
            vec![
                OfferItem {
                    title: "Known".into(),
                    name: "k.pdf".into(),
                    path: known.clone(),
                    tags: vec!["Home".into()],
                    favorite: true,
                    ..Default::default()
                },
                OfferItem {
                    title: "Fresh".into(),
                    name: "f.pdf".into(),
                    path: fresh.clone(),
                    ..Default::default()
                },
            ],
            Some(OfferLibrary {
                signatures: vec![OfferSignature {
                    id: "sig-1".into(),
                    kind: "drawn".into(),
                    path: sig.clone(),
                    created_at: 3,
                }],
                settings,
            }),
            None,
        )
        .await?;
    let rid = b.receive(ticket, dir.path().join("in"))?;
    send_code(&a, &sid).await?;
    a.decide(&sid, true)?;
    let ReceiveState::Done { items, library } = receive_end(&b, &rid).await? else {
        anyhow::bail!("move failed: {:?}", b.receive_state(&rid));
    };
    assert_eq!(std::fs::read(&items[0].path)?, std::fs::read(&known)?);
    assert_eq!(
        (items[0].tags.clone(), items[0].favorite),
        (vec!["Home".to_string()], true)
    );
    assert_eq!(std::fs::read(&items[1].path)?, std::fs::read(&fresh)?);
    let library = library.ok_or_else(|| anyhow::anyhow!("no library extras"))?;
    assert_eq!(
        std::fs::read(&library.signatures[0].path)?,
        std::fs::read(&sig)?
    );
    assert_eq!(library.signatures[0].id, "sig-1");
    assert_eq!(
        library.settings.get("theme"),
        Some(&serde_json::json!("sepia"))
    );
    a.close(true).await;
    b.close(true).await;
    Ok(())
}

/// A receiver whose store directory is gone (deleted under the open endpoint,
/// or a full disk) cannot write any blob: that is a storage failure, which the
/// app shows as one, not an interruption it offers to resume forever.
#[tokio::test(flavor = "multi_thread")]
async fn a_receiver_without_its_store_fails_with_storage() -> Result {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_test_writer()
        .try_init();
    let dir = tempfile::tempdir()?;
    let sender = service(dir.path(), "a", key(), LIFETIME).await?;
    let receiver = service(dir.path(), "b", key(), LIFETIME).await?;
    let a = write(dir.path(), "a.pdf", 300_000, 9)?;
    let (sid, ticket) = sender
        .offer(vec![OfferItem {
            title: "a".into(),
            name: "a.pdf".into(),
            path: a,
            history: vec![],
            ..Default::default()
        }])
        .await?;
    std::fs::remove_dir_all(receiver.store_dir())?;
    let rid = receiver.receive(ticket, dir.path().join("in"))?;
    send_code(&sender, &sid).await?;
    sender.decide(&sid, true)?;
    let end = receive_end(&receiver, &rid).await?;
    assert_eq!(
        end,
        ReceiveState::Failed {
            error: TransferError::Storage
        }
    );
    sender.close(true).await;
    receiver.close(true).await;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_receive_rate_paces_the_download() -> Result {
    // Testing aid for Android background tests (debug.selis.receive_kbps): 1 MB at
    // 256 KiB/s takes about 4 s instead of a few milliseconds.
    let dir = tempfile::tempdir()?;
    let sender = service(dir.path(), "a", key(), LIFETIME).await?;
    let mut cfg = ServiceConfig::new(key(), dir.path().join("b"), Network::LocalOnly);
    cfg.receive_rate = Some(256 * 1024);
    let receiver = TransferService::start(cfg).await?;
    let f = write(dir.path(), "slow.pdf", 1_000_000, 4)?;
    let (sid, ticket) = sender
        .offer(vec![OfferItem {
            title: "slow".into(),
            name: "slow.pdf".into(),
            path: f,
            history: vec![],
            ..Default::default()
        }])
        .await?;
    let rid = receiver.receive(ticket, dir.path().join("in"))?;
    send_code(&sender, &sid).await?;
    receive_code(&receiver, &rid).await?;
    let started = std::time::Instant::now();
    sender.decide(&sid, true)?;
    assert!(matches!(
        receive_end(&receiver, &rid).await?,
        ReceiveState::Done { .. }
    ));
    let took = started.elapsed();
    assert!(took >= Duration::from_millis(3_000), "took {took:?}");
    sender.close(true).await;
    receiver.close(true).await;
    Ok(())
}

/// A trusted device's push (ADR 0014) still skips the blobs the receiver has.
#[tokio::test(flavor = "multi_thread")]
async fn a_trusted_push_skips_what_the_receiver_has() -> Result {
    use selis_transfer::Have;
    let dir = tempfile::tempdir()?;
    let a = service(dir.path(), "a", key(), LIFETIME).await?;
    let known = write(dir.path(), "known.pdf", 50_000, 7)?;
    let known_hash = iroh_blobs::Hash::new(std::fs::read(&known)?);
    let known_path = known.clone();
    let mut cfg = ServiceConfig::new(key(), dir.path().join("b"), Network::LocalOnly);
    cfg.ticket_lifetime = LIFETIME;
    cfg.have = Some(Have(std::sync::Arc::new(move |h| {
        (*h == known_hash).then(|| known_path.clone())
    })));
    let b = TransferService::start(cfg).await?;
    a.set_trusted([b.endpoint_id()]);
    b.set_trusted([a.endpoint_id()]);
    b.set_receiving(Some(dir.path().join("in")));
    let sid = a
        .push(
            b.endpoint_id(),
            vec![OfferItem {
                title: "Known".into(),
                name: "k.pdf".into(),
                path: known.clone(),
                ..Default::default()
            }],
            None,
        )
        .await?;
    let incoming = until(|| {
        let v = b.take_incoming();
        (!v.is_empty()).then_some(v)
    })
    .await?;
    let ReceiveState::Done { items, .. } = receive_end(&b, &incoming[0].0).await? else {
        anyhow::bail!("push receive failed: {:?}", b.receive_state(&incoming[0].0));
    };
    assert_eq!(items[0].path, known);
    assert_ne!(b.blob_status_for_test(known_hash).await, Some(true));
    assert_eq!(send_end(&a, &sid).await?, SendState::Done);
    a.close(true).await;
    b.close(true).await;
    Ok(())
}
