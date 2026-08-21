"""Generate map-ready GETS GeoJSON from the enriched workbook and main substation DB."""

from pathlib import Path
import json
import re
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
WORKBOOK = ROOT / "reference" / "us_gets_projects.xlsx"
SUBSTATIONS = ROOT / "geoinfo" / "us-data" / "Substations.csv"
MISO_REGION = ROOT / "webmap" / "data" / "reconductoring-us" / "miso.json"
OUTPUT_DIR = ROOT / "webmap" / "data" / "gets"

ISO_KEYS = {
    "CAISO": "caiso",
    "MISO": "miso",
    "SPP": "spp",
}
REGION_STATES = {
    "caiso": {"CA", "NV"},
    "miso": {"AR", "IL", "IN", "IA", "KY", "LA", "MI", "MN", "MO", "MS", "MT", "ND", "NE", "OH", "SD", "TN", "WI", "WY"},
    "spp": {"AR", "CO", "KS", "LA", "MN", "MO", "MT", "NE", "NM", "ND", "OK", "SD", "TX", "WY"},
}


def normalize(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def point_in_ring(point: list[float], ring: list[list[float]]) -> bool:
    x, y = point
    inside = False
    for index, (x2, y2) in enumerate(ring):
        x1, y1 = ring[index - 1]
        intersects = (y2 > y) != (y1 > y) and x < (x1 - x2) * (y - y2) / (y1 - y2) + x2
        if intersects:
            inside = not inside
    return inside


def point_in_polygon(point: list[float], coordinates: list[list[list[float]]]) -> bool:
    return point_in_ring(point, coordinates[0]) and not any(
        point_in_ring(point, hole) for hole in coordinates[1:]
    )


def point_in_geometry(point: list[float], geometry: dict) -> bool:
    if geometry.get("type") == "Polygon":
        return point_in_polygon(point, geometry["coordinates"])
    if geometry.get("type") == "MultiPolygon":
        return any(point_in_polygon(point, polygon) for polygon in geometry["coordinates"])
    return False


def load_miso_boundary() -> list[dict]:
    if not MISO_REGION.exists():
        return []
    payload = json.loads(MISO_REGION.read_text(encoding="utf-8"))
    return [feature["geometry"] for feature in payload.get("regionFeatures", [])]


def main() -> None:
    book = pd.ExcelFile(WORKBOOK)
    miso_boundary = load_miso_boundary()
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
        if iso_key == "miso" and miso_boundary:
            candidates = [
                candidate for candidate in candidates
                if any(point_in_geometry(candidate["coordinates"], geometry) for geometry in miso_boundary)
            ]
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
            if iso_key == "miso" and (coord_1 or coord_2):
                node_features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": coord_1 or coord_2}, "properties": properties})
            elif sub_1 and sub_2 and coord_1 and coord_2:
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
