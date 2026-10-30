#!/bin/sh
# Refresh the vendored DuckDuckGo Autoconsent (MPL-2.0) behind "Reject cookie
# banners". The work is in whimsy/autoconsent.py (curl from npm, sha512
# checked); the nightly updater runs it too.
# Usage: sh whimsy/update-autoconsent.sh [version]
#        python3 whimsy/autoconsent.py check
exec python3 "$(dirname "$0")/autoconsent.py" update "$@"
