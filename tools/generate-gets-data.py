"""Generate map-ready GETS GeoJSON from the enriched workbook and main substation DB."""

from pathlib import Path
import json
import re
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
WORKBOOK = ROOT / "reference" / "us_gets_projects.xlsx"
SUBSTATIONS = ROOT / "geoinfo" / "us-data" / "Substations.csv"
OUTPUT_DIR = ROOT / "webmap" / "data" / "gets"

ISO_KEYS = {
    "CAISO": "caiso",
    "SPP": "spp",
}
REGION_STATES = {
    "caiso": {"CA", "NV"},
    "spp": {"AR", "CO", "KS", "LA", "MN", "MO", "MT", "NE", "NM", "ND", "OK", "SD", "TX", "WY"},
}


def normalize(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def main() -> None:
    book = pd.ExcelFile(WORKBOOK)
    substations = pd.read_csv(SUBSTATIONS, encoding="utf-8-sig", low_memory=False).fillna("")
    coordinates = {}
    for _, row in substations.iterrows():
        name = str(row.get("NAME", "")).strip()
        state = str(row.get("STATE", "")).strip().upper()
        try:
            lat = float(row.get("LATITUDE", ""))
            lon = float(row.get("LONGITUDE", ""))
        except (TypeError, ValueError):
            continue
        if name:
            coordinates.setdefault(normalize(name), []).append({
                "coordinates": [lon, lat],
                "state": state,
                "max_voltage": pd.to_numeric(row.get("MAX_VOLT", ""), errors="coerce"),
            })

    def get_coordinates(name: str, iso_key: str):
        candidates = coordinates.get(normalize(name), [])
        allowed_states = REGION_STATES.get(iso_key)
        if allowed_states:
            candidates = [candidate for candidate in candidates if candidate["state"] in allowed_states]
        if not candidates:
            return None
        preferred = max(candidates, key=lambda candidate: candidate["max_voltage"] if pd.notna(candidate["max_voltage"]) else -1)
        return preferred["coordinates"]

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for sheet_name in book.sheet_names:
        iso_key = ISO_KEYS.get(sheet_name)
        if not iso_key:
            continue
        projects = pd.read_excel(WORKBOOK, sheet_name=sheet_name).fillna("")
        line_features = []
        node_features = []
        unresolved = []
        for _, row in projects.iterrows():
            sub_1 = str(row.get("SUB_1", "")).strip()
            sub_2 = str(row.get("SUB_2", "")).strip()
            properties = {column: str(row.get(column, "")).strip() for column in projects.columns}
            properties.update({"SUB_1": sub_1, "SUB_2": sub_2, "iso_region": sheet_name})
            coord_1 = get_coordinates(sub_1, iso_key) if sub_1 else None
            coord_2 = get_coordinates(sub_2, iso_key) if sub_2 else None
            if sub_1 and sub_2 and coord_1 and coord_2:
                line_features.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": [coord_1, coord_2]}, "properties": properties})
            elif sub_1 and coord_1:
                node_features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": coord_1}, "properties": properties})
            else:
                unresolved.append(properties.get("Project Name", ""))

        payload = {
            "isoKey": iso_key,
            "label": sheet_name,
            "lineFeatures": line_features,
            "nodeFeatures": node_features,
            "summary": {
                "projectCount": len(projects),
                "lineProjectCount": len(line_features),
                "nodeProjectCount": len(node_features),
                "unresolvedProjectCount": len(unresolved),
                "unresolvedProjects": unresolved,
            },
        }
        output = OUTPUT_DIR / f"{iso_key}.json"
        output.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        print(f"wrote {output}")
        print(payload["summary"])


if __name__ == "__main__":
    main()
