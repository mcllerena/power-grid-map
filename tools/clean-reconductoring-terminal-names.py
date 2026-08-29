"""Clean SUB_1 and SUB_2 values in every reconductoring workbook sheet."""

from __future__ import annotations

import argparse
import csv
import re
from pathlib import Path
from typing import Any

import openpyxl

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_WORKBOOK = ROOT / "reference" / "us_reconductoring_projects.xlsx"
DEFAULT_SUBSTATIONS = ROOT / "geoinfo" / "us-data" / "Substations.csv"
TERMINAL_ALIASES = {
    "SCOVILLROCK": "SCOVILL ROCKS",
}
VOLTAGE_CODES = (69, 115, 138, 161, 230, 345, 500, 765)


def clean(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").replace("\n", " ")).strip()


def normalize(value: Any) -> str:
    return re.sub(r"[^A-Z0-9]", "", clean(value).upper())


def load_names(path: Path) -> list[str]:
    names = set()
    with path.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            name = clean(row.get("NAME"))
            if name:
                names.add(name)
    return sorted(names, key=lambda name: len(normalize(name)), reverse=True)


def build_name_index(names: list[str]) -> tuple[dict[str, str], dict[str, list[tuple[str, str]]]]:
    exact = {}
    prefixes: dict[str, list[tuple[str, str]]] = {}
    for name in names:
        token = normalize(name)
        exact[token] = name
        prefixes.setdefault(token[:4], []).append((token, name))
    return exact, prefixes


def resolve(value: Any, exact: dict[str, str], prefixes: dict[str, list[tuple[str, str]]]) -> str:
    original = clean(value)
    if re.fullmatch(r"(?:THE\s+)?(?:[A-Z]{2}\s*/\s*)?[A-Z]{2}\s+BORDER", original, flags=re.IGNORECASE):
        return "BORDER"
    # NYISO reliability records append the bus voltage to endpoint names, both
    # as "NAME 345.00" and as a compact suffix such as "NEWROCH345".
    voltage_pattern = "|".join(str(code) for code in VOLTAGE_CODES)
    original = re.sub(rf"\s+(?:{voltage_pattern})(?:\.\d+)?$", "", original, flags=re.IGNORECASE)
    original = re.sub(rf"(?:\s+|(?<=[A-Za-z_]))(?:{voltage_pattern})$", "", original, flags=re.IGNORECASE)
    # Workbook descriptions commonly append equipment details to the endpoint.
    candidate_text = re.split(
        r"\s+(?:and|including|with|for|from)\s+(?:associated|related|the|a|an)?\b|\s*[,;:/()-]\s*",
        original,
        maxsplit=1,
        flags=re.IGNORECASE,
    )[0]
    token = normalize(candidate_text)
    if not token:
        return original.upper()
    if token in TERMINAL_ALIASES:
        return TERMINAL_ALIASES[token]
    if token in exact:
        return exact[token].upper()
    matches = prefixes.get(token[:4], [])
    contained = [(candidate, name) for candidate, name in matches if len(candidate) >= 5 and candidate in token]
    if contained:
        return max(contained, key=lambda item: len(item[0]))[1].upper()
    # Descriptors can precede the terminal name, so inspect bounded phrases
    # without falling back to a full national scan.
    for phrase in re.findall(r"[A-Za-z0-9][A-Za-z0-9 .&'/-]{4,}", original):
        phrase_token = normalize(phrase)
        if phrase_token in exact:
            return exact[phrase_token].upper()
    return original.upper()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workbook", type=Path, default=DEFAULT_WORKBOOK)
    parser.add_argument("--substations", type=Path, default=DEFAULT_SUBSTATIONS)
    args = parser.parse_args()

    names = load_names(args.substations)
    exact, prefixes = build_name_index(names)
    workbook = openpyxl.load_workbook(args.workbook)
    changed = 0
    for sheet in workbook.worksheets:
        headers = {clean(cell.value): cell.column for cell in sheet[1]}
        if "SUB_1" not in headers or "SUB_2" not in headers:
            continue
        for row in sheet.iter_rows(min_row=2):
            for field in ("SUB_1", "SUB_2"):
                cell = row[headers[field] - 1]
                resolved = resolve(cell.value, exact, prefixes)
                if resolved != clean(cell.value):
                    cell.value = resolved
                    changed += 1
    workbook.save(args.workbook)
    print(f"Cleaned terminal cells: {changed}")
    print(f"Updated {args.workbook}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
