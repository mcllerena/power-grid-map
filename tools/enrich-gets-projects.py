"""Add main-database endpoint columns to the GETS workbook."""

from pathlib import Path
import re
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
WORKBOOK = ROOT / "reference" / "us_gets_projects.xlsx"

ENDPOINTS = {
    "series reactor on warnerville-wilson 230 kv": ("WARNERVILLE", "WILSON"),
    "series compensation on eldorado-lugo-mohave": ("ELDORADO", "MOHAVE"),
    "imperial valley phase shifters": ("IMPERIAL VALLEY", ""),
    "wilson 115 kv svc/statcom": ("WILSON", ""),
    "san jose-trible 115 kv series reactors": ("SAN JOSE STA. B", "TRIMBLE"),
    "vaca dixon-lakeville 230 kv corridor series compensation": ("VACA-DIXON", "LAKEVILLE"),
    "series compensation on los esteros-nortech 115 kv line": ("LOS ESTEROS", "NORTECH"),
    "san jose hvdc project - metcalf-san jose b": ("METCALF 2", "SAN JOSE STA. B"),
    "lone tree cayetano newark corridor series compensation": ("LONE TREE", "NEWARK"),
    "humboldt phase shifting transformer (part of new humboldt 500 kv substation with 500 kv line to collinsville)": ("", ""),
    "rio oso svc": ("RIO OSO", ""),
    "svc at suncrest": ("SUNCREST", ""),
    "synchronous condensers in la/san diego area (loss of songs)": ("", ""),
    "round mountain 500 kv dynamic voltage support (fern road substation)": ("ROUND MOUNTAIN", ""),
    "gates 500 kv dynamic voltage support (orchard substation)": ("", ""),
}


def normalize(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").strip().lower())


def main() -> None:
    book = pd.ExcelFile(WORKBOOK)
    endpoint_map = {normalize(project): pair for project, pair in ENDPOINTS.items()}
    frames = {
        sheet: pd.read_excel(WORKBOOK, sheet_name=sheet).fillna("")
        for sheet in book.sheet_names
    }
    for sheet, frame in frames.items():
        endpoints = frame["Project Name"].map(lambda value: endpoint_map.get(normalize(value), ("", "")))
        frame["SUB_1"] = endpoints.map(lambda pair: pair[0])
        frame["SUB_2"] = endpoints.map(lambda pair: pair[1])
        frames[sheet] = frame

    with pd.ExcelWriter(WORKBOOK, engine="openpyxl") as writer:
        for sheet, frame in frames.items():
            frame.to_excel(writer, sheet_name=sheet, index=False)

    print(f"Updated {WORKBOOK}")
    for sheet, frame in frames.items():
        paired = frame["SUB_1"].astype(str).str.strip().ne("") & frame["SUB_2"].astype(str).str.strip().ne("")
        nodes = frame["SUB_1"].astype(str).str.strip().ne("") & frame["SUB_2"].astype(str).str.strip().eq("")
        print(f"{sheet}: {len(frame)} rows, {paired.sum()} line pairs, {nodes.sum()} single nodes")


if __name__ == "__main__":
    main()
