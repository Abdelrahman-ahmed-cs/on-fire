#!/usr/bin/env bash
# Downloads FIRMS per-country yearly archive CSVs (no key needed).
# Resumable: skips files that already exist and are non-empty. Safe to re-run.
# Usage: bash scripts/download_firms.sh
set -u
OUT="/c/Users/User/onfire-data/firms"
BASE="https://firms.modaps.eosdis.nasa.gov/data/country"
UA="Mozilla/5.0"
COUNTRIES="United_States Canada Mexico Morocco Algeria Tunisia Libya Egypt Sudan Mauritania Saudi_Arabia Yemen Oman United_Arab_Emirates Qatar Bahrain Kuwait Iraq Iran Syria Jordan Lebanon Israel Palestine Turkey Cyprus"

fetch() { # sensor year country
  local dir="$OUT/$1" f="$1_$2_$3.csv"
  mkdir -p "$dir"
  if [ -s "$dir/$f" ]; then return 0; fi
  curl -sfL -m 900 --retry 3 --retry-delay 5 -A "$UA" "$BASE/$1/$2/$f" -o "$dir/$f.part" \
    && mv "$dir/$f.part" "$dir/$f" || { rm -f "$dir/$f.part"; echo "FAILED $f"; }
}

# Order matters on a slow connection: small countries first so the pipeline can
# be developed early; the three large North America countries go last.
SMALL="Algeria Turkey Morocco Tunisia Libya Egypt Jordan Lebanon Israel Palestine Cyprus Syria Kuwait Bahrain Qatar United_Arab_Emirates Oman Yemen Saudi_Arabia Mauritania Iraq Iran Sudan"
LARGE="Mexico United_States Canada"
for c in $SMALL $LARGE; do
  for y in $(seq 2000 2025); do fetch modis "$y" "$c"; done
  echo "done modis $c"
done
for c in $SMALL $LARGE; do
  for y in $(seq 2025 -1 2012); do fetch viirs-snpp "$y" "$c"; done
  echo "done viirs $c"
done

missing=0
for c in $COUNTRIES; do
  for y in $(seq 2000 2025); do [ -s "$OUT/modis/modis_${y}_$c.csv" ] || { missing=$((missing+1)); echo "missing modis $y $c"; }; done
  for y in $(seq 2012 2025); do [ -s "$OUT/viirs-snpp/viirs-snpp_${y}_$c.csv" ] || { missing=$((missing+1)); echo "missing viirs $y $c"; }; done
done
echo "MISSING: $missing"
du -sh "$OUT"
