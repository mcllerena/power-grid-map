"""Update the CAISO GETS record for the Eldorado-Lugo-Mohave project."""

from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
WORKBOOK = ROOT / "reference" / "us_gets_projects.xlsx"
PROJECT_NAME = "Series compensation on Eldorado-Lugo-Mohave"

PROJECT_FIELDS = {
    "Utility": "Southern California Edison (SCE)",
    "Status": "Approved; construction started Q4 2020; expected in service Q2 2024",
    "Neighboring Communities": (
        "San Bernardino, California; Clark County, Nevada, including Searchlight and Laughlin; "
        "Boulder City, Nevada; and Hesperia, California."
    ),
    "Description": (
        "Increase capacity on existing transmission lines by installing series capacitors, allowing additional "
        "renewable energy to flow from Nevada to Southern California. The project modifies the existing Eldorado, "
        "Lugo, and Mohave substations; installs capacitors on existing transmission lines; raises selected tower "
        "heights for ground clearance; installs communication wire; and adds cathodic protection and grounding "
        "where needed for induced AC effects on nearby gas pipelines."
    ),
    "Project Timeline": (
        "Planning and outreach began Q3 2016; PTC application Q2 2018; amended CPCN application Q2 2019; "
        "CPUC Final Decision and approval Q3 2020; construction began Q4 2020; expected operational Q2 2024."
    ),
    "CPUC Status": "CPUC approved and issued a Certificate of Public Convenience and Necessity on August 27, 2020.",
    "Contact Information": (
        "Project Information Line: 1-866-602-3782. SCE Project Manager Selya Arce: Selya.Arce@sce.com."
    ),
    "Maps & Resources": (
        "Notice of Construction: https://www.sce.com/sites/default/files/inline-files/Eldorado-Lugo-MohaveNoticeofConstruction.pdf; "
        "Fact Sheet: https://www.sce.com/sites/default/files/inline-files/093016_EldoradoLugoMohaveNewsletter.pdf; "
        "Project Map: https://www.sce.com/sites/default/files/inline-files/ELM_Map.pdf"
    ),
    "Source": "SCE Eldorado-Lugo-Mohave project page (provided project information)",
}


def main() -> None:
    book = pd.ExcelFile(WORKBOOK)
    frames = {
        sheet: pd.read_excel(WORKBOOK, sheet_name=sheet).fillna("")
        for sheet in book.sheet_names
    }
    caiso = frames["CAISO"]
    mask = caiso["Project Name"].astype(str).eq(PROJECT_NAME)
    if not mask.any():
        raise SystemExit(f"Project not found: {PROJECT_NAME}")
    for column, value in PROJECT_FIELDS.items():
        if column not in caiso.columns:
            caiso[column] = ""
        caiso.loc[mask, column] = value
    frames["CAISO"] = caiso

    with pd.ExcelWriter(WORKBOOK, engine="openpyxl") as writer:
        for sheet, frame in frames.items():
            frame.to_excel(writer, sheet_name=sheet, index=False)

    print(f"Updated {PROJECT_NAME}")


if __name__ == "__main__":
    main()