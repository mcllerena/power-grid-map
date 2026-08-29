"""Import transmission projects from the SCE/CPUC CAISO review workbook."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "geoinfo" / "us-data" / "recond_gets_files_by_iso" / "CAISO" / "Copy of PUBLIC-SCE June 2025 Transmission Project Review Process Project Spreadsheet.xlsx"
DESTINATION = ROOT / "reference" / "us_reconductoring_projects.xlsx"
ENDPOINT_MAPPINGS = ROOT / "reference" / "caiso-inferred-endpoints.json"
SUBSTATIONS = ROOT / "geoinfo" / "us-data" / "Substations.csv"

TRANSMISSION_WHAT = "Project Description - What"
ACTION_COLUMNS = ("Project Description - Action Taken", "Project Description - Action Taken (2)")
CONDUCTOR_PATTERN = re.compile(r"\b(ACCC|ACCR|ACSS(?:/TW)?|ACSR(?:/TW)?|ACAR|AAC|AAAC)\b", re.IGNORECASE)


def clean(value: Any) -> str:
    if pd.isna(value):
        return ""
    return re.sub(r"\s+", " ", str(value).replace("\n", " ")).strip()


def normalize(value: Any) -> str:
    return re.sub(r"[^A-Z0-9]", "", clean(value).upper())


def project_key(value: Any) -> str:
    return normalize(value)


def source_value(value: Any) -> Any:
    if pd.isna(value):
        return ""
    if isinstance(value, pd.Timestamp):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return clean(value)


def load_substation_names() -> tuple[dict[str, str], list[tuple[str, str]]]:
    names: set[str] = set()
    with SUBSTATIONS.open(encoding="utf-8-sig") as handle:
        for line in handle:
            fields = line.rstrip("\n").split(",")
            if len(fields) > 5 and clean(fields[5]):
                names.add(clean(fields[5]))
    exact = {normalize(name): name.upper() for name in names}
    ordered = sorted(((normalize(name), name.upper()) for name in names), key=lambda item: len(item[0]), reverse=True)
    return exact, ordered


def resolve_name(value: str, exact: dict[str, str], ordered: list[tuple[str, str]]) -> str:
    token = normalize(value)
    if not token:
        return ""
    if token in exact:
        return exact[token]
    matches = [
        (candidate, display)
        for candidate, display in ordered
        if len(candidate) >= 5 and re.search(rf"(?<![A-Z0-9]){re.escape(candidate)}(?![A-Z0-9])", clean(value).upper().replace(" ", ""))
    ]
    return matches[0][1] if matches else clean(value).upper()


def load_endpoint_mappings() -> dict[str, dict[str, str]]:
    if not ENDPOINT_MAPPINGS.exists():
        return {}
    payload = json.loads(ENDPOINT_MAPPINGS.read_text(encoding="utf-8"))
    return payload if isinstance(payload, dict) else {}


def infer_endpoints(project: str, exact: dict[str, str], ordered: list[tuple[str, str]]) -> tuple[str, str]:
    text = re.sub(r"\s*\([^)]*\)", "", project)
    text = re.split(r"\s+[-:]\s+(?:replace|upgrade|install|remediation|repair|replacement|reconductor|rebuild|tower|line|project)\b", text, maxsplit=1, flags=re.IGNORECASE)[0]
    parts = re.split(r"\s*-\s*", text, maxsplit=1)
    if len(parts) != 2:
        return "", ""
    left = re.sub(r"\s+(?:No\.?\s*)?\d+$", "", parts[0], flags=re.IGNORECASE)
    right = re.sub(r"\s+(?:No\.?\s*)?\d+$", "", parts[1], flags=re.IGNORECASE)
    return resolve_name(left, exact, ordered), resolve_name(right, exact, ordered)


def classify(project: str, what: str, actions: str) -> str:
    text = f"{project} {what} {actions}".lower()
    if re.search(r"reconduct|re-conductor|conductor upgrade", text):
        return "Line Reconductoring"
    if re.search(r"\brebuild|replacement|replace|pole replacement|tower replacement", text):
        return "Transmission Line Rebuild / Replacement"
    if re.search(r"\bnew\b|interconnect|install", text):
        return "Transmission Line Build"
    if re.search(r"upgrade|rerat|rating increase|tlrr|remediation|repair|mitigation", text):
        return "Transmission Line Upgrade"
    return "Transmission Line Maintenance"


def conductor_type(values: list[str]) -> str:
    found: list[str] = []
    for value in values:
        for match in CONDUCTOR_PATTERN.findall(value):
            token = match.upper()
            if token not in found:
                found.append(token)
    return ", ".join(found)


def standardize(record: dict[str, Any], sheet: str, row_number: int, exact: dict[str, str], ordered: list[tuple[str, str]], mappings: dict[str, dict[str, str]]) -> dict[str, Any]:
    cleaned = {str(key).strip(): source_value(value) for key, value in record.items()}
    project = clean(cleaned.get("Project Name(s)", ""))
    all_text = [str(value) for value in cleaned.values()]
    what = clean(cleaned.get(TRANSMISSION_WHAT, ""))
    actions = " / ".join(clean(cleaned.get(column, "")) for column in ACTION_COLUMNS if clean(cleaned.get(column, "")))
    endpoints = mappings.get(project_key(project), {})
    sub_1 = clean(endpoints.get("SUB_1", "")).upper()
    sub_2 = clean(endpoints.get("SUB_2", "")).upper()
    if not sub_1 or not sub_2:
        sub_1, sub_2 = infer_endpoints(project, exact, ordered)

    row: dict[str, Any] = {
        "Project Name": project,
        "SUB_1": sub_1,
        "SUB_2": sub_2,
        "Utility": "SCE",
        "Voltage (kV)": cleaned.get("Transmission Voltage Level (kV)", ""),
        "Distance (mi)": cleaned.get("Transmission Project Size (length in miles)", ""),
        "Status": cleaned.get("Project Status", ""),
        "Planned Year": cleaned.get("Current Projected or Actual In-Service Date", ""),
        "Description": clean(cleaned.get("Project Description", "")),
        "ISO/RTO": "CAISO",
        "Found On DB": bool(sub_1 and sub_2),
        "Project Category": classify(project, what, actions),
        "Conductor Type": conductor_type(all_text),
        "Source Owner Sheet": sheet,
        "Source Row": row_number,
        "Source Project": project,
        "Source": str(SOURCE.relative_to(ROOT)),
    }
    for key, value in cleaned.items():
        row[f"Source - {key}"] = value
    return row


def main() -> None:
    source_book = pd.ExcelFile(SOURCE)
    source_sheet = source_book.sheet_names[0]
    source = pd.read_excel(SOURCE, sheet_name=source_sheet, header=2).fillna("")
    source = source[source[TRANSMISSION_WHAT].astype(str).str.startswith("Transmission Line")].copy()
    exact, ordered = load_substation_names()
    mappings = load_endpoint_mappings()

    current_book = pd.ExcelFile(DESTINATION)
    frames = {sheet: pd.read_excel(DESTINATION, sheet_name=sheet).fillna("") for sheet in current_book.sheet_names}
    caiso = frames["CAISO"]
    caiso = caiso[caiso.get("Source Owner Sheet", "").astype(str).ne(source_sheet)].copy()
    additions = [standardize(record.to_dict(), source_sheet, int(index) + 4, exact, ordered, mappings) for index, record in source.iterrows() if clean(record.get("Project Name(s)", ""))]

    existing = {project_key(value) for value in caiso.get("Project Name", []) if clean(value)}
    unique = []
    for row in additions:
        key = project_key(row["Project Name"])
        if key not in existing:
            existing.add(key)
            unique.append(row)

    columns = list(caiso.columns)
    for row in additions:
        for column in row:
            if column not in columns:
                columns.append(column)
    merged = pd.concat([caiso, pd.DataFrame(unique)], ignore_index=True).reindex(columns=columns).fillna("")

    with pd.ExcelWriter(DESTINATION, engine="openpyxl") as writer:
        for sheet, frame in frames.items():
            (merged if sheet == "CAISO" else frame).to_excel(writer, sheet_name=sheet, index=False)

    print(f"Source sheet: {source_sheet}")
    print(f"Transmission source rows: {len(additions)}")
    print(f"New CAISO rows added: {len(unique)}")
    print(f"Rows with endpoints: {sum(bool(row['SUB_1'] and row['SUB_2']) for row in unique)}")
    print(f"Rows with conductor type: {sum(bool(row['Conductor Type']) for row in unique)}")
    print(f"Final CAISO rows: {len(merged)}")


if __name__ == "__main__":
    main()
