#!/usr/bin/env bash
# storyboard.sh — post-render visual QA tool for rendered Manim videos.
#
# Three modes:
#
#   even      N evenly-spaced frames extracted to individual PNGs
#   grid      same N frames composited into a single tile image
#   scenes    scene-change detection (FFmpeg `select=gt(scene,N)`) —
#             captures transitions automatically; useful on Overview.mp4
#
# Uses input seeking (-ss before -i) for speed. Frames land under
#   media/storyboards/<basename>/
# with filenames encoding their source timestamp so the writer and the
# reader can correlate back to video time.
#
# Examples:
#
#   ./scripts/storyboard.sh media/videos/overview/1080p60/Overview.mp4
#   ./scripts/storyboard.sh media/videos/decay/480p15/Decay.mp4 --mode grid --count 12
#   ./scripts/storyboard.sh media/videos/overview/1080p60/Overview.mp4 --mode scenes
#   ./scripts/storyboard.sh <video> --times 0:05,0:30,1:15,1:50
#
# Intended use:
#
#   1. Render with manim.
#   2. Run this on the output video.
#   3. Read the PNGs (or single grid) to spot overlap / clipping /
#      pacing / cleanup issues WITHOUT watching the whole video.
#
# This is tier 4 of the VISUAL_QA.md gate.

set -euo pipefail

usage() {
  cat <<'EOF'
usage: storyboard.sh <video> [options]

  --mode MODE       even | grid | scenes | times   (default: even)
  --count N         N evenly-spaced frames         (default: 9)
  --times T1,T2,..  specific timestamps (mm:ss or s). Implies --mode times.
  --grid-cols COLS  columns in grid mode          (default: 3)
  --scene-thresh X  threshold 0-1 for scenes mode (default: 0.25)
  --out-dir DIR     where to write frames
  --width W         per-frame width in pixels     (default: 640)
  --label           overlay the source timestamp on each frame
  -h, --help        show this help

Output filenames encode timestamp:  frame_000530.png  = 5.30s into video.
EOF
}

if [[ $# -lt 1 ]]; then
  usage; exit 1
fi

VIDEO="$1"; shift
if [[ ! -f "$VIDEO" ]]; then
  echo "error: no such file: $VIDEO" >&2
  exit 1
fi

MODE="even"
COUNT=9
TIMES=""
GRID_COLS=3
# Default threshold calibrated for Manim's smooth fades (which produce
# scene_scores around 0.03-0.04 between transition frames). Sharp-cut
# content would want 0.25+.
SCENE_THRESH="0.03"
OUT_DIR=""
WIDTH=640
LABEL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)         MODE="$2"; shift 2 ;;
    --count)        COUNT="$2"; shift 2 ;;
    --times)        TIMES="$2"; MODE="times"; shift 2 ;;
    --grid-cols)    GRID_COLS="$2"; shift 2 ;;
    --scene-thresh) SCENE_THRESH="$2"; shift 2 ;;
    --out-dir)      OUT_DIR="$2"; shift 2 ;;
    --width)        WIDTH="$2"; shift 2 ;;
    --label)        LABEL=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *)              echo "unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

BASENAME="$(basename "$VIDEO" .mp4)"
if [[ -z "$OUT_DIR" ]]; then
  OUT_DIR="media/storyboards/$BASENAME"
fi
mkdir -p "$OUT_DIR"

# Duration in seconds (float).
DURATION=$(ffprobe -v error -show_entries format=duration \
  -of default=noprint_wrappers=1:nokey=1 "$VIDEO")
if [[ -z "$DURATION" ]]; then
  echo "error: could not probe duration" >&2
  exit 1
fi

# Helper — pad and format a timestamp for filenames: 5.30 -> 000530 (centiseconds).
fname_ts() {
  awk -v t="$1" 'BEGIN { printf "%06d", t * 100 }'
}

# Helper — human-readable label for overlay. Uses no colons because
# the drawtext filter argument parser treats `:` as an option
# separator and escaping is finicky across shells. `m / s` spells the
# same thing without needing escapes.
label_ts() {
  awk -v t="$1" '
    BEGIN {
      m = int(t / 60);
      s = t - m * 60;
      printf "%dm %05.2fs", m, s;
    }'
}

label_filter() {
  local t="$1"
  if [[ "$LABEL" -eq 0 ]]; then
    echo ""
    return
  fi
  local text
  text="$(label_ts "$t")"
  # Alpha=0.55 in the box colour — `@` inside drawtext does not need escaping.
  echo ",drawtext=text=${text}:fontcolor=white:fontsize=18:box=1:boxcolor=black@0.55:boxborderw=6:x=10:y=h-th-10"
}

extract_at() {
  local t="$1"
  local out="$2"
  local lbl
  lbl="$(label_filter "$t")"
  ffmpeg -hide_banner -loglevel error -y -ss "$t" -i "$VIDEO" \
    -frames:v 1 -vf "scale=${WIDTH}:-1${lbl}" -q:v 2 "$out"
}

case "$MODE" in
  even)
    echo "mode=even count=$COUNT duration=${DURATION}s"
    for i in $(seq 0 $((COUNT - 1))); do
      # Spread frames so the first and last aren't on black frames —
      # sample at (i + 0.5) / N through the video.
      t=$(awk -v i="$i" -v n="$COUNT" -v d="$DURATION" \
        'BEGIN { printf "%.3f", (i + 0.5) * d / n }')
      out="$OUT_DIR/frame_$(fname_ts "$t").png"
      extract_at "$t" "$out"
      echo "  $out"
    done
    ;;

  times)
    if [[ -z "$TIMES" ]]; then
      echo "error: --mode times needs --times T1,T2,..." >&2
      exit 1
    fi
    echo "mode=times times=$TIMES"
    IFS=',' read -ra TS_ARR <<< "$TIMES"
    for t in "${TS_ARR[@]}"; do
      # Convert mm:ss -> seconds if colon present.
      secs=$(awk -v t="$t" '
        BEGIN {
          if (index(t, ":") > 0) {
            n = split(t, parts, ":");
            if (n == 2) { printf "%.3f", parts[1] * 60 + parts[2] }
            else if (n == 3) { printf "%.3f", parts[1] * 3600 + parts[2] * 60 + parts[3] }
          } else { printf "%.3f", t }
        }')
      out="$OUT_DIR/frame_$(fname_ts "$secs").png"
      extract_at "$secs" "$out"
      echo "  $out"
    done
    ;;

  grid)
    # Build one composite image with COUNT tiles.
    rows=$(( (COUNT + GRID_COLS - 1) / GRID_COLS ))
    echo "mode=grid count=$COUNT cols=$GRID_COLS rows=$rows"
    # Two-pass: extract to tmp dir, then tile.
    tmpdir=$(mktemp -d)
    trap 'rm -rf "$tmpdir"' EXIT
    for i in $(seq 0 $((COUNT - 1))); do
      t=$(awk -v i="$i" -v n="$COUNT" -v d="$DURATION" \
        'BEGIN { printf "%.3f", (i + 0.5) * d / n }')
      lbl="$(label_filter "$t")"
      ffmpeg -hide_banner -loglevel error -y -ss "$t" -i "$VIDEO" \
        -frames:v 1 -vf "scale=${WIDTH}:-1${lbl}" -q:v 2 \
        "$tmpdir/f_$(printf '%02d' "$i").png"
    done
    out="$OUT_DIR/grid_${GRID_COLS}x${rows}.png"
    # `tile` filter needs a concat of frames as input. Easiest: use
    # a pattern + the tile filter on concat.
    ffmpeg -hide_banner -loglevel error -y -pattern_type glob \
      -i "$tmpdir/f_*.png" -vf "tile=${GRID_COLS}x${rows}:padding=6:color=0x1a1a1a" \
      -frames:v 1 -q:v 2 "$out"
    echo "  $out"
    ;;

  scenes)
    echo "mode=scenes threshold=$SCENE_THRESH"
    # Use scene-change select filter. Outputs a PNG per detected cut.
    # Manim scene transitions (our per-part fades) will register as
    # high-delta frames and get captured automatically.
    ffmpeg -hide_banner -loglevel error -y -i "$VIDEO" \
      -vf "select='gt(scene,${SCENE_THRESH})',scale=${WIDTH}:-1,showinfo" \
      -vsync vfr -q:v 2 "$OUT_DIR/scene_%03d.png" 2>&1 | tail -30
    ls "$OUT_DIR"/scene_*.png 2>/dev/null || echo "no scene cuts at threshold $SCENE_THRESH"
    ;;

  *)
    echo "unknown mode: $MODE" >&2
    exit 1
    ;;
esac

echo "done — open $OUT_DIR"
