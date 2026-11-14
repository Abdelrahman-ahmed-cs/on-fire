"""Shared paths and constants for the pipeline. Raw data lives outside OneDrive."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Large data folder: the ONFIRE_DATA environment variable if set; else the team's
# C:\Users\User\onfire-data when it exists; else the project's own localdata folder
# (what setup.bat fills on a fresh PC).
_TEAM_DATA = Path(r"C:\Users\User\onfire-data")
DATA = Path(os.environ.get("ONFIRE_DATA") or (_TEAM_DATA if (_TEAM_DATA / "work").exists() else ROOT / "localdata"))
RAW = DATA / "firms"            # raw CSVs from scripts/download_firms.sh
PARQUET = DATA / "parquet"      # one Parquet file per raw CSV
WORK = DATA / "work"            # intermediate tables
OUT = ROOT / "pipeline" / "out"  # small results: metrics, JSON for the app (kept in repo)

# User rule: the territory is always called Palestine. Both FIRMS source names
# map to it; the other name must never reach any output.
COUNTRY_RENAME = {"Israel": "Palestine"}

REGIONS = {
    "North America": ["United States", "Canada", "Mexico"],
    "North Africa": ["Morocco", "Algeria", "Tunisia", "Libya", "Egypt", "Sudan", "Mauritania"],
    "Middle East": ["Saudi Arabia", "Yemen", "Oman", "United Arab Emirates", "Qatar", "Bahrain",
                    "Kuwait", "Iraq", "Iran", "Syria", "Jordan", "Lebanon", "Palestine", "Turkey",
                    "Cyprus"],
}

MODIS_MIN_CONF = 30          # MODIS confidence is 0-100
VIIRS_DROP_CONF = "l"        # VIIRS confidence is l / n / h
GRID = 0.25                  # degrees, analysis grid

for p in (PARQUET, WORK, OUT):
    p.mkdir(parents=True, exist_ok=True)
