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
//!
//! Creating new codes (or changing the password together with new codes)
//! replaces the vault key itself and re-encrypts everything, so an old copy
//! of vault.json opened with an old secret cannot read today's data. While
//! that re-encryption is unfinished, vault.json holds the previous key
//! (sealed with the new one) and documents are read with either key; the
//! next unlock finishes the job after a crash.

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
/// Everything Orga-Neo keeps in its data folder.
const DATA_ENTRIES: [&str; 4] = ["open.json", "vault.json", "docs", "backups"];

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
    #[error("same_folder")]
    SameFolder,
    #[error("inside_current")]
    InsideCurrent,
    #[error("target_has_data")]
    TargetHasData,
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

/// Highest Argon2 settings accepted from a file: 1 GiB, 10 passes, 8 lanes.
const MAX_KDF: Kdf = Kdf { m: 1024 * 1024, t: 10, p: 8 };

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
    /// Cost settings this slot was wrapped with. Missing in files written
    /// before 0.2; those slots use the file-wide `VaultFile::kdf`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    kdf: Option<Kdf>,
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
    /// Cost settings for slots that do not carry their own.
    kdf: Kdf,
    slots: Slots,
    data: Sealed,
    /// The previous vault key, sealed with the current one, while a key
    /// change is not finished yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    prev: Option<Sealed>,
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
    /// The previous key while a key change is unfinished.
    prev: Option<Key>,
}

impl Store {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Store { dir: dir.into(), kdf: Kdf::default(), key: None, prev: None }
    }

    /// Use cheaper key derivation. Only for tests.
    pub fn with_kdf(dir: impl Into<PathBuf>, kdf: Kdf) -> Self {
        Store { dir: dir.into(), kdf, key: None, prev: None }
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

    /// Whether `dir` already holds Orga-Neo data.
    pub fn has_data(dir: &Path) -> bool {
        dir.join("open.json").exists() || dir.join("vault.json").exists()
    }

    /// Refuse targets that are this folder or lie inside it.
    pub fn check_new_dir(&self, target: &Path) -> Result<()> {
        let (current, target) = (resolve(&self.dir), resolve(target));
        if current == target {
            return Err(Error::SameFolder);
        }
        if target.starts_with(&current) {
            return Err(Error::InsideCurrent);
        }
        Ok(())
    }

    /// Move all data to `target`, which must not hold Orga-Neo data yet.
    ///
    /// Everything is copied and checked first. Then `commit` runs (the app
    /// saves the new location there); only when it succeeds are the old files
    /// deleted. On any failure the copies are removed and the old folder is
    /// left exactly as it was. The vault stays unlocked if it was.
    pub fn move_to(&mut self, target: &Path, commit: impl FnOnce() -> std::io::Result<()>) -> Result<()> {
        self.check_new_dir(target)?;
        if Store::has_data(target) {
            return Err(Error::TargetHasData);
        }
        fs::create_dir_all(target)?;
        let copied = DATA_ENTRIES
            .iter()
            .try_for_each(|name| copy_tree(&self.dir.join(name), &target.join(name)))
            .and_then(|()| commit());
        if let Err(err) = copied {
            for name in DATA_ENTRIES {
                let _ = remove_entry(&target.join(name));
            }
            return Err(err.into());
        }
        for name in DATA_ENTRIES {
            let _ = remove_entry(&self.dir.join(name));
        }
        let _ = fs::remove_dir(&self.dir); // only if nothing else is left in it
        self.dir = target.to_path_buf();
        Ok(())
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
            prev: None,
        };
        self.save_vault_file(&file)?;
        self.key = Some(key);
        Ok(codes)
    }

    pub fn unlock(&mut self, password: &str) -> Result<()> {
        let file = self.load_vault_file()?;
        let key = unwrap_slot(&file.slots.password, password.as_bytes(), file.kdf)?;
        self.open_with(key, &file)
    }

    /// Open the vault with the recovery code or the emergency code.
    pub fn unlock_with_code(&mut self, code: &str) -> Result<()> {
        let file = self.load_vault_file()?;
        let code = normalize_code(code);
        for slot in [&file.slots.recovery, &file.slots.emergency] {
            if let Ok(key) = unwrap_slot(slot, code.as_bytes(), file.kdf) {
                return self.open_with(key, &file);
            }
        }
        Err(Error::WrongSecret)
    }

    pub fn lock(&mut self) {
        self.key = None;
        self.prev = None;
    }

    /// Keep `key` as the open vault key. Finishes a key change that a crash
    /// interrupted; if that fails again, documents stay readable with either
    /// key and the next unlock tries once more.
    fn open_with(&mut self, key: Key, file: &VaultFile) -> Result<()> {
        let prev = match &file.prev {
            Some(sealed) => Some(open_key(&key, sealed, b"vault-prev-key")?),
            None => None,
        };
        self.key = Some(key);
        self.prev = prev;
        if self.prev.is_some() {
            let _ = self.finish_key_change();
        }
        Ok(())
    }

    /// Set a new master password. The vault must be unlocked.
    /// The old password stops working, also for the copies in backups/.
    pub fn change_password(&mut self, new_password: &str) -> Result<()> {
        check_password(new_password)?;
        let key = self.key.clone().ok_or(Error::Locked)?;
        let mut file = self.load_vault_file()?;
        file.slots.password = self.wrap(&key, new_password.as_bytes())?;
        self.save_vault_file(&file)?;
        self.reseal_backups(&key, &key, &file.slots)
    }

    /// Replace both printed codes and the vault key. The master password is
    /// needed because its slot must be written again for the new key. The
    /// old codes stop working, also for the copies in backups/, and an old
    /// copy of vault.json no longer opens today's data or documents.
    pub fn new_codes(&mut self, password: &str) -> Result<Codes> {
        let key = self.key.clone().ok_or(Error::Locked)?;
        let file = self.load_vault_file()?;
        let given = unwrap_slot(&file.slots.password, password.as_bytes(), file.kdf)?;
        if given[..] != key[..] {
            return Err(Error::WrongSecret);
        }
        self.change_key(password)
    }

    /// Set a new master password, new codes and a new vault key at once.
    pub fn change_password_and_codes(&mut self, new_password: &str) -> Result<Codes> {
        check_password(new_password)?;
        self.change_key(new_password)
    }

    /// Replace the vault key and all three slots. Once the new vault.json is
    /// written the codes are valid and returned, even if re-encrypting the
    /// documents and backups has to be finished at the next unlock.
    fn change_key(&mut self, password: &str) -> Result<Codes> {
        if self.prev.is_some() {
            // never stack two unfinished key changes: the oldest key would be lost
            self.finish_key_change()?;
        }
        let codes = self.start_key_change(password)?;
        let _ = self.finish_key_change();
        Ok(codes)
    }

    /// Step 1: write vault.json with the new key, new slots and the old key
    /// sealed inside. Nothing else changes yet.
    fn start_key_change(&mut self, password: &str) -> Result<Codes> {
        let old = self.key.clone().ok_or(Error::Locked)?;
        let mut file = self.load_vault_file()?;
        let plain = Zeroizing::new(open(&old, &file.data, b"vault-data")?);
        let mut key: Key = Zeroizing::new([0u8; 32]);
        OsRng.fill_bytes(&mut key[..]);
        let codes = Codes { recovery: new_code(), emergency: new_code() };
        file.slots = Slots {
            password: self.wrap(&key, password.as_bytes())?,
            recovery: self.wrap(&key, normalize_code(&codes.recovery).as_bytes())?,
            emergency: self.wrap(&key, normalize_code(&codes.emergency).as_bytes())?,
        };
        file.data = seal(&key, &plain, b"vault-data")?;
        file.prev = Some(seal(&key, &old[..], b"vault-prev-key")?);
        self.save_vault_file(&file)?;
        self.key = Some(key);
        self.prev = Some(old);
        Ok(codes)
    }

    /// Step 2: re-encrypt documents and backups with the new key, then drop
    /// the old key from vault.json. Safe to repeat after an interruption.
    fn finish_key_change(&mut self) -> Result<()> {
        let (Some(key), Some(old)) = (self.key.clone(), self.prev.clone()) else {
            return Ok(());
        };
        match fs::read_dir(self.dir.join("docs")) {
            Ok(entries) => {
                for entry in entries {
                    let path = entry?.path();
                    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    let Some(id) = name.strip_suffix(".enc") else { continue };
                    if self.doc_path(id).is_err() {
                        continue;
                    }
                    let raw = fs::read(&path)?;
                    if decrypt_doc(&key, id, &raw).is_ok() {
                        continue; // done before an interruption
                    }
                    // a file neither key opens is damaged; leave it as it is
                    let Ok(plain) = decrypt_doc(&old, id, &raw) else { continue };
                    atomic_write(&path, &encrypt_doc(&key, id, &Zeroizing::new(plain))?)?;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        let mut file = self.load_vault_file()?;
        self.reseal_backups(&old, &key, &file.slots)?;
        file.prev = None;
        self.save_vault_file(&file)?;
        self.prev = None;
        Ok(())
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
        let out = encrypt_doc(key, id, bytes)?;
        fs::create_dir_all(self.dir.join("docs"))?;
        atomic_write(&path, &out)
    }

    pub fn read_doc(&self, id: &str) -> Result<Vec<u8>> {
        let key = self.key.as_ref().ok_or(Error::Locked)?;
        let raw = fs::read(self.doc_path(id)?)?;
        match (decrypt_doc(key, id, &raw), &self.prev) {
            // during an unfinished key change some files still use the old key
            (Err(_), Some(prev)) => decrypt_doc(prev, id, &raw),
            (result, _) => result,
        }
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
        Ok(Slot { salt: B64.encode(salt), nonce: sealed.nonce, ct: sealed.ct, kdf: Some(self.kdf) })
    }

    /// Bring every backup of this vault up to date: data sealed with `key`
    /// (re-encrypted if it still uses `old`) and the current slots, so a
    /// replaced password or code cannot open an older copy either. Pass the
    /// same key twice when only the slots changed. Backups of a different
    /// vault (e.g. from before a reset) are left alone; unreadable ones are
    /// removed, as they could still hold old slots.
    fn reseal_backups(&self, old: &Key, key: &Key, slots: &Slots) -> Result<()> {
        let entries = match fs::read_dir(self.dir.join("backups")) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        for entry in entries {
            let path = entry?.path();
            let is_vault = path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("vault-") && n.ends_with(".json"));
            if !is_vault {
                continue;
            }
            let Ok(mut file) = serde_json::from_slice::<VaultFile>(&fs::read(&path)?) else {
                fs::remove_file(&path)?;
                continue;
            };
            if let Ok(plain) = open(old, &file.data, b"vault-data") {
                file.data = seal(key, &Zeroizing::new(plain), b"vault-data")?;
            } else if open(key, &file.data, b"vault-data").is_err() {
                continue;
            }
            file.slots = slots.clone();
            file.prev = None;
            let json = serde_json::to_vec(&file).map_err(|_| Error::Corrupt)?;
            atomic_write(&path, &json)?;
        }
        Ok(())
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

/// Open a sealed 32-byte key.
fn open_key(key: &Key, sealed: &Sealed, aad: &[u8]) -> Result<Key> {
    let plain = Zeroizing::new(open(key, sealed, aad)?);
    if plain.len() != 32 {
        return Err(Error::Corrupt);
    }
    let mut out: Key = Zeroizing::new([0u8; 32]);
    out.copy_from_slice(&plain);
    Ok(out)
}

/// A document file: magic, nonce, ciphertext. The id is authenticated, so
/// files cannot be swapped.
fn encrypt_doc(key: &Key, id: &str, bytes: &[u8]) -> Result<Vec<u8>> {
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let ct = cipher(key)
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: bytes, aad: id.as_bytes() })
        .map_err(|_| Error::Corrupt)?;
    let mut out = Vec::with_capacity(DOC_MAGIC.len() + 24 + ct.len());
    out.extend_from_slice(DOC_MAGIC);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

fn decrypt_doc(key: &Key, id: &str, raw: &[u8]) -> Result<Vec<u8>> {
    if raw.len() < DOC_MAGIC.len() + 24 || &raw[..DOC_MAGIC.len()] != DOC_MAGIC {
        return Err(Error::Corrupt);
    }
    let (nonce, ct) = raw[DOC_MAGIC.len()..].split_at(24);
    cipher(key)
        .decrypt(XNonce::from_slice(nonce), Payload { msg: ct, aad: id.as_bytes() })
        .map_err(|_| Error::Corrupt)
}

/// `file_kdf` is used for slots written before each slot stored its own settings.
fn unwrap_slot(slot: &Slot, secret: &[u8], file_kdf: Kdf) -> Result<Key> {
    let salt = B64.decode(&slot.salt).map_err(|_| Error::Corrupt)?;
    let kdf = slot.kdf.unwrap_or(file_kdf);
    // The settings come from the file: refuse values that would exhaust
    // memory or take minutes, instead of trying them.
    if kdf.m > MAX_KDF.m || kdf.t > MAX_KDF.t || kdf.p > MAX_KDF.p {
        return Err(Error::Corrupt);
    }
    let kek = derive(secret, &salt, kdf)?;
    open_key(&kek, &Sealed { nonce: slot.nonce.clone(), ct: slot.ct.clone() }, b"vault-key")
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

/// Copy a file or folder tree, checking each file's size. A missing source is skipped.
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    let meta = match fs::metadata(from) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    if meta.is_dir() {
        fs::create_dir_all(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
        return Ok(());
    }
    if fs::copy(from, to)? != meta.len() || fs::metadata(to)?.len() != meta.len() {
        return Err(std::io::Error::other("copy incomplete"));
    }
    Ok(())
}

fn remove_entry(path: &Path) -> std::io::Result<()> {
    match fs::metadata(path) {
        Ok(m) if m.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// An absolute, symlink-free form of `path`, also when its last parts do not exist yet.
fn resolve(path: &Path) -> PathBuf {
    let mut rest = Vec::new();
    let mut base = path.to_path_buf();
    loop {
        if let Ok(real) = base.canonicalize() {
            return rest.iter().rev().fold(real, |p, part| p.join(part));
        }
        match (base.file_name().map(|n| n.to_owned()), base.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                base = parent.to_path_buf();
            }
            _ => return path.to_path_buf(),
        }
    }
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
        let new = s.new_codes(PW).unwrap();
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

    /// Open a copy of `backup` as if it were the live vault.
    fn store_from_backup(backup: &Path) -> (tempfile::TempDir, Store) {
        let tmp = tempfile::tempdir().unwrap();
        fs::copy(backup, tmp.path().join("vault.json")).unwrap();
        let s = store(tmp.path());
        (tmp, s)
    }

    fn vault_backup(dir: &Path) -> PathBuf {
        fs::read_dir(dir.join("backups"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| p.file_name().unwrap().to_str().unwrap().starts_with("vault-"))
            .expect("a vault backup")
    }

    /// A copy of `vault.json` as an attacker might keep it, with the data
    /// part swapped for `data_from`'s: what would the old slots open?
    fn old_slots_with_data(old_copy: &[u8], data_from: &Path) -> (tempfile::TempDir, Store) {
        let mut v: serde_json::Value = serde_json::from_slice(old_copy).unwrap();
        let cur: serde_json::Value = serde_json::from_slice(&fs::read(data_from).unwrap()).unwrap();
        v["data"] = cur["data"].clone();
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("vault.json"), serde_json::to_vec(&v).unwrap()).unwrap();
        let s = store(tmp.path());
        (tmp, s)
    }

    #[test]
    fn new_codes_need_the_master_password() {
        let tmp = tempfile::tempdir().unwrap();
        let (mut s, codes) = filled_store(tmp.path());
        assert!(matches!(s.new_codes("falsches-Passwort"), Err(Error::WrongSecret)));
        s.lock();
        s.unlock_with_code(&codes.recovery).unwrap();
        assert_eq!(s.read_doc("abc").unwrap(), b"Dokument");
    }

    #[test]
    fn new_codes_replace_the_key_so_old_copies_cannot_read_new_data() {
        let tmp = tempfile::tempdir().unwrap();
        let (mut s, old) = filled_store(tmp.path());
        let old_copy = fs::read(tmp.path().join("vault.json")).unwrap();
        let old_doc = fs::read(tmp.path().join("docs/abc.enc")).unwrap();
        let new = s.new_codes(PW).unwrap();
        s.write_vault(r#"{"neu":true}"#).unwrap();

        // the current vault opens with the password and the new codes only
        let raw = fs::read_to_string(tmp.path().join("vault.json")).unwrap();
        assert!(!raw.contains("prev"), "key change finished");
        assert_ne!(fs::read(tmp.path().join("docs/abc.enc")).unwrap(), old_doc, "document re-encrypted");
        let mut again = store(tmp.path());
        assert!(matches!(again.unlock_with_code(&old.recovery), Err(Error::WrongSecret)));
        again.unlock_with_code(&new.emergency).unwrap();
        assert_eq!(again.read_doc("abc").unwrap(), b"Dokument");
        again.lock();
        again.unlock(PW).unwrap();
        assert_eq!(again.read_vault().unwrap(), r#"{"neu":true}"#);

        // the old copy still opens with the old code, but not today's data or documents
        let (t, mut b) = old_slots_with_data(&old_copy, &tmp.path().join("vault.json"));
        b.unlock_with_code(&old.recovery).unwrap();
        assert!(b.read_vault().is_err());
        fs::create_dir_all(t.path().join("docs")).unwrap();
        fs::copy(tmp.path().join("docs/abc.enc"), t.path().join("docs/abc.enc")).unwrap();
        assert!(matches!(b.read_doc("abc"), Err(Error::Corrupt)));
    }

    #[test]
    fn a_key_change_re_encrypts_the_backups() {
        let tmp = tempfile::tempdir().unwrap();
        let (mut s, old) = filled_store(tmp.path());
        let old_copy = fs::read(tmp.path().join("vault.json")).unwrap();
        let new = s.new_codes(PW).unwrap();

        let backup = vault_backup(tmp.path());
        let (_t, mut b) = store_from_backup(&backup);
        assert!(matches!(b.unlock_with_code(&old.recovery), Err(Error::WrongSecret)));
        b.unlock_with_code(&new.recovery).unwrap();
        assert!(b.read_vault().is_ok(), "backed-up data stays readable");
        // and the old key does not open the backed-up data any more
        let (_t2, mut o) = old_slots_with_data(&old_copy, &backup);
        o.unlock(PW).unwrap();
        assert!(o.read_vault().is_err());
    }

    #[test]
    fn an_interrupted_key_change_is_finished_at_the_next_unlock() {
        let tmp = tempfile::tempdir().unwrap();
        let (mut s, _) = filled_store(tmp.path());
        let codes = s.start_key_change(PW).unwrap(); // as if the app stopped right here
        assert_eq!(s.read_doc("abc").unwrap(), b"Dokument", "old-key documents stay readable");
        s.add_doc("neu", b"Neues Dokument").unwrap();
        drop(s);

        let mut again = store(tmp.path());
        again.unlock_with_code(&codes.emergency).unwrap();
        assert!(again.prev.is_none());
        assert!(!fs::read_to_string(tmp.path().join("vault.json")).unwrap().contains("prev"));
        assert_eq!(again.read_doc("abc").unwrap(), b"Dokument");
        assert_eq!(again.read_doc("neu").unwrap(), b"Neues Dokument");
        assert_eq!(again.read_vault().unwrap(), r#"{"passwords":[{"pw":"x"}]}"#);
    }

    #[test]
    fn password_and_codes_can_change_together() {
        let tmp = tempfile::tempdir().unwrap();
        let (mut s, old) = filled_store(tmp.path());
        let new = s.change_password_and_codes("Neues-Passwort-2026").unwrap();
        assert!(matches!(s.change_password_and_codes("kurz"), Err(Error::WeakPassword)));
        s.lock();
        assert!(matches!(s.unlock(PW), Err(Error::WrongSecret)));
        assert!(matches!(s.unlock_with_code(&old.emergency), Err(Error::WrongSecret)));
        s.unlock_with_code(&new.recovery).unwrap();
        s.lock();
        s.unlock("Neues-Passwort-2026").unwrap();
        assert_eq!(s.read_doc("abc").unwrap(), b"Dokument");
    }

    #[test]
    fn old_password_and_codes_do_not_open_backups() {
        let tmp = tempfile::tempdir().unwrap();
        let mut s = store(tmp.path());
        let old = s.create_vault(PW).unwrap();
        // the first write of the day keeps a backup (with the old slots)
        s.write_vault(r#"{"v":1}"#).unwrap();
        s.change_password("Neues-Passwort-2026").unwrap();
        let new = s.new_codes("Neues-Passwort-2026").unwrap();

        let (_t, mut b) = store_from_backup(&vault_backup(tmp.path()));
        assert!(matches!(b.unlock(PW), Err(Error::WrongSecret)));
        assert!(matches!(b.unlock_with_code(&old.recovery), Err(Error::WrongSecret)));
        assert!(matches!(b.unlock_with_code(&old.emergency), Err(Error::WrongSecret)));
        b.unlock("Neues-Passwort-2026").unwrap();
        assert_eq!(b.read_vault().unwrap(), r#"{"passwords":[],"docs":[]}"#, "backed-up data stays readable");
        b.lock();
        b.unlock_with_code(&new.emergency).unwrap();
    }

    #[test]
    fn backups_of_an_earlier_vault_are_left_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let mut s = store(tmp.path());
        s.create_vault(PW).unwrap();
        s.write_vault(r#"{"alt":true}"#).unwrap();
        // start over with a new vault, as after a reset
        fs::remove_file(tmp.path().join("vault.json")).unwrap();
        let mut s = store(tmp.path());
        s.create_vault("Ganz-anderes-Passwort").unwrap();
        s.change_password("Noch-ein-Passwort-1").unwrap();

        let (_t, mut b) = store_from_backup(&vault_backup(tmp.path()));
        b.unlock(PW).unwrap();
        assert_eq!(b.read_vault().unwrap(), r#"{"passwords":[],"docs":[]}"#);
    }

    #[test]
    fn raised_kdf_settings_do_not_lock_anyone_out() {
        let tmp = tempfile::tempdir().unwrap();
        let codes = store(tmp.path()).create_vault(PW).unwrap();
        // a later version with stronger defaults changes the password
        let stronger = Kdf { m: 128, t: 2, p: 1 };
        let mut s = Store::with_kdf(tmp.path(), stronger);
        s.unlock(PW).unwrap();
        s.change_password("Neues-Passwort-2026").unwrap();

        let mut again = Store::with_kdf(tmp.path(), stronger);
        again.unlock("Neues-Passwort-2026").unwrap();
        again.lock();
        again.unlock_with_code(&codes.recovery).unwrap();
    }

    #[test]
    fn vault_files_without_slot_settings_still_open() {
        let tmp = tempfile::tempdir().unwrap();
        let codes = store(tmp.path()).create_vault(PW).unwrap();
        // strip the per-slot settings, as in files written before 0.2
        let path = tmp.path().join("vault.json");
        let mut v: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        for slot in ["password", "recovery", "emergency"] {
            v["slots"][slot].as_object_mut().unwrap().remove("kdf");
        }
        fs::write(&path, serde_json::to_vec(&v).unwrap()).unwrap();

        let mut s = store(tmp.path());
        s.unlock(PW).unwrap();
        s.lock();
        s.unlock_with_code(&codes.emergency).unwrap();
    }

    #[test]
    fn absurd_kdf_settings_in_the_file_are_refused() {
        let tmp = tempfile::tempdir().unwrap();
        store(tmp.path()).create_vault(PW).unwrap();
        let path = tmp.path().join("vault.json");
        let mut v: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        // 4 TiB would exhaust memory long before failing on its own
        v["slots"]["password"]["kdf"]["m"] = serde_json::json!(u32::MAX);
        fs::write(&path, serde_json::to_vec(&v).unwrap()).unwrap();
        assert!(matches!(store(tmp.path()).unlock(PW), Err(Error::Corrupt)));
    }

    fn filled_store(dir: &Path) -> (Store, Codes) {
        let mut s = store(dir);
        let codes = s.create_vault(PW).unwrap();
        s.write_open(r#"{"v":1}"#).unwrap();
        s.write_vault(r#"{"passwords":[{"pw":"x"}]}"#).unwrap();
        s.add_doc("abc", b"Dokument").unwrap();
        (s, codes)
    }

    #[test]
    fn moving_takes_everything_and_clears_the_old_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("alt");
        let new = tmp.path().join("usb").join("Orga-Neo");
        let (mut s, codes) = filled_store(&old);
        let mut committed = false;
        s.move_to(&new, || {
            committed = true;
            Ok(())
        })
        .unwrap();
        assert!(committed);
        assert_eq!(s.dir(), new);
        assert!(!old.exists(), "old folder removed");
        assert_eq!(s.read_doc("abc").unwrap(), b"Dokument", "still unlocked");

        let mut again = store(&new);
        assert_eq!(again.read_open().unwrap(), r#"{"v":1}"#);
        again.unlock_with_code(&codes.recovery).unwrap();
        assert!(again.read_vault().unwrap().contains("pw"));
        assert!(new.join("backups").read_dir().unwrap().count() > 0);
    }

    #[test]
    fn a_failed_commit_leaves_the_old_folder_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("alt");
        let new = tmp.path().join("neu");
        let (mut s, _) = filled_store(&old);
        let err = s.move_to(&new, || Err(std::io::Error::other("no config")));
        assert!(matches!(err, Err(Error::Io(_))));
        assert_eq!(s.dir(), old);
        assert!(Store::has_data(&old) && old.join("docs/abc.enc").exists());
        assert!(!Store::has_data(&new), "partial copies removed");
        s.unlock(PW).unwrap();
        assert!(s.read_vault().unwrap().contains("pw"));
    }

    #[test]
    fn moving_refuses_unsafe_targets() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("alt");
        let (mut s, _) = filled_store(&old);
        let other = tmp.path().join("andere");
        store(&other).write_open("{}").unwrap();
        let ok = || Ok(());
        assert!(matches!(s.move_to(&old, ok), Err(Error::SameFolder)));
        assert!(matches!(s.move_to(&old.join("docs/x"), ok), Err(Error::InsideCurrent)));
        assert!(matches!(s.move_to(&other, ok), Err(Error::TargetHasData)));
        assert!(Store::has_data(&old));
    }

    #[test]
    fn creating_twice_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let mut s = store(tmp.path());
        s.create_vault(PW).unwrap();
        assert!(matches!(s.create_vault(PW), Err(Error::AlreadyInitialized)));
    }
}
