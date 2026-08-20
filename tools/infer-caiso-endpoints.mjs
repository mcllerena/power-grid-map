import fs from "node:fs/promises";
import path from "node:path";
import shp from "shpjs";

const ROOT = process.cwd();
const TRANSMISSION_ZIP = path.join(ROOT, "geoinfo", "us-data", "Electric_Power_Transmission_Lines.zip");

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function normalizeSearch(value) {
  return normalizeName(value).replace(/[^A-Z0-9]/g, "");
}

function tokenize(value) {
  return normalizeName(value).match(/[A-Z0-9]+/g) || [];
}

const GENERIC_NODE_NAMES = new Set([
  "SUB STATION",
  "STATION #230",
  "SECTION",
  "LANDING",
  "CORRIDOR",
  "VALLEY",
  "NORTH",
  "SOUTH",
  "EAST",
  "WEST",
  "TOWER",
  "MAPLE",
  "MOUNTAIN",
  "CANYON",
  "COLORADO",
  "RIVER",
  "ROADWAY",
  "VICTOR",
  "VISTA",
  "ORANGE",
  "MARCOS",
  "CENTER",
  "IMPERIAL",
  "TERMINAL",
  "UNKNOWN",
  "NOT AVAILABLE",
]);

function getLineFeatures(collection) {
  return (collection?.features || []).filter((feature) =>
    ["LineString", "MultiLineString"].includes(feature?.geometry?.type)
  );
}

function buildGraph(features) {
  const graph = new Map();
  const add = (from, to) => {
    if (!graph.has(from)) graph.set(from, new Set());
    graph.get(from).add(to);
  };
  for (const feature of features) {
    const left = normalizeName(feature?.properties?.SUB_1);
    const right = normalizeName(feature?.properties?.SUB_2);
    if (!left || !right) continue;
    add(left, right);
    add(right, left);
  }
  return graph;
}

function hasPath(graph, start, goal) {
  if (!graph.has(start) || !graph.has(goal)) return false;
  const queue = [start];
  const visited = new Set([start]);
  while (queue.length) {
    const current = queue.shift();
    if (current === goal) return true;
    for (const neighbor of graph.get(current) || []) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      queue.push(neighbor);
    }
  }
  return false;
}

function candidateNodes(title, nodes) {
  const titleTokens = tokenize(title);
  return nodes
    .filter((node) => {
      if (GENERIC_NODE_NAMES.has(node.name)) return false;
      const nodeTokens = tokenize(node.name);
      if (!nodeTokens.length || node.search.length < 4) return false;
      return nodeTokens.every((token, index) => titleTokens[index] === token) ||
        titleTokens.some((_, start) => nodeTokens.every((token, index) => titleTokens[start + index] === token));
    })
    .sort((left, right) => right.search.length - left.search.length);
}

async function main() {
  const inputPath = path.resolve(process.argv[2] || "reference/caiso-project-titles.json");
  const outputPath = path.resolve(process.argv[3] || "reference/caiso-inferred-endpoints.json");
  const projects = JSON.parse(await fs.readFile(inputPath, "utf8"));
  const archive = await fs.readFile(TRANSMISSION_ZIP);
  const parsed = await shp(archive);
  const collection = Array.isArray(parsed) ? parsed[0] : parsed;
  const features = getLineFeatures(collection);
  const graph = buildGraph(features);
  const nodes = [...graph.keys()]
    .map((name) => ({ name, search: normalizeSearch(name) }))
    .filter((node) => node.search.length >= 4 && !GENERIC_NODE_NAMES.has(node.name));
  const mappings = {};

  for (const project of projects) {
    const title = String(project?.project || "").trim();
    const candidates = candidateNodes(title, nodes);
    let best = null;
    for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
        const left = candidates[leftIndex].name;
        const right = candidates[rightIndex].name;
        if (!hasPath(graph, left, right)) continue;
        const score = candidates[leftIndex].search.length + candidates[rightIndex].search.length;
        if (!best || score > best.score) {
          best = { SUB_1: left, SUB_2: right, score };
        }
      }
    }
    if (best) {
      mappings[project.key] = { SUB_1: best.SUB_1, SUB_2: best.SUB_2 };
    }
  }

  await fs.writeFile(outputPath, JSON.stringify(mappings, null, 2));
  console.log(`Transmission features: ${features.length}`);
  console.log(`Projects received: ${projects.length}`);
  console.log(`Endpoint mappings inferred: ${Object.keys(mappings).length}`);
  console.log(`Wrote ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});