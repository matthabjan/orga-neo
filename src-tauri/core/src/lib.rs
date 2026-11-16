//! Storage and encryption layer of Orga-Neo.
//!
//! Layout of the data folder:
//!
//! ```text
//! open.json            appointments, addresses, notes, settings (not encrypted)
//! vault.json           key slots + encrypted passwords and document list
//! docs/<id>.enc        one encrypted file per document
//! backups/             daily copies of open.json and vault.json
//! ```
//!
//! A random 256-bit vault key encrypts the vault data and every document
//! (XChaCha20-Poly1305). The vault key itself is stored three times, each copy
//! wrapped with a key derived by Argon2id from a different secret: the master
//! password, the recovery code and the family emergency code.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

const DOC_MAGIC: &[u8; 5] = b"ONEO1";
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I, L, O, 0, 1

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("not_initialized")]
    NotInitialized,
    #[error("already_initialized")]
    AlreadyInitialized,
    #[error("locked")]
    Locked,
    #[error("wrong_secret")]
    WrongSecret,
    #[error("weak_password")]
    WeakPassword,
    #[error("invalid_id")]
    InvalidId,
    #[error("corrupt")]
    Corrupt,
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Argon2id cost settings, stored in vault.json so they can be raised later.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Kdf {
    /// Memory in KiB.
    pub m: u32,
    /// Iterations.
    pub t: u32,
    /// Parallelism.
    pub p: u32,
}

impl Default for Kdf {
    fn default() -> Self {
        Kdf { m: 64 * 1024, t: 3, p: 1 }
    }
}

#[derive(Serialize, Deserialize, Clone)]
struct Slot {
    salt: String,
    nonce: String,
    ct: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct Sealed {
    nonce: String,
    ct: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct Slots {
    password: Slot,
    recovery: Slot,
    emergency: Slot,
}

#[derive(Serialize, Deserialize, Clone)]
struct VaultFile {
    version: u32,
    kdf: Kdf,
    slots: Slots,
    data: Sealed,
}

/// The two printed codes that can open the vault without the master password.
#[derive(Debug, Clone, Serialize)]
pub struct Codes {
    /// For the owner's own recovery sheet.
    pub recovery: String,
    /// For a family member to keep.
    pub emergency: String,
}

type Key = Zeroizing<[u8; 32]>;

pub struct Store {
    dir: PathBuf,
    kdf: Kdf,
    key: Option<Key>,
}

impl Store {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Store { dir: dir.into(), kdf: Kdf::default(), key: None }
    }

    /// Use cheaper key derivation. Only for tests.
    pub fn with_kdf(dir: impl Into<PathBuf>, kdf: Kdf) -> Self {
        Store { dir: dir.into(), kdf, key: None }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn is_initialized(&self) -> bool {
        self.vault_path().exists()
    }

    pub fn is_unlocked(&self) -> bool {
        self.key.is_some()
    }

    // ---------- open (unencrypted) data ----------

    pub fn read_open(&self) -> Result<String> {
        match fs::read_to_string(self.dir.join("open.json")) {
            Ok(s) => Ok(s),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(e) => Err(e.into()),
        }
    }

    pub fn write_open(&self, json: &str) -> Result<()> {
        self.write_with_backup("open.json", json.as_bytes())
    }

    // ---------- vault lifecycle ----------

    pub fn create_vault(&mut self, password: &str) -> Result<Codes> {
        if self.is_initialized() {
            return Err(Error::AlreadyInitialized);
        }
        check_password(password)?;
        let mut key: Key = Zeroizing::new([0u8; 32]);
        OsRng.fill_bytes(&mut key[..]);
        let codes = Codes { recovery: new_code(), emergency: new_code() };
        let file = VaultFile {
            version: 1,
            kdf: self.kdf,
            slots: Slots {
                password: self.wrap(&key, password.as_bytes())?,
                recovery: self.wrap(&key, normalize_code(&codes.recovery).as_bytes())?,
                emergency: self.wrap(&key, normalize_code(&codes.emergency).as_bytes())?,
            },
            data: seal(&key, b"{\"passwords\":[],\"docs\":[]}", b"vault-data")?,
        };
        self.save_vault_file(&file)?;
        self.key = Some(key);
        Ok(codes)
    }

    pub fn unlock(&mut self, password: &str) -> Result<()> {
        let file = self.load_vault_file()?;
        let key = unwrap_slot(&file.slots.password, password.as_bytes(), file.kdf)?;
        self.key = Some(key);
        Ok(())
    }

    /// Open the vault with the recovery code or the emergency code.
    pub fn unlock_with_code(&mut self, code: &str) -> Result<()> {
        let file = self.load_vault_file()?;
        let code = normalize_code(code);
        for slot in [&file.slots.recovery, &file.slots.emergency] {
            if let Ok(key) = unwrap_slot(slot, code.as_bytes(), file.kdf) {
                self.key = Some(key);
                return Ok(());
            }
        }
        Err(Error::WrongSecret)
    }

    pub fn lock(&mut self) {
        self.key = None;
    }

    /// Set a new master password. The vault must be unlocked.
    pub fn change_password(&mut self, new_password: &str) -> Result<()> {
        check_password(new_password)?;
        let key = self.key.clone().ok_or(Error::Locked)?;
        let mut file = self.load_vault_file()?;
        file.slots.password = self.wrap(&key, new_password.as_bytes())?;
        self.save_vault_file(&file)
    }

    /// Replace both printed codes. The old ones stop working.
    pub fn new_codes(&mut self) -> Result<Codes> {
        let key = self.key.clone().ok_or(Error::Locked)?;
        let mut file = self.load_vault_file()?;
        let codes = Codes { recovery: new_code(), emergency: new_code() };
        file.slots.recovery = self.wrap(&key, normalize_code(&codes.recovery).as_bytes())?;
        file.slots.emergency = self.wrap(&key, normalize_code(&codes.emergency).as_bytes())?;
        self.save_vault_file(&file)?;
        Ok(codes)
    }

    // ---------- vault data ----------

    pub fn read_vault(&self) -> Result<String> {
        let key = self.key.as_ref().ok_or(Error::Locked)?;
        let file = self.load_vault_file()?;
        let plain = open(key, &file.data, b"vault-data")?;
        String::from_utf8(plain).map_err(|_| Error::Corrupt)
    }

    pub fn write_vault(&self, json: &str) -> Result<()> {
        let key = self.key.as_ref().ok_or(Error::Locked)?;
        let mut file = self.load_vault_file()?;
        file.data = seal(key, json.as_bytes(), b"vault-data")?;
        self.save_vault_file(&file)
    }

    // ---------- documents ----------

    pub fn add_doc(&self, id: &str, bytes: &[u8]) -> Result<()> {
        let key = self.key.as_ref().ok_or(Error::Locked)?;
        let path = self.doc_path(id)?;
        let mut nonce = [0u8; 24];
        OsRng.fill_bytes(&mut nonce);
        let ct = cipher(key)
            .encrypt(XNonce::from_slice(&nonce), Payload { msg: bytes, aad: id.as_bytes() })
            .map_err(|_| Error::Corrupt)?;
        let mut out = Vec::with_capacity(DOC_MAGIC.len() + 24 + ct.len());
        out.extend_from_slice(DOC_MAGIC);
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ct);
        fs::create_dir_all(self.dir.join("docs"))?;
        atomic_write(&path, &out)
    }

    pub fn read_doc(&self, id: &str) -> Result<Vec<u8>> {
        let key = self.key.as_ref().ok_or(Error::Locked)?;
        let raw = fs::read(self.doc_path(id)?)?;
        if raw.len() < DOC_MAGIC.len() + 24 || &raw[..DOC_MAGIC.len()] != DOC_MAGIC {
            return Err(Error::Corrupt);
        }
        let (nonce, ct) = raw[DOC_MAGIC.len()..].split_at(24);
        cipher(key)
            .decrypt(XNonce::from_slice(nonce), Payload { msg: ct, aad: id.as_bytes() })
            .map_err(|_| Error::Corrupt)
    }

    pub fn delete_doc(&self, id: &str) -> Result<()> {
        if self.key.is_none() {
            return Err(Error::Locked);
        }
        match fs::remove_file(self.doc_path(id)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    // ---------- internals ----------

    fn vault_path(&self) -> PathBuf {
        self.dir.join("vault.json")
    }

    fn doc_path(&self, id: &str) -> Result<PathBuf> {
        let ok = !id.is_empty()
            && id.len() <= 64
            && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
        if !ok {
            return Err(Error::InvalidId);
        }
        Ok(self.dir.join("docs").join(format!("{id}.enc")))
    }

    fn load_vault_file(&self) -> Result<VaultFile> {
        let raw = match fs::read(self.vault_path()) {
            Ok(r) => r,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(Error::NotInitialized),
            Err(e) => return Err(e.into()),
        };
        serde_json::from_slice(&raw).map_err(|_| Error::Corrupt)
    }

    fn save_vault_file(&self, file: &VaultFile) -> Result<()> {
        let json = serde_json::to_vec(file).map_err(|_| Error::Corrupt)?;
        self.write_with_backup("vault.json", &json)
    }

    fn wrap(&self, key: &Key, secret: &[u8]) -> Result<Slot> {
        let mut salt = [0u8; 16];
        OsRng.fill_bytes(&mut salt);
        let kek = derive(secret, &salt, self.kdf)?;
        let sealed = seal(&kek, &key[..], b"vault-key")?;
        Ok(Slot { salt: B64.encode(salt), nonce: sealed.nonce, ct: sealed.ct })
    }

    /// Write `name` atomically. Before the first change of each day, keep the
    /// previous version in backups/ (the newest 14 per file are kept).
    fn write_with_backup(&self, name: &str, bytes: &[u8]) -> Result<()> {
        fs::create_dir_all(&self.dir)?;
        let target = self.dir.join(name);
        if target.exists() {
            let backups = self.dir.join("backups");
            fs::create_dir_all(&backups)?;
            let day = days_since_epoch();
            let (stem, ext) = name.rsplit_once('.').unwrap_or((name, "bak"));
            let copy = backups.join(format!("{stem}-{day}.{ext}"));
            if !copy.exists() {
                fs::copy(&target, &copy)?;
                prune_backups(&backups, stem, 14);
            }
        }
        atomic_write(&target, bytes)
    }
}

fn check_password(password: &str) -> Result<()> {
    if password.chars().count() < 10 {
        return Err(Error::WeakPassword);
    }
    Ok(())
}

fn cipher(key: &Key) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new_from_slice(&key[..]).expect("32-byte key")
}

fn derive(secret: &[u8], salt: &[u8], kdf: Kdf) -> Result<Key> {
    let params = Params::new(kdf.m, kdf.t, kdf.p, Some(32)).map_err(|_| Error::Corrupt)?;
    let mut out: Key = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(secret, salt, &mut out[..])
        .map_err(|_| Error::Corrupt)?;
    Ok(out)
}

fn seal(key: &Key, plain: &[u8], aad: &[u8]) -> Result<Sealed> {
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let ct = cipher(key)
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: plain, aad })
        .map_err(|_| Error::Corrupt)?;
    Ok(Sealed { nonce: B64.encode(nonce), ct: B64.encode(ct) })
}

fn open(key: &Key, sealed: &Sealed, aad: &[u8]) -> Result<Vec<u8>> {
    let nonce = B64.decode(&sealed.nonce).map_err(|_| Error::Corrupt)?;
    let ct = B64.decode(&sealed.ct).map_err(|_| Error::Corrupt)?;
    if nonce.len() != 24 {
        return Err(Error::Corrupt);
    }
    cipher(key)
        .decrypt(XNonce::from_slice(&nonce), Payload { msg: &ct, aad })
        .map_err(|_| Error::WrongSecret)
}

fn unwrap_slot(slot: &Slot, secret: &[u8], kdf: Kdf) -> Result<Key> {
    let salt = B64.decode(&slot.salt).map_err(|_| Error::Corrupt)?;
    let kek = derive(secret, &salt, kdf)?;
    let plain = Zeroizing::new(open(
        &kek,
        &Sealed { nonce: slot.nonce.clone(), ct: slot.ct.clone() },
        b"vault-key",
    )?);
    if plain.len() != 32 {
        return Err(Error::Corrupt);
    }
    let mut key: Key = Zeroizing::new([0u8; 32]);
    key.copy_from_slice(&plain);
    Ok(key)
}

/// 20 random characters in four groups, e.g. `K7QWM-2HXPA-9RTBE-VN4CD`.
fn new_code() -> String {
    let mut out = String::with_capacity(23);
    let mut produced = 0;
    while produced < 20 {
        let mut b = [0u8; 1];
        OsRng.fill_bytes(&mut b);
        // rejection sampling keeps the distribution uniform
        let limit = 256 - (256 % CODE_ALPHABET.len());
        if (b[0] as usize) >= limit {
            continue;
        }
        if produced > 0 && produced % 5 == 0 {
            out.push('-');
        }
        out.push(CODE_ALPHABET[b[0] as usize % CODE_ALPHABET.len()] as char);
        produced += 1;
    }
    out
}

/// Codes are typed in by hand: ignore case, spaces and dashes.
fn normalize_code(code: &str) -> String {
    code.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_uppercase()).collect()
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

fn days_since_epoch() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0)
}

fn prune_backups(dir: &Path, stem: &str, keep: usize) {
    let prefix = format!("{stem}-");
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut names: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(&prefix)))
        .collect();
    names.sort();
    if names.len() > keep {
        for old in &names[..names.len() - keep] {
            let _ = fs::remove_file(old);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAST: Kdf = Kdf { m: 64, t: 1, p: 1 };
    const PW: &str = "Tanne-Kompass-Regen-47";

    fn store(dir: &Path) -> Store {
        Store::with_kdf(dir, FAST)
    }

    #[test]
    fn vault_round_trip_survives_restart() {
        let tmp = tempfile::tempdir().unwrap();
        let mut s = store(tmp.path());
        assert!(!s.is_initialized());
        s.create_vault(PW).unwrap();
        s.write_vault(r#"{"passwords":[{"name":"Bank","pw":"geheim"}],"docs":[]}"#).unwrap();

        let mut again = store(tmp.path());
        assert!(again.is_initialized());
        assert!(matches!(again.read_vault(), Err(Error::Locked)));
        again.unlock(PW).unwrap();
        assert!(again.read_vault().unwrap().contains("geheim"));
    }

    #[test]
    fn wrong_password_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let mut s = store(tmp.path());
        s.create_vault(PW).unwrap();
        s.lock();
        assert!(matches!(s.unlock("falsches-passwort"), Err(Error::WrongSecret)));
        assert!(!s.is_unlocked());
    }

    #[test]
    fn short_password_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let mut s = store(tmp.path());
        assert!(matches!(s.create_vault("kurz"), Err(Error::WeakPassword)));
        assert!(!s.is_initialized());
    }

    #[test]
    fn both_codes_open_the_vault_however_they_are_typed() {
        let tmp = tempfile::tempdir().unwrap();
        let mut s = store(tmp.path());
        let codes = s.create_vault(PW).unwrap();
        assert_eq!(codes.recovery.len(), 23);
        assert_ne!(codes.recovery, codes.emergency);

        s.lock();
        s.unlock_with_code(&codes.recovery).unwrap();
        s.lock();
        s.unlock_with_code(&codes.emergency.to_lowercase().replace('-', " ")).unwrap();
        s.lock();
        assert!(matches!(s.unlock_with_code("AAAAA-AAAAA-AAAAA-AAAAA"), Err(Error::WrongSecret)));
    }

    #[test]
    fn changing_password_keeps_data_and_codes() {
        let tmp = tempfile::tempdir().unwrap();
        let mut s = store(tmp.path());
        let codes = s.create_vault(PW).unwrap();
        s.write_vault(r#"{"x":1}"#).unwrap();
        s.change_password("Neues-Passwort-2026").unwrap();
        s.lock();
        assert!(matches!(s.unlock(PW), Err(Error::WrongSecret)));
        s.unlock("Neues-Passwort-2026").unwrap();
        assert_eq!(s.read_vault().unwrap(), r#"{"x":1}"#);
        s.lock();
        s.unlock_with_code(&codes.recovery).unwrap();
    }

    #[test]
    fn new_codes_invalidate_old_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let mut s = store(tmp.path());
        let old = s.create_vault(PW).unwrap();
        let new = s.new_codes().unwrap();
        s.lock();
        assert!(matches!(s.unlock_with_code(&old.recovery), Err(Error::WrongSecret)));
        s.unlock_with_code(&new.emergency).unwrap();
    }

    #[test]
    fn documents_round_trip_and_are_not_stored_in_clear() {
        let tmp = tempfile::tempdir().unwrap();
        let mut s = store(tmp.path());
        s.create_vault(PW).unwrap();
        let content = b"Personalausweis Scan 0123456789".repeat(1000);
        s.add_doc("abc123", &content).unwrap();

        let on_disk = fs::read(tmp.path().join("docs/abc123.enc")).unwrap();
        assert!(!on_disk.windows(15).any(|w| w == b"Personalausweis"));
        assert_eq!(s.read_doc("abc123").unwrap(), content);

        s.lock();
        assert!(matches!(s.read_doc("abc123"), Err(Error::Locked)));
        s.unlock(PW).unwrap();
        s.delete_doc("abc123").unwrap();
        assert!(s.read_doc("abc123").is_err());
    }

    #[test]
    fn tampered_or_swapped_documents_are_detected() {
        let tmp = tempfile::tempdir().unwrap();
        let mut s = store(tmp.path());
        s.create_vault(PW).unwrap();
        s.add_doc("one", b"erstes Dokument").unwrap();
        s.add_doc("two", b"zweites Dokument").unwrap();

        // swapping two files must fail, because the id is authenticated
        fs::copy(tmp.path().join("docs/one.enc"), tmp.path().join("docs/two.enc")).unwrap();
        assert!(matches!(s.read_doc("two"), Err(Error::Corrupt)));

        let p = tmp.path().join("docs/one.enc");
        let mut raw = fs::read(&p).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 1;
        fs::write(&p, raw).unwrap();
        assert!(matches!(s.read_doc("one"), Err(Error::Corrupt)));
    }

    #[test]
    fn document_ids_cannot_escape_the_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let mut s = store(tmp.path());
        s.create_vault(PW).unwrap();
        for bad in ["../evil", "a/b", "", "A1", "x.enc"] {
            assert!(matches!(s.add_doc(bad, b"x"), Err(Error::InvalidId)), "{bad}");
        }
    }

    #[test]
    fn vault_file_contains_no_plaintext() {
        let tmp = tempfile::tempdir().unwrap();
        let mut s = store(tmp.path());
        s.create_vault(PW).unwrap();
        s.write_vault(r#"{"passwords":[{"pw":"SuperGeheim99"}]}"#).unwrap();
        let raw = fs::read_to_string(tmp.path().join("vault.json")).unwrap();
        assert!(!raw.contains("SuperGeheim99"));
        assert!(!raw.contains(PW));
    }

    #[test]
    fn open_data_round_trip_and_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let s = store(tmp.path());
        assert_eq!(s.read_open().unwrap(), "");
        s.write_open(r#"{"v":1}"#).unwrap();
        s.write_open(r#"{"v":2}"#).unwrap();
        assert_eq!(s.read_open().unwrap(), r#"{"v":2}"#);
        let backups: Vec<_> = fs::read_dir(tmp.path().join("backups")).unwrap().collect();
        assert_eq!(backups.len(), 1, "one backup per file per day");
    }

    #[test]
    fn creating_twice_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let mut s = store(tmp.path());
        s.create_vault(PW).unwrap();
        assert!(matches!(s.create_vault(PW), Err(Error::AlreadyInitialized)));
    }
}
