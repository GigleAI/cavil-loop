// Windows Credential Manager (GitHub#577): where the Windows app keeps the GitHub sign-in and the
// keys of paired remote machines, the counterpart of the macOS keychain (platform::MacKeychainStore,
// remote::MacKeys).
//
// Two layers, so that what the app decides is tested on every system:
//   - `CredApi`: the three calls the system offers (read / write / delete one generic credential by
//     its target name). The real one (`System`, Windows only) calls advapi32; the tests use a fake.
//   - `WinCredStore`: everything that decides — which target name, the shape checks, and what each
//     answer means. Only "the system says there is no such credential" (ERROR_NOT_FOUND) is "none";
//     every other failure, and a stored value that is not text, is an error — never "not signed in".
//
// Credentials are generic ones, kept for this user on this computer (CRED_PERSIST_LOCAL_MACHINE: not
// copied to other computers of a roaming profile). The secret goes to the system as bytes, never in
// a command line.

use crate::i18n::Said;
use crate::platform::{assert_token_shape, CredentialStore, KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE};
use async_trait::async_trait;
use std::sync::Arc;

/// The system's "no such credential" (ERROR_NOT_FOUND).
pub const NOT_FOUND: u32 = 1168;
/// The longest secret a generic credential holds (CRED_MAX_CREDENTIAL_BLOB_SIZE, 5 × 512 bytes).
pub const MAX_BLOB: usize = 2560;

/// What one read answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Read {
    Found(Vec<u8>),
    NotFound,
    /// the system's error code
    Failed(u32),
}

/// The Credential Manager's three calls, by target name. `user` is what the system shows as the
/// credential's user name.
pub trait CredApi: Send + Sync {
    fn read(&self, target: &str) -> Read;
    fn write(&self, target: &str, user: &str, secret: &[u8]) -> Result<(), u32>;
    /// Err(NOT_FOUND) when there was nothing to delete
    fn delete(&self, target: &str) -> Result<(), u32>;
}

/// The target name of the GitHub sign-in: the same service / account names the macOS keychain uses.
pub fn token_target() -> String {
    format!("{KEYCHAIN_SERVICE}/{KEYCHAIN_ACCOUNT}")
}

/// The target name of one paired remote machine's key (`account` as remote::KeyStore names it).
pub fn remote_target(account: &str) -> String {
    format!("{KEYCHAIN_SERVICE}/remote/{account}")
}

fn code(c: u32) -> String {
    format!("Windows error {c}")
}

pub struct WinCredStore {
    api: Arc<dyn CredApi>,
}

impl WinCredStore {
    pub fn new(api: Arc<dyn CredApi>) -> WinCredStore {
        WinCredStore { api }
    }

    /// The real Credential Manager (Windows only).
    #[cfg(windows)]
    pub fn system() -> WinCredStore {
        WinCredStore::new(Arc::new(System))
    }

    /// Ok(None) only when the system says there is no such credential.
    pub fn get_at(&self, target: &str) -> Result<Option<String>, Said> {
        match self.api.read(target) {
            Read::Found(bytes) => match String::from_utf8(bytes) {
                Ok(s) => Ok(Some(s.trim().to_string()).filter(|s| !s.is_empty())),
                // something is stored there, and it is not what this app writes: not "nothing stored"
                Err(_) => Err(Said::new("读取 Windows 凭据管理器失败：{e}", &[("e", "not UTF-8 text")], "system")),
            },
            Read::NotFound => Ok(None),
            Read::Failed(c) => Err(Said::new("读取 Windows 凭据管理器失败：{e}", &[("e", &code(c))], "system")),
        }
    }

    pub fn set_at(&self, target: &str, user: &str, secret: &str) -> Result<(), Said> {
        if secret.len() > MAX_BLOB {
            return Err(Said::new("写入 Windows 凭据管理器失败：{e}", &[("e", "too long")], "system"));
        }
        self.api.write(target, user, secret.as_bytes()).map_err(|c| Said::new("写入 Windows 凭据管理器失败：{e}", &[("e", &code(c))], "system"))
    }

    /// Nothing there to delete is done too.
    pub fn clear_at(&self, target: &str) -> Result<(), Said> {
        match self.api.delete(target) {
            Ok(()) | Err(NOT_FOUND) => Ok(()),
            Err(c) => Err(Said::new("删除 Windows 凭据管理器里的条目失败：{e}", &[("e", &code(c))], "system")),
        }
    }
}

#[async_trait]
impl CredentialStore for WinCredStore {
    fn persistent(&self) -> bool {
        true
    }
    async fn get(&self) -> Result<Option<String>, Said> {
        self.get_at(&token_target())
    }
    async fn set(&self, token: &str) -> Result<(), Said> {
        assert_token_shape(token)?;
        self.set_at(&token_target(), KEYCHAIN_ACCOUNT, token)
    }
    async fn clear(&self) -> Result<(), Said> {
        self.clear_at(&token_target())
    }
}

#[async_trait]
impl crate::remote::KeyStore for WinCredStore {
    fn persistent(&self) -> bool {
        true
    }
    async fn get(&self, account: &str) -> Result<Option<String>, Said> {
        self.get_at(&remote_target(account))
    }
    async fn set(&self, account: &str, key: &str) -> Result<(), Said> {
        self.set_at(&remote_target(account), account, key)
    }
    async fn clear(&self, account: &str) -> Result<(), Said> {
        self.clear_at(&remote_target(account))
    }
}

/// The real calls (advapi32).
#[cfg(windows)]
pub struct System;

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
impl CredApi for System {
    fn read(&self, target: &str) -> Read {
        use windows_sys::Win32::Foundation::GetLastError;
        use windows_sys::Win32::Security::Credentials::{CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC};
        let t = wide(target);
        let mut p: *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: `t` is a NUL-terminated UTF-16 string that outlives the call; on success the system
        // hands back one allocation, read here and freed with CredFree exactly once.
        unsafe {
            if CredReadW(t.as_ptr(), CRED_TYPE_GENERIC, 0, &mut p) == 0 {
                let c = GetLastError();
                return if c == NOT_FOUND { Read::NotFound } else { Read::Failed(c) };
            }
            let c = &*p;
            let bytes = if c.CredentialBlob.is_null() || c.CredentialBlobSize == 0 {
                Vec::new()
            } else {
                std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize).to_vec()
            };
            CredFree(p as *const core::ffi::c_void);
            Read::Found(bytes)
        }
    }

    fn write(&self, target: &str, user: &str, secret: &[u8]) -> Result<(), u32> {
        use windows_sys::Win32::Foundation::GetLastError;
        use windows_sys::Win32::Security::Credentials::{CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC};
        let mut t = wide(target);
        let mut u = wide(user);
        let mut blob = secret.to_vec();
        let cred = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: t.as_mut_ptr(),
            UserName: u.as_mut_ptr(),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };
        // SAFETY: every pointer in `cred` points into a buffer owned by this frame that outlives the call.
        let ok = unsafe { CredWriteW(&cred, 0) };
        if ok == 0 {
            // SAFETY: no other call in between
            Err(unsafe { GetLastError() })
        } else {
            Ok(())
        }
    }

    fn delete(&self, target: &str) -> Result<(), u32> {
        use windows_sys::Win32::Foundation::GetLastError;
        use windows_sys::Win32::Security::Credentials::{CredDeleteW, CRED_TYPE_GENERIC};
        let t = wide(target);
        // SAFETY: `t` is NUL-terminated and outlives the call
        unsafe {
            if CredDeleteW(t.as_ptr(), CRED_TYPE_GENERIC, 0) == 0 {
                Err(GetLastError())
            } else {
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::KeyStore;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// A stand-in Credential Manager: a map, plus a failure to give on the next calls.
    #[derive(Default)]
    struct Fake {
        items: Mutex<HashMap<String, (String, Vec<u8>)>>,
        fail: Mutex<Option<u32>>,
        calls: Mutex<Vec<String>>,
    }

    impl CredApi for Fake {
        fn read(&self, target: &str) -> Read {
            self.calls.lock().unwrap().push(format!("read {target}"));
            if let Some(c) = *self.fail.lock().unwrap() {
                return Read::Failed(c);
            }
            match self.items.lock().unwrap().get(target) {
                Some((_, b)) => Read::Found(b.clone()),
                None => Read::NotFound,
            }
        }
        fn write(&self, target: &str, user: &str, secret: &[u8]) -> Result<(), u32> {
            self.calls.lock().unwrap().push(format!("write {target}"));
            if let Some(c) = *self.fail.lock().unwrap() {
                return Err(c);
            }
            self.items.lock().unwrap().insert(target.into(), (user.into(), secret.to_vec()));
            Ok(())
        }
        fn delete(&self, target: &str) -> Result<(), u32> {
            self.calls.lock().unwrap().push(format!("delete {target}"));
            if let Some(c) = *self.fail.lock().unwrap() {
                return Err(c);
            }
            self.items.lock().unwrap().remove(target).map(|_| ()).ok_or(NOT_FOUND)
        }
    }

    fn store() -> (Arc<Fake>, WinCredStore) {
        let f = Arc::new(Fake::default());
        (f.clone(), WinCredStore::new(f))
    }

    const TOKEN: &str = "gho_0123456789abcdefABCDEF0123456789";

    #[tokio::test]
    async fn the_sign_in_is_kept_read_back_and_cleared() {
        let (f, s) = store();
        assert!(CredentialStore::persistent(&s));
        assert_eq!(CredentialStore::get(&s).await.unwrap(), None);
        CredentialStore::set(&s, TOKEN).await.unwrap();
        // under the same service / account names as the macOS keychain
        let items = f.items.lock().unwrap().clone();
        assert_eq!(items.get("dev.luosky.cavil-loop.client/github-oauth"), Some(&("github-oauth".to_string(), TOKEN.as_bytes().to_vec())));
        assert_eq!(CredentialStore::get(&s).await.unwrap().as_deref(), Some(TOKEN));
        CredentialStore::clear(&s).await.unwrap();
        assert_eq!(CredentialStore::get(&s).await.unwrap(), None);
        // clearing again: nothing there is done too
        CredentialStore::clear(&s).await.unwrap();
        assert!(f.calls.lock().unwrap().iter().filter(|c| c.starts_with("delete")).count() == 2);
    }

    #[tokio::test]
    async fn a_failed_read_is_an_error_never_not_signed_in() {
        let (f, s) = store();
        CredentialStore::set(&s, TOKEN).await.unwrap();
        *f.fail.lock().unwrap() = Some(5); // ERROR_ACCESS_DENIED
        let e = CredentialStore::get(&s).await.unwrap_err();
        assert!(e.text().contains("Windows error 5"), "{}", e.text());
        // a failed write / delete says so too
        assert!(CredentialStore::set(&s, TOKEN).await.unwrap_err().text().contains("Windows error 5"));
        assert!(CredentialStore::clear(&s).await.unwrap_err().text().contains("Windows error 5"));
        // and the credential is still there once the system answers again
        *f.fail.lock().unwrap() = None;
        assert_eq!(CredentialStore::get(&s).await.unwrap().as_deref(), Some(TOKEN));
    }

    #[tokio::test]
    async fn something_stored_that_is_not_text_is_an_error_not_nothing() {
        let (f, s) = store();
        f.items.lock().unwrap().insert(token_target(), ("github-oauth".into(), vec![0xff, 0xfe, 0x00]));
        assert!(CredentialStore::get(&s).await.is_err());
        // an empty value is "nothing stored", as on macOS
        f.items.lock().unwrap().insert(token_target(), ("github-oauth".into(), vec![]));
        assert_eq!(CredentialStore::get(&s).await.unwrap(), None);
    }

    #[tokio::test]
    async fn a_token_of_the_wrong_shape_never_reaches_the_system() {
        let (f, s) = store();
        assert!(CredentialStore::set(&s, "not a token\"; rm").await.is_err());
        assert!(f.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn remote_keys_are_one_credential_per_machine_apart_from_the_sign_in() {
        let (f, s) = store();
        let key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        KeyStore::set(&s, "box.tail1.ts.net:443", key).await.unwrap();
        KeyStore::set(&s, "other.tail1.ts.net:443", &key.replace('0', "1")).await.unwrap();
        assert_eq!(KeyStore::get(&s, "box.tail1.ts.net:443").await.unwrap().as_deref(), Some(key));
        assert!(f.items.lock().unwrap().contains_key("dev.luosky.cavil-loop.client/remote/box.tail1.ts.net:443"));
        assert_eq!(CredentialStore::get(&s).await.unwrap(), None);
        KeyStore::clear(&s, "box.tail1.ts.net:443").await.unwrap();
        assert_eq!(KeyStore::get(&s, "box.tail1.ts.net:443").await.unwrap(), None);
        assert!(KeyStore::get(&s, "other.tail1.ts.net:443").await.unwrap().is_some());
    }

    /// The real Credential Manager (the Windows CI job runs this): store, read back, clear, and
    /// "not there" after clearing — under a target name of its own, removed again at the end.
    #[cfg(windows)]
    #[test]
    fn the_real_credential_manager_round_trip() {
        let s = WinCredStore::system();
        let target = format!("dev.luosky.cavil-loop.client/test-{}", std::process::id());
        let _ = s.clear_at(&target);
        assert_eq!(s.get_at(&target).unwrap(), None);
        s.set_at(&target, "test", TOKEN).unwrap();
        assert_eq!(s.get_at(&target).unwrap().as_deref(), Some(TOKEN));
        s.set_at(&target, "test", "second").unwrap();
        assert_eq!(s.get_at(&target).unwrap().as_deref(), Some("second"));
        s.clear_at(&target).unwrap();
        assert_eq!(s.get_at(&target).unwrap(), None);
        assert_eq!(System.delete(&target), Err(NOT_FOUND));
        s.clear_at(&target).unwrap();
    }
}
