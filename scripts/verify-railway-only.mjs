import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const forbiddenRuntimePatterns = [
  { label: "legacy SDK", pattern: /@supabase/i },
  { label: "legacy environment variable", pattern: /VITE_SUPABASE/i },
  { label: "legacy service hostname", pattern: /\.supabase\.co/i },
  { label: "legacy project reference", pattern: /rlqtnmahyryvuitaytah/i },
];

/**
 * Follow local static imports from the browser entry point. This checks the
 * deployable module graph rather than archival migration sources, which remain
 * in the repository until their separately approved cleanup phase.
 */
function readBrowserModuleGraph(entryRelativePath) {
  const pendingPaths = [entryRelativePath];
  const visitedPaths = new Set();
  while (pendingPaths.length) {
    const relativePath = pendingPaths.pop();
    if (visitedPaths.has(relativePath)) continue;
    visitedPaths.add(relativePath);
    const absolutePath = path.join(repositoryRoot, relativePath);
    const source = fs.readFileSync(absolutePath, "utf8");
    const importPattern = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'](\.[^"']+)["']/g;
    for (const match of source.matchAll(importPattern)) {
      const importedPath = path.normalize(path.join(path.dirname(relativePath), match[1]));
      const resolvedPath = path.extname(importedPath) ? importedPath : `${importedPath}.js`;
      if (fs.existsSync(path.join(repositoryRoot, resolvedPath))) pendingPaths.push(resolvedPath);
    }
  }
  return [...visitedPaths];
}

function findForbiddenRuntimeReferences(relativePaths) {
  const failures = [];
  for (const relativePath of relativePaths) {
    const source = fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
    for (const rule of forbiddenRuntimePatterns) {
      if (rule.pattern.test(source)) failures.push(`${relativePath}: ${rule.label}`);
    }
  }
  return failures;
}

const browserPaths = readBrowserModuleGraph(path.join("src", "main.js"));
const operationalPaths = [
  ...browserPaths,
  ".github/workflows/deploy.yml",
  ".github/workflows/keepalive.yml",
  ".env.example",
  "index.html",
  "vite.config.js",
];
const distributionRoot = path.join(repositoryRoot, "dist");
if (fs.existsSync(distributionRoot)) {
  for (const relativePath of fs.readdirSync(distributionRoot, { recursive: true })) {
    const absolutePath = path.join(distributionRoot, relativePath);
    if (fs.statSync(absolutePath).isFile()) operationalPaths.push(path.join("dist", relativePath));
  }
}

const failures = findForbiddenRuntimeReferences([...new Set(operationalPaths)]);
if (failures.length) {
  console.error(`Railway-only verification failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}

console.log(`Railway-only verification passed (${browserPaths.length} active browser modules checked).`);
