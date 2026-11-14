"""Country boundaries for the map -> OUT/countries.geojson

Source: Natural Earth 50m admin-0 (public domain), downloaded to
WORK/ne_50m_countries.geojson. Only our project countries keep a name; every
other country is kept as an unnamed outline for context.

User rule: the two source polygons for the territory are merged into ONE feature
named Palestine. No other property from the source is copied, so the other name
cannot leak into the app.

Run: venv python pipeline/06_boundaries.py
"""
import json
from shapely.geometry import shape, mapping
from shapely.ops import unary_union
from config import WORK, OUT, REGIONS

SRC_TO_OURS = {"United States of America": "United States", "Israel": "Palestine", "Palestine": "Palestine",
               "Turkey": "Turkey", "Türkiye": "Turkey", "N. Cyprus": "Cyprus", "Northern Cyprus": "Cyprus"}
region_of = {c: r for r, cs in REGIONS.items() for c in cs}

src = json.loads((WORK / "ne_50m_countries.geojson").read_text(encoding="utf-8"))
geoms, others = {}, []
for f in src["features"]:
    p = f["properties"]
    raw = p.get("ADMIN") or p.get("NAME")
    name = SRC_TO_OURS.get(raw, SRC_TO_OURS.get(p.get("NAME"), raw))
    g = shape(f["geometry"])
    if name in region_of:
        geoms.setdefault(name, []).append(g)
    else:
        others.append(g)

features = []
for name, gs in sorted(geoms.items()):
    g = unary_union(gs).simplify(0.02, preserve_topology=True)
    c = g.representative_point()
    features.append({"type": "Feature", "geometry": mapping(g),
                     "properties": {"name": name, "region": region_of[name],
                                    "label_lon": round(c.x, 3), "label_lat": round(c.y, 3)}})
for g in others:
    features.append({"type": "Feature", "geometry": mapping(g.simplify(0.05, preserve_topology=True)),
                     "properties": {"name": "", "region": ""}})

text = json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":"))
assert "srael" not in text, "forbidden name leaked into countries.geojson"
(OUT / "countries.geojson").write_text(text, encoding="utf-8")
missing = sorted(set(region_of) - set(geoms))
print("named countries:", len(geoms), "| missing:", missing, "| size KB:", len(text) // 1024)
