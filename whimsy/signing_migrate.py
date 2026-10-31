"""One-time move of Whimsy's update-signing key from disk into 1Password.

Run by hand, once, on the Mac that has the key:

  python3 whimsy/signing_migrate.py
      Checks only, changes nothing: the configured vault exists, the key on
      disk matches the certificate Whimsy ships, whether 1Password already
      has an identical copy there, and whether other vaults hold a copy.

  python3 whimsy/signing_migrate.py --delete-plaintext
      Stores the key in the configured vault if it isn't there yet, reads it
      back and checks it's byte-identical, then overwrites and deletes
      ~/Library/Application Support/Whimsy Updater/signing/private_key.pem
      (and its old "backed-up" marker). It asks you to type "delete" first,
      and refuses to run without a terminal (never from a job or an agent).

The vault is `signing_vault` in whimsy/publish.json (or WHIMSY_SIGNING_VAULT,
or --vault NAME); it's never guessed. Nothing here prints key material.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import signing_backup as sb  # noqa: E402

CONFIRM = "delete"


def other_copies(vault):
    """Vaults other than the configured one that hold a document with the
    key's title (an older backup may have landed in the first vault listed)."""
    try:
        items = json.loads(sb.op("item", "list", "--categories", "Document", "--format", "json"))
    except Exception as e:
        print(f"migrate: couldn't list 1Password documents ({e}); check other vaults by hand")
        return []
    return sorted({(i.get("vault") or {}).get("name", "?") for i in items
                   if i.get("title") == sb.TITLE and (i.get("vault") or {}).get("name") not in (vault, None)
                   and (i.get("vault") or {}).get("id") != vault})


def migrate(vault, delete, interactive, ask=input):
    sb.check_vault(vault)
    print(f"migrate: using the 1Password vault {vault!r}")
    if not os.path.exists(sb.LEGACY_KEY):
        print(f"migrate: there's no key on disk ({sb.LEGACY_KEY}); nothing to move")
        remote = sb.stored_key(vault)
        if remote is None:
            raise RuntimeError(f"and {vault!r} has no '{sb.TITLE}' either: publishing can't sign")
        if not sb.matches_certificate(remote):
            raise RuntimeError(f"the '{sb.TITLE}' in {vault!r} doesn't match the shipped certificate")
        print(f"migrate: '{sb.TITLE}' in {vault!r} matches the shipped certificate")
        return "nothing-to-do"
    with open(sb.LEGACY_KEY, "rb") as f:
        local = f.read()
    if not sb.matches_certificate(local):
        raise RuntimeError("the key on disk doesn't match the certificate Whimsy ships; not touching anything")
    remote = sb.stored_key(vault)
    for name in other_copies(vault):
        print(f"migrate: WARNING: the vault {name!r} also has a '{sb.TITLE}'. If that vault is shared, "
              f"delete that copy by hand (op document delete \"{sb.TITLE}\" --vault \"{name}\")")
    if not delete:
        if remote is None:
            print(f"migrate: {vault!r} has no copy yet; --delete-plaintext stores it there first")
        elif sb.sha(remote) == sb.sha(local):
            print(f"migrate: {vault!r} has an identical copy")
        else:
            print(f"migrate: {vault!r} has a DIFFERENT '{sb.TITLE}'; --delete-plaintext will refuse")
        print("migrate: checked only; nothing changed (pass --delete-plaintext to move the key)")
        return "checked"
    if not interactive:
        raise RuntimeError("--delete-plaintext only runs by hand, in a terminal")
    if remote is not None and sb.sha(remote) != sb.sha(local):
        raise RuntimeError(f"{vault!r} already has a different '{sb.TITLE}'; sort that out by hand first")
    if remote is None:
        sb.op("document", "create", sb.LEGACY_KEY, "--title", sb.TITLE, "--vault", vault, "--tags", "whimsy",
              "--file-name", "whimsy-private_key.pem")
        remote = sb.stored_key(vault)
        if remote is None or sb.sha(remote) != sb.sha(local):
            raise RuntimeError("1Password's copy doesn't read back identical; the key on disk is untouched")
        print(f"migrate: stored the key in {vault!r} and read it back")
    answer = ask(f"Type {CONFIRM!r} to overwrite and delete {sb.LEGACY_KEY}: ").strip()
    if answer != CONFIRM:
        print("migrate: not deleted")
        return "kept"
    sb.shred(sb.LEGACY_KEY)
    sb.shred(sb.LEGACY_MARKER)
    print(f"migrate: deleted the plaintext key. Signing now reads it from {vault!r} each time.")
    return "deleted"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--delete-plaintext", action="store_true",
                        help="store the key in 1Password if needed, then delete the copy on disk")
    parser.add_argument("--vault", help="the 1Password vault (default: signing_vault in whimsy/publish.json)")
    args = parser.parse_args(argv)
    try:
        vault = args.vault or sb.configured_vault()
        migrate(vault, args.delete_plaintext, sys.stdin.isatty() and sys.stdout.isatty())
    except Exception as e:
        print(f"migrate: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
