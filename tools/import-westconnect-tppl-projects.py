"""Import qualifying WestConnect transmission-line projects from the TPPL workbook."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "geoinfo" / "us-data" / "recond_gets_files_by_iso" / "WestConnect" / "02_10_26__wc_tppl_project_list_public.xlsm"
DESTINATION = ROOT / "reference" / "us_reconductoring_projects.xlsx"
SOURCE_ID = str(SOURCE.relative_to(ROOT))

CONDUCTOR_PATTERN = re.compile(r"\b(ACCC|ACCR|ACSS(?:/TW)?|ACSR(?:/TW)?|ACAR|AAC|AAAC)\b", re.IGNORECASE)
QUALIFYING_PATTERN = re.compile(
    r"rebuild|reconduct|re-conduct|upgrade|replace|replacement|re-rate|rerat|"
    r"reconductor|refurbish|uprate|maintenance",
    re.IGNORECASE,
)


def clean(value: Any) -> str:
    if pd.isna(value):
        return ""
    return re.sub(r"\s+", " ", str(value).replace("\n", " ")).strip()


def normalize(value: Any) -> str:
    return re.sub(r"[^A-Z0-9]", "", clean(value).upper())


def source_value(value: Any) -> Any:
    if pd.isna(value):
        return ""
    if isinstance(value, pd.Timestamp):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return clean(value)


def classify(text: str) -> str:
    lowered = text.lower()
    if re.search(r"reconduct|re-conduct|reconductor|conductor", lowered):
        return "Line Reconductoring"
    if re.search(r"rebuild|replace|replacement|refurbish", lowered):
        return "Transmission Line Rebuild / Replacement"
    if re.search(r"upgrade|uprate|re-rate|rerat", lowered):
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


def standardize(record: dict[str, Any], row_number: int) -> dict[str, Any]:
    cleaned = {str(key).strip(): source_value(value) for key, value in record.items()}
    project = clean(cleaned.get("ProjectName", ""))
    description = clean(cleaned.get("Description", ""))
    text = " ".join(str(value) for value in cleaned.values())
    origin = clean(cleaned.get("Origin", "")).upper()
    termination = clean(cleaned.get("Termination", "")).upper()
    row: dict[str, Any] = {
        "Project Name": project,
        "SUB_1": origin,
        "SUB_2": termination,
        "Voltage (kV)": cleaned.get("Voltage", ""),
        "ISO/RTO": "WestConnect",
        "Found On DB": False,
        "Utility": clean(cleaned.get("Sponsor", "")),
        "Conductor Type": conductor_type([str(value) for value in cleaned.values()]),
        "Status": clean(cleaned.get("Development", "")),
        "Description": description,
        "Source": SOURCE_ID,
        "Planned Year": clean(cleaned.get("InService", "")),
        "Primary Driver": clean(cleaned.get("Drivers", "")),
        "Asset Owner": clean(cleaned.get("Sponsor", "")),
        "Project Category": classify(text),
        "Source Owner Sheet": "All Projects",
        "Source Row": row_number,
        "Source Project": project,
    }
    for key, value in cleaned.items():
        row[f"Source - {key}"] = value
    return row


def main() -> None:
    source = pd.read_excel(SOURCE, sheet_name="All Projects", header=0).fillna("")
    searchable = source[["ProjectName", "Description", "Purpose", "Drivers"]].astype(str).agg(" ".join, axis=1)
    qualifying = source[
        source["FacilityType"].astype(str).str.fullmatch("Transmission Line", case=False, na=False)
        & searchable.str.contains(QUALIFYING_PATTERN)
        & source["ProjectName"].astype(str).str.strip().ne("")
    ].copy()

    book = pd.ExcelFile(DESTINATION)
    frames = {sheet: pd.read_excel(DESTINATION, sheet_name=sheet).fillna("") for sheet in book.sheet_names}
    westconnect = frames["WestConnect"]
    if "Source" not in westconnect.columns:
        westconnect["Source"] = ""
    westconnect = westconnect[westconnect["Source"].astype(str).ne(SOURCE_ID)].copy()

    additions = [standardize(record.to_dict(), int(index) + 2) for index, record in qualifying.iterrows()]
    existing = {normalize(value) for value in westconnect.get("Project Name", []) if clean(value)}
    unique: list[dict[str, Any]] = []
    for row in additions:
        key = normalize(row["Project Name"])
        if key not in existing:
            existing.add(key)
            unique.append(row)

    columns = list(westconnect.columns)
    for row in additions:
        for column in row:
            if column not in columns:
                columns.append(column)
    merged = pd.concat([westconnect, pd.DataFrame(unique)], ignore_index=True).reindex(columns=columns).fillna("")

    with pd.ExcelWriter(DESTINATION, engine="openpyxl") as writer:
        for sheet, frame in frames.items():
            (merged if sheet == "WestConnect" else frame).to_excel(writer, sheet_name=sheet, index=False)

    print(f"Qualifying transmission source rows: {len(additions)}")
    print(f"New WestConnect rows added: {len(unique)}")
    print(f"Rows with source endpoints: {sum(bool(row['SUB_1'] and row['SUB_2']) for row in unique)}")
    print(f"Rows with conductor type: {sum(bool(row['Conductor Type']) for row in unique)}")
    print(f"Final WestConnect rows: {len(merged)}")


if __name__ == "__main__":
    main()
