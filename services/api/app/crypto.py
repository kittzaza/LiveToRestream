from __future__ import annotations

import base64
import hashlib

from cryptography.fernet import Fernet


def derive_fernet_key(secret: str) -> bytes:
    # Fernet key must be 32 urlsafe-base64 bytes.
    digest = hashlib.sha256(secret.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest)


def stream_key_hash(stream_key: str) -> str:
    return hashlib.sha256(stream_key.encode("utf-8")).hexdigest()


class StreamKeyCrypto:
    def __init__(self, secret: str) -> None:
        self._fernet = Fernet(derive_fernet_key(secret))

    def encrypt(self, plaintext: str) -> str:
        return self._fernet.encrypt(plaintext.encode("utf-8")).decode("utf-8")

    def decrypt(self, ciphertext: str) -> str:
        return self._fernet.decrypt(ciphertext.encode("utf-8")).decode("utf-8")
