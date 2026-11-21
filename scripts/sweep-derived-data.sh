#!/bin/bash
# Delete Xcode DerivedData folders whose source workspace no longer exists.
# `eas build --local` builds in a fresh temp dir each time, so each run leaves
# a ~2GB orphan that Xcode can never reuse. Folders for live paths are kept.
# Usage: sweep-derived-data.sh [--dry-run]
DD="$HOME/Library/Developer/Xcode/DerivedData"
dry=0; [ "$1" = "--dry-run" ] && dry=1
for d in "$DD"/*-*/; do
  d=${d%/}
  wp=$(/usr/libexec/PlistBuddy -c "Print :WorkspacePath" "$d/info.plist" 2>/dev/null) || continue
  [ -z "$wp" ] && continue
  [ -e "$wp" ] && continue
  if [ $dry = 1 ]; then echo "would delete $(du -sh "$d" | cut -f1) $d"; else rm -rf "$d"; fi
done
