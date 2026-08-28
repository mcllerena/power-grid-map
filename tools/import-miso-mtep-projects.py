"""Import in-service MTEP MISO projects into the project workbooks."""

import re
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path.home() / "Downloads" / "MTEP In Service Projects106330.xlsx"
RECONDUCTORING_WORKBOOK = ROOT / "reference" / "us_reconductoring_projects.xlsx"
GETS_WORKBOOK = ROOT / "reference" / "us_gets_projects.xlsx"
SUBSTATIONS = ROOT / "geoinfo" / "us-data" / "Substations.csv"

RECONDUCTORING_PATTERN = re.compile(
    r"\breconduct\w*\b|\bconductor\w*\b|"
    r"\b(?:line|corridor|circuit)\b.*\b(?:rebuild|upgrade|replace|reconduct)\w*\b|"
    r"\b(?:rebuild|upgrade|replace|reconduct)\w*\b.*\b(?:line|corridor|circuit)\b",
    re.IGNORECASE,
)
GETS_PATTERN = re.compile(
    r"\bgets\b|series compens\w*|series reactor\w*|dynamic voltage|"
    r"\bstatcom\b|\bsvc\b|phase[- ]shifting|voltage support|voltage control|"
    r"\bcondenser\w*\b|\bcapacitor\w*\b|\breactive\b|\breactor\w*\b",
    re.IGNORECASE,
)
RETIREMENT_PATTERN = re.compile(r"\bretirements?\b", re.IGNORECASE)
GENERIC_SUBSTATION_NAMES = {
    "station", "substation", "north", "south", "east", "west", "central",
    "new", "old", "unknown", "junction", "jct", "area", "line", "circuit",
}

RECON_COLUMNS = [
    "Project Name", "SUB_1", "SUB_2", "Project Type", "Voltage (kV)",
    "ISO/RTO", "Utility", "Distance (mi)", "Rating", "Cost ($ M)",
    "Status", "Planned Year", "Description", "Found On DB", "Conductor Type",
    "Source", "EPRI Case URL", "MTEP Project ID", "MTEP Project Type",
    "MTEP Other Type", "MTEP Planning Region", "MTEP Board Approved Date",
]
GETS_COLUMNS = [
    "Project Name", "Type", "TP Approved", "In service Date\n(planned or\nachieved)",
    "SUB_1", "SUB_2", "Utility", "Status", "Neighboring Communities",
    "Description", "Project Timeline", "CPUC Status", "Contact Information",
    "Maps & Resources", "Source", "MTEP Project ID", "MTEP Project Type",
    "MTEP Other Type", "MTEP Planning Region", "MTEP Board Approved Date",
]


def clean(value: object) -> str:
    if value is None or pd.isna(value):
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def normalized(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", "", clean(value).lower())


def project_id(value: object) -> str:
    value = clean(value)
    if re.fullmatch(r"\d+\.0", value):
        return value[:-2]
    return value


def load_substation_aliases() -> list[tuple[str, str]]:
    substations = pd.read_csv(SUBSTATIONS, encoding="utf-8-sig", low_memory=False).fillna("")
    aliases = {}
    for _, row in substations.iterrows():
        name = clean(row.get("NAME"))
        alias = normalized(name)
        if len(alias) < 5 or alias in GENERIC_SUBSTATION_NAMES:
            continue
        aliases.setdefault(alias, name)
    return sorted(aliases.items(), key=lambda item: len(item[0]), reverse=True)


def find_endpoints(text: str, aliases: list[tuple[str, str]]) -> tuple[str, str]:
    compact = normalized(text)
    matches = []
    for alias, name in aliases:
        start = compact.find(alias)
        if start >= 0:
            matches.append((start, -len(alias), name))
    matches.sort()
    selected = []
    seen = set()
    for _, _, name in matches:
        key = normalized(name)
        if key in seen:
            continue
        seen.add(key)
        selected.append(name)
        if len(selected) == 2:
            break
    return (selected + ["", ""])[:2]


def read_mtep() -> pd.DataFrame:
    frame = pd.read_excel(SOURCE, sheet_name="Sheet1", skiprows=1).fillna("")
    for column in frame.columns:
        frame[column] = frame[column].map(clean)
    return frame


def source_text(row: pd.Series) -> str:
    return " | ".join(clean(row.get(column)) for column in (
        "Project Name", "Project Description", "Project Type", "Other Type"
    ))


def classify(frame: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    texts = frame.apply(source_text, axis=1)
    active_mask = ~texts.map(lambda value: bool(RETIREMENT_PATTERN.search(value)))
    recon_mask = texts.map(lambda value: bool(RECONDUCTORING_PATTERN.search(value)))
    recon_mask &= active_mask
    gets_mask = texts.map(lambda value: bool(GETS_PATTERN.search(value))) & ~recon_mask & active_mask
    return frame.loc[recon_mask].copy(), frame.loc[gets_mask].copy()


def date_text(value: object) -> str:
    if not value:
        return ""
    parsed = pd.to_datetime(value, errors="coerce")
    if pd.notna(parsed):
        return parsed.strftime("%Y-%m-%d")
    return clean(value)


def build_recon_rows(frame: pd.DataFrame, aliases: list[tuple[str, str]]) -> pd.DataFrame:
    rows = []
    for _, source in frame.iterrows():
        project_name = clean(source.get("Project Name"))
        sub_1, sub_2 = find_endpoints(project_name, aliases)
        if not sub_1:
            sub_1, sub_2 = find_endpoints(source_text(source), aliases)
        rows.append({
            "Project Name": project_name,
            "SUB_1": sub_1,
            "SUB_2": sub_2,
            "Project Type": "MTEP in-service reconductoring / line upgrade",
            "ISO/RTO": "MISO",
            "Utility": clean(source.get("Submitting TO")),
            "Status": clean(source.get("Planning Status")),
            "Description": clean(source.get("Project Description")),
            "Source": SOURCE.name,
            "MTEP Project ID": clean(source.get("MTEP Project ID")),
            "MTEP Project Type": clean(source.get("Project Type")),
            "MTEP Other Type": clean(source.get("Other Type")),
            "MTEP Planning Region": clean(source.get("Planning Region")),
            "MTEP Board Approved Date": date_text(source.get("Board Approved Date")),
        })
    return pd.DataFrame(rows, columns=RECON_COLUMNS)


def build_gets_rows(frame: pd.DataFrame, aliases: list[tuple[str, str]]) -> pd.DataFrame:
    rows = []
    for _, source in frame.iterrows():
        project_name = clean(source.get("Project Name"))
        sub_1, sub_2 = find_endpoints(project_name, aliases)
        if not sub_1:
            sub_1, sub_2 = find_endpoints(source_text(source), aliases)
        rows.append({
            "Project Name": project_name,
            "Type": "MTEP in-service GETS / voltage support",
            "In service Date\n(planned or\nachieved)": date_text(source.get("Board Approved Date")),
            "SUB_1": sub_1,
            "SUB_2": sub_2,
            "Utility": clean(source.get("Submitting TO")),
            "Status": clean(source.get("Planning Status")),
            "Description": clean(source.get("Project Description")),
            "Source": SOURCE.name,
            "MTEP Project ID": clean(source.get("MTEP Project ID")),
            "MTEP Project Type": clean(source.get("Project Type")),
            "MTEP Other Type": clean(source.get("Other Type")),
            "MTEP Planning Region": clean(source.get("Planning Region")),
            "MTEP Board Approved Date": date_text(source.get("Board Approved Date")),
        })
    return pd.DataFrame(rows, columns=GETS_COLUMNS)


def append_sheet(path: Path, sheet: str, additions: pd.DataFrame, columns: list[str]) -> int:
    book = pd.ExcelFile(path)
    frames = {name: pd.read_excel(path, sheet_name=name).fillna("") for name in book.sheet_names}
    existing = frames.get(sheet, pd.DataFrame(columns=columns))
    for column in columns:
        if column not in existing.columns:
            existing[column] = ""
    existing = existing.reindex(columns=columns)
    existing_text = existing.fillna("").astype(str).agg(" | ".join, axis=1)
    imported_mask = existing.get("Source", pd.Series(index=existing.index, dtype=str)).map(clean).eq(SOURCE.name)
    existing = existing.loc[~(imported_mask & existing_text.map(lambda value: bool(RETIREMENT_PATTERN.search(value))))].copy()
    existing_ids = existing["MTEP Project ID"].map(project_id)
    imported_mask = existing.get("Source", pd.Series(index=existing.index, dtype=str)).map(clean).eq(SOURCE.name)
    duplicate_imports = imported_mask & existing_ids.ne("") & existing_ids.duplicated(keep="first")
    existing = existing.loc[~duplicate_imports].copy()
    known_ids = set(existing["MTEP Project ID"].map(project_id))
    additions = additions.loc[~additions["MTEP Project ID"].map(project_id).isin(known_ids)].copy()
    additions = additions.loc[~additions["MTEP Project ID"].map(project_id).duplicated(keep="first")].copy()
    frames[sheet] = pd.concat([existing, additions.reindex(columns=columns)], ignore_index=True)
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        for name, frame in frames.items():
            frame.to_excel(writer, sheet_name=name, index=False)
    return len(additions)


def main() -> None:
    if not SOURCE.exists():
        raise FileNotFoundError(SOURCE)
    mtep = read_mtep()
    recon, gets = classify(mtep)
    aliases = load_substation_aliases()
    recon_added = append_sheet(RECONDUCTORING_WORKBOOK, "MISO", build_recon_rows(recon, aliases), RECON_COLUMNS)
    gets_added = append_sheet(GETS_WORKBOOK, "MISO", build_gets_rows(gets, aliases), GETS_COLUMNS)
    print(f"MTEP rows: {len(mtep)}")
    print(f"Reconductoring/upgrade candidates: {len(recon)}, appended: {recon_added}")
    print(f"GETS/voltage-support candidates: {len(gets)}, appended: {gets_added}")


if __name__ == "__main__":
    main()
