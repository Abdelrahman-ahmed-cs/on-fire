"""Step 1.1 — raw FIRMS CSVs -> Parquet, one schema for both sensors.

Incremental: a CSV is skipped if its Parquet already exists. Safe to re-run while
the download is still going (files ending in .part are ignored).

Output schema (one row per detection):
  lat, lon, date, hhmm, sensor (MODIS|VIIRS), sat (Terra|Aqua|SNPP), conf (0-100 for
  MODIS; 15/50/90 for VIIRS l/n/h), frp, daynight (D|N), type (0 fire, 1 volcano,
  2 static land source, 3 offshore), country, year, month
Quality filter is NOT applied here (kept so later steps can choose); column `ok`
marks rows passing it (MODIS conf >= 30, VIIRS not 'l').

Run: venv python pipeline/01_ingest.py
"""
import re
import sys
import duckdb
from config import RAW, PARQUET, COUNTRY_RENAME, MODIS_MIN_CONF

con = duckdb.connect()
done = skipped = 0
for sensor_dir, sensor in (("modis", "MODIS"), ("viirs-snpp", "VIIRS")):
    src_dir = RAW / sensor_dir
    if not src_dir.exists():
        continue
    out_dir = PARQUET / sensor_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    for csv in sorted(src_dir.glob("*.csv")):
        m = re.match(rf"{sensor_dir}_(\d{{4}})_(.+)\.csv$", csv.name)
        if not m:
            continue
        year, raw_country = int(m.group(1)), m.group(2).replace("_", " ")
        country = COUNTRY_RENAME.get(raw_country, raw_country)
        # Output file is named by the SOURCE name so the two merged sources do not
        # overwrite each other; the `country` column carries the display name.
        out = out_dir / f"{sensor_dir}_{year}_{m.group(2)}.parquet"
        if out.exists():
            skipped += 1
            continue
        if sensor == "MODIS":
            conf = "CAST(confidence AS INTEGER)"
            ok = f"CAST(confidence AS INTEGER) >= {MODIS_MIN_CONF}"
            sat = "satellite"
        else:
            conf = "CASE confidence WHEN 'l' THEN 15 WHEN 'n' THEN 50 ELSE 90 END"
            ok = "confidence <> 'l'"
            sat = "'SNPP'"
        tmp = out.with_suffix(".tmp")
        con.execute(f"""
            COPY (
              SELECT CAST(latitude AS DOUBLE) AS lat, CAST(longitude AS DOUBLE) AS lon,
                     CAST(acq_date AS DATE) AS date,
                     CAST(acq_time AS INTEGER) AS hhmm,
                     '{sensor}' AS sensor, {sat} AS sat,
                     {conf} AS conf, CAST(frp AS DOUBLE) AS frp,
                     daynight, CAST(type AS INTEGER) AS type,
                     '{country.replace("'", "''")}' AS country,
                     {year} AS year, month(CAST(acq_date AS DATE)) AS month,
                     ({ok}) AS ok
              FROM read_csv('{csv.as_posix()}', header=true, all_varchar=true)
            ) TO '{tmp.as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD)
        """)
        tmp.rename(out)
        done += 1

print(f"ingested {done} new files, skipped {skipped} existing")
n = con.execute(f"SELECT sensor, count(*) n, count(DISTINCT country) c, min(year), max(year) "
                f"FROM read_parquet('{PARQUET.as_posix()}/*/*.parquet') GROUP BY 1").fetchall()
for row in n:
    print(row)
bad = con.execute(f"SELECT count(*) FROM read_parquet('{PARQUET.as_posix()}/*/*.parquet') "
                  f"WHERE country ILIKE '%israel%'").fetchone()[0]
print("rows with forbidden country name:", bad)
sys.exit(1 if bad else 0)
