# Sourced by the scripts that write a demo tour's snapshots to a folder.
#
# prepare_tour_output DIR empties DIR for a new tour, but only when it is
# new, empty, or holds nothing but an earlier tour's output (NN-name.png
# snapshots and the `done` marker), so a mistyped DIR like ~/Desktop is
# refused instead of deleted.
prepare_tour_output() {
  local dir="$1" entry
  if [ -d "$dir" ]; then
    for entry in "$dir"/* "$dir"/.[!.]*; do
      [ -e "$entry" ] || continue
      case "$(basename "$entry")" in
        [0-9][0-9]-*.png | done | .DS_Store) ;;
        *)
          echo "error: $dir has files that aren't from a tour; pass a new or empty folder" >&2
          exit 1
          ;;
      esac
    done
  elif [ -e "$dir" ]; then
    echo "error: $dir isn't a folder" >&2
    exit 1
  fi
  rm -rf "$dir"
  mkdir -p "$dir"
}
