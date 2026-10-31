"""Whimsy's update-signing key lives only in 1Password.

  python3 whimsy/signing_backup.py check   exit 1 unless the configured vault has
                                           the key, matching the shipped certificate

Every installed Whimsy only accepts updates signed with this key, so losing it
means no more updates for anyone, and leaking it lets whoever has it ship
updates to everyone (security-full-3 M2). So there's no copy at rest:
publish.py asks 1Password for it only while signing (`signing_key()`), into a
private temporary folder that is overwritten and deleted afterwards, also
when signing fails. A run that was killed outright leaves that folder behind;
the next signing sweeps it first, and its NSS database is password-protected
with a password that only ever lived in memory.

The vault is configured explicitly, never guessed (security-full-3 L2):
`signing_vault` in whimsy/publish.json, or WHIMSY_SIGNING_VAULT. The 1Password
CLI (`op`) asks for approval (Touch ID) when it isn't unlocked, so an
unattended nightly can only sign while 1Password is unlocked; otherwise
publishing fails, is logged, and the nightly tries again the next night.

The key used to live in ~/Library/Application Support/Whimsy Updater/signing.
whimsy/signing_migrate.py moves an existing copy into 1Password (by hand,
once). Until that's done (no vault configured yet), signing keeps using that
on-disk key, with a warning on every publish, so shipping never waits on the
migration. Once a vault is configured, only the vault is used: no fallback.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from contextlib import contextmanager

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.expanduser("~/Library/Application Support/Whimsy Updater")
# Where the key used to be kept (signing_migrate.py moves it out).
SIGNING = os.path.join(DATA, "signing")
LEGACY_KEY = os.path.join(SIGNING, "private_key.pem")
LEGACY_MARKER = os.path.join(SIGNING, "backed-up")
# Private temporary folders for signing (0700), so leftovers can be swept.
SCRATCH = os.path.join(DATA, "signing-tmp")
PUBLIC_DER = os.path.join(ROOT, "whimsy", "signing", "whimsy-mar.der")
PUBLISH_JSON = os.path.join(ROOT, "whimsy", "publish.json")
TITLE = "Whimsy update signing key"


def op(*args, timeout=120, binary=False, input=None):
    proc = subprocess.run(["op", *args], capture_output=True, timeout=timeout, input=input)
    if proc.returncode != 0:
        # op's errors never contain the document itself.
        raise RuntimeError(proc.stderr.decode(errors="replace").strip() or "op failed")
    return proc.stdout if binary else proc.stdout.decode()


def configured_vault():
    """The 1Password vault that holds the key: set by hand, never the first
    vault op lists (that can be a shared or family vault)."""
    name = os.environ.get("WHIMSY_SIGNING_VAULT", "").strip()
    if not name:
        try:
            with open(PUBLISH_JSON) as f:
                name = (json.load(f).get("signing_vault") or "").strip()
        except (OSError, ValueError):
            name = ""
    if not name:
        raise RuntimeError("no 1Password vault is configured for the signing key: set \"signing_vault\" "
                           "in whimsy/publish.json (or WHIMSY_SIGNING_VAULT) to your private vault's name")
    return name


def check_vault(name):
    """Refuse unless the configured vault exists, by exact name or id."""
    vaults = json.loads(op("vault", "list", "--format", "json"))
    if not any(name in (v.get("name"), v.get("id")) for v in vaults):
        raise RuntimeError(f"1Password has no vault named {name!r} (signing_vault in whimsy/publish.json)")
    return name


def stored_key(vault):
    """The key from the configured vault, or None if it isn't there."""
    try:
        return op("document", "get", TITLE, "--vault", vault, binary=True)
    except RuntimeError as e:
        if "isn't an item" in str(e) or "not found" in str(e).lower() or "no item" in str(e).lower():
            return None
        raise


def sha(data):
    return hashlib.sha256(data).hexdigest()


def public_key_of_cert():
    out = subprocess.run(["openssl", "x509", "-inform", "DER", "-in", PUBLIC_DER, "-pubkey", "-noout"],
                         capture_output=True, check=True)
    return out.stdout.strip()


def public_key_of(key_pem):
    """The public half of a private key, without writing the key anywhere."""
    out = subprocess.run(["openssl", "pkey", "-pubout"], input=key_pem, capture_output=True)
    if out.returncode != 0:
        raise RuntimeError("that isn't a readable private key")
    return out.stdout.strip()


def matches_certificate(key_pem):
    return public_key_of(key_pem) == public_key_of_cert()


# ---- temporary key material ------------------------------------------------

def shred(path):
    """Overwrite then delete a file or folder. Best effort on SSDs/APFS (copy-on-
    write can keep old blocks), but nothing readable stays at the path."""
    if os.path.isdir(path) and not os.path.islink(path):
        for root, dirs, files in os.walk(path, topdown=False):
            for name in files:
                shred(os.path.join(root, name))
            for name in dirs:
                try:
                    os.rmdir(os.path.join(root, name))
                except OSError:
                    shutil.rmtree(os.path.join(root, name), ignore_errors=True)
        shutil.rmtree(path, ignore_errors=True)
        return
    try:
        if os.path.isfile(path) and not os.path.islink(path):
            size = os.path.getsize(path)
            with open(path, "r+b", buffering=0) as f:
                f.write(b"\0" * size)
                os.fsync(f.fileno())
        os.remove(path)
    except FileNotFoundError:
        pass


def sweep():
    """Remove signing folders left by a run that was killed outright."""
    if not os.path.isdir(SCRATCH):
        return
    for name in os.listdir(SCRATCH):
        shred(os.path.join(SCRATCH, name))


@contextmanager
def private_dir():
    """A 0700 folder for key material, overwritten and deleted on the way out
    (also on errors, Ctrl-C and SIGTERM handled by the caller)."""
    os.makedirs(SCRATCH, mode=0o700, exist_ok=True)
    os.chmod(SCRATCH, 0o700)
    sweep()
    path = tempfile.mkdtemp(prefix="sign-", dir=SCRATCH)
    try:
        yield path
    finally:
        shred(path)


def write_private(path, data):
    """Create a new 0600 file (never follow or reuse an existing one)."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)


def vault_or_none():
    """The configured vault, or None while none is configured."""
    try:
        return configured_vault()
    except RuntimeError:
        return None


def key_source():
    """Where signing will read the key: ("vault", name) once a vault is
    configured; until then ("legacy", path) for the pre-1Password key on this
    Mac. Raises when neither is there, so publish.py fails before packaging."""
    vault = vault_or_none()
    if vault:
        return ("vault", vault)
    if os.path.isfile(LEGACY_KEY):
        return ("legacy", LEGACY_KEY)
    # Neither: the vault message says what to set up.
    configured_vault()


def warn_legacy():
    # Never prints the key or anything derived from it; only where it is.
    print(f"WARNING: signing with the on-disk key in {SIGNING}: no 1Password vault is configured "
          "(\"signing_vault\" in whimsy/publish.json). Move it with python3 whimsy/signing_migrate.py "
          "when you can.", file=sys.stderr, flush=True)


def signing_key():
    """The private key as bytes (kept in memory; the caller hands it to
    openssl on stdin): from the configured vault, or, while no vault is
    configured, from the old on-disk location with a warning."""
    kind, where = key_source()
    if kind == "legacy":
        warn_legacy()
        with open(where, "rb") as f:
            return f.read()
    vault = where
    data = stored_key(vault)
    if data is None:
        raise RuntimeError(f"no '{TITLE}' document in the 1Password vault {vault!r}. If the key is still on this "
                           "Mac, run python3 whimsy/signing_migrate.py")
    return data


def check():
    vault = check_vault(configured_vault())
    data = stored_key(vault)
    if data is None:
        raise RuntimeError(f"1Password's {vault!r} vault has no '{TITLE}'")
    if not matches_certificate(data):
        raise RuntimeError(f"the '{TITLE}' in {vault!r} doesn't match the certificate Whimsy ships")
    print(f"check: '{TITLE}' in {vault!r} matches the shipped certificate")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    try:
        if cmd == "check":
            check()
        elif cmd in ("backup", "restore"):
            raise RuntimeError(f"`{cmd}` is gone: the key lives only in 1Password now. To move a key that's "
                               "still on this Mac there, run python3 whimsy/signing_migrate.py")
        else:
            raise SystemExit(__doc__)
    except (RuntimeError, subprocess.TimeoutExpired, subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f"{cmd}: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
