# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# W26 passkeys: compiles the Secure Enclave helper (main.swift) with the
# system Swift toolchain, which mozbuild has no support for. Run by
# GENERATED_FILES (see ../moz.build): `output` is the binary to produce.

import os
import stat
import subprocess
import tempfile


def main(output, main_swift):
    build = tempfile.mkdtemp(prefix="whimsy-passkeys-")
    binary = os.path.join(build, "whimsy-passkeys")
    subprocess.run(
        [
            "xcrun",
            "swiftc",
            "-O",
            "-target",
            "arm64-apple-macos13.3",
            "-module-name",
            "whimsy_passkeys",
            "-o",
            binary,
            main_swift,
        ],
        check=True,
    )
    with open(binary, "rb") as f:
        data = f.read()
    # FileAvoidWrite keeps an existing file's mode and only rewrites changed
    # content, so write the executable first, then hand it the same bytes.
    with open(output.name, "wb") as f:
        f.write(data)
    os.chmod(output.name, stat.S_IRWXU | stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH)
    output.write(data)
    os.remove(binary)
    os.rmdir(build)
    return set()
