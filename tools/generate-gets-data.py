"""Generate map-ready GETS GeoJSON from the enriched workbook and main substation DB."""

from pathlib import Path
import json
import re
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
WORKBOOK = ROOT / "reference" / "us_gets_projects.xlsx"
SUBSTATIONS = ROOT / "geoinfo" / "us-data" / "Substations.csv"
OUTPUT = ROOT / "webmap" / "data" / "gets" / "caiso.json"


def normalize(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def main() -> None:
    projects = pd.read_excel(WORKBOOK, sheet_name="CAISO").fillna("")
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

    def get_caiso_coordinates(name: str):
        candidates = coordinates.get(normalize(name), [])
        caiso_candidates = [candidate for candidate in candidates if candidate["state"] in {"CA", "NV"}]
        if not caiso_candidates:
            return None
        preferred = max(caiso_candidates, key=lambda candidate: candidate["max_voltage"] if pd.notna(candidate["max_voltage"]) else -1)
        return preferred["coordinates"]

    line_features = []
    node_features = []
    unresolved = []
    for _, row in projects.iterrows():
        sub_1 = str(row.get("SUB_1", "")).strip()
        sub_2 = str(row.get("SUB_2", "")).strip()
        properties = {
            "Project Name": str(row.get("Project Name", "")).strip(),
            "Type": str(row.get("Type", "")).strip(),
            "TP Approved": str(row.get("TP Approved", "")).strip(),
            "In service Date (planned or achieved)": str(row.get("In service Date\n(planned or\nachieved)", "")).strip(),
            "SUB_1": sub_1,
            "SUB_2": sub_2,
            "iso_region": "CAISO",
        }
        for column in projects.columns:
            if column not in properties:
                properties[column] = str(row.get(column, "")).strip()
        coord_1 = get_caiso_coordinates(sub_1) if sub_1 else None
        coord_2 = get_caiso_coordinates(sub_2) if sub_2 else None
        if sub_1 and sub_2 and coord_1 and coord_2:
            line_features.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": [coord_1, coord_2]}, "properties": properties})
        elif sub_1 and coord_1:
            node_features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": coord_1}, "properties": properties})
        else:
            unresolved.append(properties["Project Name"])

    payload = {
        "isoKey": "caiso",
        "label": "CAISO",
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
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUTPUT}")
    print(payload["summary"])


if __name__ == "__main__":
    main()
