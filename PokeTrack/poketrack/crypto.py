"""Local-only obfuscation for stored mail passwords.

This keeps your app password from sitting in the database as plain readable
text. It is NOT protection against someone who already has access to your
Windows account -- the key lives on the same machine. Use an app password
(never your real account password) so it can be revoked at any time.
"""
import base64
import hashlib
import os

from . import db

KEY_PATH = os.path.join(db.DATA_DIR, "device.key")


def _key():
    os.makedirs(db.DATA_DIR, exist_ok=True)
    if not os.path.exists(KEY_PATH):
        with open(KEY_PATH, "wb") as fh:
            fh.write(base64.b64encode(os.urandom(32)))
        try:
            os.chmod(KEY_PATH, 0o600)
        except OSError:
            pass
    with open(KEY_PATH, "rb") as fh:
        return base64.b64decode(fh.read())


def _stream(key, nonce, length):
    return hashlib.shake_256(key + nonce).digest(length)


def encrypt(plain):
    if not plain:
        return ""
    raw = plain.encode("utf-8")
    nonce = os.urandom(16)
    keystream = _stream(_key(), nonce, len(raw))
    cipher = bytes(a ^ b for a, b in zip(raw, keystream))
    return base64.b64encode(nonce + cipher).decode("ascii")


def decrypt(blob):
    if not blob:
        return ""
    try:
        raw = base64.b64decode(blob)
        nonce, cipher = raw[:16], raw[16:]
        keystream = _stream(_key(), nonce, len(cipher))
        return bytes(a ^ b for a, b in zip(cipher, keystream)).decode("utf-8")
    except Exception:
        return ""
