"""A Geny Net node's identity (docs/geny-net.md): its own certificate authority, the certificate its listener shows,
and the certificates it gives the devices it pairs with.

The node (the desktop app's local backend) is its own CA: an EC P-256 key that never leaves the machine (``net/``
under the data home, 0600), a self-signed CA certificate, a server certificate for its TLS listener, and a client
certificate for each paired device (issued for the device's own public key — its private key stays in the phone's
keystore). A device trusts the node by the SHA-256 of the CA certificate it got from the QR code; the node trusts a
device by the certificate it issued. The node id is derived from the CA public key, so a relay can check that whoever
claims an id holds its key.
"""

from __future__ import annotations

import base64
import datetime as dt
import hashlib
import os
import secrets
from dataclasses import dataclass
from pathlib import Path

from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

CA_YEARS = 20
SERVER_DAYS = 825
DEVICE_DAYS = 825


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def unb64u(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def spki(public_key) -> bytes:
    return public_key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)


def node_id_of(public_key) -> str:
    """the id a node goes by: the CA public key's SHA-256, base32, 26 characters (130 bits)"""
    return base64.b32encode(hashlib.sha256(spki(public_key)).digest()).decode().rstrip("=").lower()[:26]


def fingerprint(cert: x509.Certificate) -> str:
    """what a device pins: the certificate's SHA-256 (base64url)"""
    return b64u(cert.fingerprint(hashes.SHA256()))


def _write_private(path: Path, data: bytes) -> None:
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


@dataclass
class Issued:
    device_id: str
    cert: x509.Certificate

    @property
    def pem(self) -> str:
        return self.cert.public_bytes(serialization.Encoding.PEM).decode()


class Identity:
    """The node's keys and certificates, made the first time they are needed and kept under ``root``."""

    def __init__(self, root: Path, name: str = "My Mate Geny") -> None:
        self.root = Path(root)
        self.name = name
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.ca_key, self.ca_cert = self._load_or_make_ca()
        self.server_key, self.server_cert = self._load_or_make_server()
        self.id = node_id_of(self.ca_key.public_key())

    # -- the CA ---------------------------------------------------------------------------------------------------
    def _load_or_make_ca(self):
        key_p, cert_p = self.root / "node.key", self.root / "node.crt"
        if key_p.is_file() and cert_p.is_file():
            key = serialization.load_pem_private_key(key_p.read_bytes(), password=None)
            return key, x509.load_pem_x509_certificate(cert_p.read_bytes())
        key = ec.generate_private_key(ec.SECP256R1())
        subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, f"Geny Net node {node_id_of(key.public_key())}")])
        now = _now()
        cert = (
            x509.CertificateBuilder()
            .subject_name(subject).issuer_name(subject)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - dt.timedelta(minutes=5))
            .not_valid_after(now + dt.timedelta(days=365 * CA_YEARS))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True, key_cert_sign=True, crl_sign=True,
                                         content_commitment=False, key_encipherment=False, data_encipherment=False,
                                         key_agreement=False, encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
            .sign(key, hashes.SHA256())
        )
        _write_private(key_p, key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                                serialization.NoEncryption()))
        _write_private(cert_p, cert.public_bytes(serialization.Encoding.PEM))
        return key, cert

    # -- the listener's certificate --------------------------------------------------------------------------------
    def _load_or_make_server(self):
        key_p, cert_p = self.root / "server.key", self.root / "server.crt"
        if key_p.is_file() and cert_p.is_file():
            cert = x509.load_pem_x509_certificate(cert_p.read_bytes())
            if cert.not_valid_after_utc - _now() > dt.timedelta(days=30):
                return serialization.load_pem_private_key(key_p.read_bytes(), password=None), cert
        key = ec.generate_private_key(ec.SECP256R1())
        now = _now()
        node = node_id_of(self.ca_key.public_key())
        cert = (
            x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, f"{node}.geny.net")]))
            .issuer_name(self.ca_cert.subject)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - dt.timedelta(minutes=5))
            .not_valid_after(now + dt.timedelta(days=SERVER_DAYS))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.SubjectAlternativeName([x509.DNSName(f"{node}.geny.net")]), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(self.ca_key.public_key()), critical=False)
            .sign(self.ca_key, hashes.SHA256())
        )
        _write_private(key_p, key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                                serialization.NoEncryption()))
        _write_private(cert_p, cert.public_bytes(serialization.Encoding.PEM) + self.ca_pem.encode())
        return key, cert

    @property
    def ca_pem(self) -> str:
        return self.ca_cert.public_bytes(serialization.Encoding.PEM).decode()

    @property
    def ca_fingerprint(self) -> str:
        return fingerprint(self.ca_cert)

    @property
    def ca_spki(self) -> str:
        return b64u(spki(self.ca_key.public_key()))

    def server_files(self) -> tuple[Path, Path, Path]:
        """(the listener's certificate chain, its key, the CA that devices' certificates chain to)"""
        return self.root / "server.crt", self.root / "server.key", self.root / "node.crt"

    # -- a device's certificate ------------------------------------------------------------------------------------
    def issue(self, device_public_spki: bytes, name: str) -> Issued:
        """a client certificate for a device's own public key (EC P-256), its id in the subject"""
        pub = serialization.load_der_public_key(device_public_spki)
        if not isinstance(pub, ec.EllipticCurvePublicKey) or pub.curve.name != "secp256r1":
            raise ValueError("a device key must be EC P-256")
        device_id = "d_" + secrets.token_hex(8)
        now = _now()
        cert = (
            x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, device_id),
                                     x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, (name or "device")[:60])]))
            .issuer_name(self.ca_cert.subject)
            .public_key(pub)
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - dt.timedelta(minutes=5))
            .not_valid_after(now + dt.timedelta(days=DEVICE_DAYS))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH]), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(self.ca_key.public_key()), critical=False)
            .sign(self.ca_key, hashes.SHA256())
        )
        return Issued(device_id, cert)

    # -- proving the id to a relay ---------------------------------------------------------------------------------
    def sign(self, data: bytes) -> str:
        return b64u(self.ca_key.sign(data, ec.ECDSA(hashes.SHA256())))


def verify_node(node_id: str, spki_b64: str, data: bytes, sig_b64: str) -> bool:
    """does whoever claims ``node_id`` hold its key (``sig`` over ``data`` by the key whose SPKI is given)?"""
    try:
        pub = serialization.load_der_public_key(unb64u(spki_b64))
        if not isinstance(pub, ec.EllipticCurvePublicKey) or node_id_of(pub) != node_id:
            return False
        pub.verify(unb64u(sig_b64), data, ec.ECDSA(hashes.SHA256()))
        return True
    except (ValueError, InvalidSignature, TypeError):
        return False
