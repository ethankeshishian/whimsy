"""Keeps Whimsy's update-signing key backed up in 1Password.

  python3 whimsy/signing_backup.py backup    store the key (once) and verify it
  python3 whimsy/signing_backup.py restore   bring the key back if it's missing
  python3 whimsy/signing_backup.py check     exit 1 unless the backup matches

Every installed Whimsy only accepts updates signed with this key, so losing it
means no more updates for anyone. The key lives in
~/Library/Application Support/Whimsy Updater/signing, never in the repository.
The 1Password CLI (`op`) asks for approval (Touch ID) when it isn't unlocked;
unattended runs that can't get it skip, they never fail the caller.
"""
import hashlib
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SIGNING = os.path.expanduser("~/Library/Application Support/Whimsy Updater/signing")
KEY = os.path.join(SIGNING, "private_key.pem")
CERT = os.path.join(SIGNING, "cert.pem")
PUBLIC_DER = os.path.join(ROOT, "whimsy", "signing", "whimsy-mar.der")
TITLE = "Whimsy update signing key"
MARKER = os.path.join(SIGNING, "backed-up")


def op(*args, timeout=120, binary=False):
    proc = subprocess.run(["op", *args], capture_output=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode(errors="replace").strip() or "op failed")
    return proc.stdout if binary else proc.stdout.decode()


def vault():
    vaults = [v["name"] for v in json.loads(op("vault", "list", "--format", "json"))]
    for name in ("Private", "Personal"):
        if name in vaults:
            return name
    return vaults[0]


def stored_key():
    try:
        return op("document", "get", TITLE, binary=True)
    except RuntimeError as e:
        if "isn't an item" in str(e) or "not found" in str(e).lower():
            return None
        raise


def sha(data):
    return hashlib.sha256(data).hexdigest()


def backup():
    local = open(KEY, "rb").read()
    remote = stored_key()
    if remote is None:
        op("document", "create", KEY, "--title", TITLE, "--vault", vault(), "--tags", "whimsy",
           "--file-name", "whimsy-private_key.pem")
        remote = stored_key()
    if remote is None or sha(remote) != sha(local):
        raise RuntimeError("the 1Password copy doesn't match this Mac's key")
    open(MARKER, "w").write(sha(local) + "\n")
    print(f"backup: '{TITLE}' in 1Password matches this Mac's key")


def restore():
    if os.path.exists(KEY):
        print("restore: the key is already here")
        return
    data = stored_key()
    if data is None:
        raise RuntimeError(f"no '{TITLE}' in 1Password")
    os.makedirs(SIGNING, mode=0o700, exist_ok=True)
    with open(KEY, "wb") as f:
        f.write(data)
    os.chmod(KEY, 0o600)
    # The certificate is public: rebuild it from the one the updater ships.
    subprocess.run(["openssl", "x509", "-inform", "DER", "-in", PUBLIC_DER, "-out", CERT], check=True)
    open(MARKER, "w").write(sha(data) + "\n")
    print("restore: key restored from 1Password")


def is_backed_up():
    """Cheap local check: was this exact key verified in 1Password?"""
    try:
        return open(MARKER).read().strip() == sha(open(KEY, "rb").read())
    except OSError:
        return False


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    try:
        if cmd == "backup":
            backup()
        elif cmd == "restore":
            restore()
        else:
            ok = stored_key()
            if ok is None or sha(ok) != sha(open(KEY, "rb").read()):
                raise RuntimeError("1Password has no matching copy of the key")
            print("check: backed up")
    except (RuntimeError, subprocess.TimeoutExpired, FileNotFoundError) as e:
        print(f"{cmd}: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
