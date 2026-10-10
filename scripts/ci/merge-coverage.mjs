import { readFileSync, statSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Reuse the exact Istanbul toolchain supplied by the pinned Vitest provider.
const require = createRequire(import.meta.url);
const coverageRequire = createRequire(require.resolve("@vitest/coverage-v8/package.json"));
const { createCoverageMap } = coverageRequire("istanbul-lib-coverage");
const { createContext } = coverageRequire("istanbul-lib-report");
const reports = coverageRequire("istanbul-reports");
const MAX_REPORT_BYTES = 128 * 1024 * 1024;

function mergeOne(map, file) {
  if (statSync(file).size > MAX_REPORT_BYTES) throw new Error(`Coverage report exceeds 128 MiB: ${file}`);
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`Invalid coverage report: ${file}`);
  if (Object.keys(data).length === 0) throw new Error(`Empty coverage report: ${file}`);
  for (const [path, record] of Object.entries(data)) {
    if (!record || typeof record !== "object" || record.path !== path ||
        !record.statementMap || !record.fnMap || !record.branchMap || !record.s || !record.f || !record.b)
      throw new Error(`Invalid file coverage in ${file}: ${path}`);
    for (const [locations, counts, branch] of [
      [record.statementMap, record.s, false], [record.fnMap, record.f, false], [record.branchMap, record.b, true],
    ]) {
      if (Object.keys(locations).length !== Object.keys(counts).length)
        throw new Error(`Missing coverage counters in ${file}: ${path}`);
      for (const [id, count] of Object.entries(counts)) {
        const values = branch ? count : [count];
        if (!Object.hasOwn(locations, id) || !Array.isArray(values) ||
            values.some(value => !Number.isFinite(value) || value < 0) ||
            branch && values.length !== locations[id].locations?.length)
          throw new Error(`Invalid coverage counter in ${file}: ${path}`);
      }
    }
  }
  map.merge(data);
}

/** Retain one converted report and the cumulative file map, never all V8 blobs. */
export function mergeCoverageReports(inputFiles, outputDirectory) {
  if (!Array.isArray(inputFiles) || inputFiles.length === 0 ||
      inputFiles.some(file => typeof file !== "string" || !file))
    throw new Error("Coverage merge requires a nonempty list of report files");
  const map = createCoverageMap({});
  for (const file of inputFiles) mergeOne(map, file);
  mkdirSync(outputDirectory, { recursive: true });
  const context = createContext({ dir: outputDirectory, coverageMap: map });
  for (const name of ["text", "json", "html"]) reports.create(name).execute(context);
  return { inputs: inputFiles.length, files: map.files().length };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const inputs = JSON.parse(readFileSync(process.argv[2], "utf8"));
    const result = mergeCoverageReports(inputs, process.argv[3]);
    console.log(`Coverage merged: ${result.inputs} reports, ${result.files} source files`);
  } catch (error) {
    console.error(`Coverage merge failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
