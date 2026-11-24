//! 消息加密：XChaCha20-Poly1305，共享密钥经 SHA-256 派生成 32 字节
//! 密文格式 fnx1.<base64url(nonce 24 字节 + 密文)>，标题、正文、发送者都在密文里
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const PREFIX: &str = "fnx1.";

/// 构建时注入的默认密钥，开箱即加密；没有注入时需要在设置里填
pub const BUILTIN_KEY: Option<&str> = option_env!("FOX_NUDGE_DEFAULT_KEY");

pub fn builtin_key() -> Option<&'static str> {
    BUILTIN_KEY.filter(|k| !k.trim().is_empty())
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Sender {
    pub id: String,
    pub name: String,
    /// 头像风格，旧版本发的消息没有
    #[serde(default)]
    pub avatar: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Payload {
    pub v: u8,
    pub from: Sender,
    #[serde(default)]
    pub title: String,
    pub body: String,
}

fn cipher(secret: &str) -> XChaCha20Poly1305 {
    let digest = Sha256::digest(format!("fox-nudge/v1/{}", secret.trim()).as_bytes());
    XChaCha20Poly1305::new_from_slice(&digest).expect("32 字节密钥")
}

pub fn seal(secret: &str, payload: &Payload) -> Result<String, String> {
    seal_any(secret, payload)
}

/// 任意可序列化内容都按同一格式加密，在线心跳也用它
pub fn seal_any(secret: &str, payload: &impl Serialize) -> Result<String, String> {
    let plain = serde_json::to_vec(payload).map_err(|e| e.to_string())?;
    let mut nonce = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut nonce);
    let sealed = cipher(secret)
        .encrypt(XNonce::from_slice(&nonce), plain.as_slice())
        .map_err(|_| "加密失败".to_string())?;
    let mut out = nonce.to_vec();
    out.extend(sealed);
    Ok(format!("{PREFIX}{}", B64.encode(out)))
}

pub fn open(secret: &str, text: &str) -> Option<Payload> {
    open_any(secret, text)
}

pub fn open_any<T: serde::de::DeserializeOwned>(secret: &str, text: &str) -> Option<T> {
    let raw = B64.decode(text.strip_prefix(PREFIX)?.trim()).ok()?;
    if raw.len() < 24 + 16 {
        return None;
    }
    let (nonce, sealed) = raw.split_at(24);
    let plain = cipher(secret).decrypt(XNonce::from_slice(nonce), sealed).ok()?;
    serde_json::from_slice(&plain).ok()
}

pub fn is_sealed(text: &str) -> bool {
    text.starts_with(PREFIX)
}

/// 随机生成一个新密钥，给设置里的「生成」按钮用
pub fn generate() -> String {
    let mut bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    B64.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn payload() -> Payload {
        Payload {
            v: 1,
            from: Sender { id: "abc".into(), name: "tobe".into(), avatar: "beam".into() },
            title: "来一下".into(),
            body: "有空来一下".into(),
        }
    }
    #[test]
    fn roundtrip() {
        let sealed = seal("k1", &payload()).unwrap();
        assert!(is_sealed(&sealed));
        assert!(!sealed.contains("来一下"));
        assert_eq!(open("k1", &sealed), Some(payload()));
    }
    #[test]
    fn wrong_key_fails() {
        let sealed = seal("k1", &payload()).unwrap();
        assert_eq!(open("k2", &sealed), None);
        assert_eq!(open("k1", "fnx1.garbage"), None);
        assert_eq!(open("k1", "plain text"), None);
    }
    #[test]
    fn nonce_is_random() {
        assert_ne!(seal("k", &payload()).unwrap(), seal("k", &payload()).unwrap());
    }
}
