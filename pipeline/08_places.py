"""Settlements for the "who is near this fire" panel -> WORK/places.parquet

Source: GeoNames cities500 (every place with 500+ people, so villages are
included; CC BY 4.0), downloaded
fresh from geonames.org into WORK/geonames/ (its own folder; it is an archive
from the internet, so it is only read as text, never executed).

User rule: inside the territory labelled Palestine no place names are shown. Both
source country codes for it are mapped to Palestine and their names are blanked;
those places still count toward population exposure.

Each place gets a size class: city (100,000+), town (5,000+), village (500+).

Run: venv python -I pipeline/08_places.py   (needs WORK/geonames/cities500.txt)
"""
import sys
from pathlib import Path
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import WORK  # noqa: E402

ISO = {"US": "United States", "CA": "Canada", "MX": "Mexico", "MA": "Morocco", "DZ": "Algeria", "TN": "Tunisia",
       "LY": "Libya", "EG": "Egypt", "SD": "Sudan", "MR": "Mauritania", "SA": "Saudi Arabia", "YE": "Yemen",
       "OM": "Oman", "AE": "United Arab Emirates", "QA": "Qatar", "BH": "Bahrain", "KW": "Kuwait", "IQ": "Iraq",
       "IR": "Iran", "SY": "Syria", "JO": "Jordan", "LB": "Lebanon", "IL": "Palestine", "PS": "Palestine",
       "TR": "Turkey", "CY": "Cyprus"}
NO_NAMES = {"IL", "PS"}

d = pd.read_csv(WORK / "geonames" / "cities500.txt", sep="\t", header=None, quoting=3, dtype=str,
                usecols=[2, 4, 5, 8, 14], names=["name", "lat", "lon", "cc", "pop"], keep_default_na=False)
d = d[d.cc.isin(ISO)].copy()
d["country"] = d.cc.map(ISO)
d.loc[d.cc.isin(NO_NAMES), "name"] = ""
# naming rule, strict: any place name anywhere that contains the forbidden string is blanked too
# (cities500 has e.g. one in Mexico and one in Canada). The place still counts for exposure.
d.loc[d.name.str.contains("srael", case=False), "name"] = ""
d["lat"] = d.lat.astype(float); d["lon"] = d.lon.astype(float); d["pop"] = d["pop"].astype(int)
d = d[d["pop"] > 0].copy()
d["kind"] = pd.cut(d["pop"], [0, 4999, 99999, 10**9], labels=["village", "town", "city"]).astype(str)
d = d[["name", "kind", "country", "lat", "lon", "pop"]].reset_index(drop=True)
assert not d.name.str.contains("srael", case=False).any(), "forbidden name in place names"
assert (d[d.country == "Palestine"].name == "").all()
d.to_parquet(WORK / "places.parquet", index=False)
print("places:", len(d), "| by kind:", d.kind.value_counts().to_dict(), "| countries:", d.country.nunique(), "| unnamed (Palestine):", int((d.name == "").sum()))
