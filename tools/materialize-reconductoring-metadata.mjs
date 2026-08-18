import fs from "node:fs/promises";

const metadataByIso = {
  pjm: {
    "JEFFERSON||LICK": {
      "Project Name": "LICK - JEFFERSON 69 kV reconductoring project",
      "Voltage (kV)": "69",
    },
    "CHESTERFIELD||TYLER": {
      "Project Name": "Chesterfield - Tyler 230 kV transmission rebuild and reconductor project",
      Utility: "Dominion Energy",
      "Project Type": "Supplemental transmission planning reliability upgrade",
      "Voltage (kV)": "230",
      "Distance (mi)": "2.9",
      Status: "Planned",
      Description:
        "Rebuild and reconductor 2.9 miles of overhead transmission line from the Chesterfield Substation to just south of the Tyler Substation in Chesterfield County, Virginia. The operating voltage will remain 230 kV while new structures and higher-capacity conductors replace aging infrastructure, increase ampacity, and support regional data center growth, local generation, and reliability needs through Dominion Energy's supplemental transmission planning process.",
    },
  },
  miso: {
    "CAYUGA||WOLF CREEK": {
      "Project Name": "Cayuga - Wolf Creek 345 kV baseline transmission upgrade",
      Utility: "Duke Energy Indiana",
      "Project Type": "Baseline reliability upgrade",
      "Voltage (kV)": "345",
      Status: "Planned",
      "Planned Year": "2029",
      Description:
        "Coordinated MISO baseline transmission upgrades rebuild and reconductor the 345 kV lines connecting Cayuga, Nucor, and Wolf Creek. The program includes a $96 million Cayuga-to-Nucor rebuild and a $49 million Nucor-to-Wolf Creek rebuild targeted for completion by June 2029.",
    },
  },
};

function pairKey(properties) {
  return [properties?.SUB_1, properties?.SUB_2]
    .map((value) => String(value || "").trim().toUpperCase())
    .sort()
    .join("||");
}

for (const [iso, metadataByPair] of Object.entries(metadataByIso)) {
  const path = `webmap/data/reconductoring-us/${iso}.json`;
  const data = JSON.parse(await fs.readFile(path, "utf8"));
  let updated = 0;

  for (const feature of data.existingFeatures || []) {
    const metadata = metadataByPair[pairKey(feature.properties)];
    if (!metadata) continue;

    const existingRecords = Array.isArray(feature.properties.project_records)
      ? feature.properties.project_records
      : [];
    feature.properties.project_records = [
      {
        ...(existingRecords[0] || {}),
        ...metadata,
        SUB_1: feature.properties.SUB_1,
        SUB_2: feature.properties.SUB_2,
      },
      ...existingRecords.slice(1),
    ];
    feature.properties.reconductoring_voltage = metadata["Voltage (kV)"];
    updated += 1;
  }

  await fs.writeFile(path, `${JSON.stringify(data)}\n`);
  console.log(`updated ${updated} ${iso} features`);
}
