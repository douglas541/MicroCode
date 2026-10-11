import { appendFile, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parts(version) {
  if (typeof version !== "string" || !STABLE_VERSION.test(version))
    throw new Error(`Expected a stable major.minor.patch version: ${version}`);
  const numbers = version.split(".").map(Number);
  if (!numbers.every(Number.isSafeInteger))
    throw new Error(`Version components are too large: ${version}`);
  return numbers;
}

function compare(left, right) {
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

export function nextReleaseVersion(current, publishedVersions) {
  const requested = parts(current);
  if (!Array.isArray(publishedVersions))
    throw new Error("Published versions must be an array.");
  let latest = null;
  for (const version of publishedVersions) {
    if (!STABLE_VERSION.test(version)) continue;
    const candidate = parts(version);
    if (!latest || compare(candidate, latest) > 0) latest = candidate;
  }
  if (!latest || compare(requested, latest) > 0) return current;
  if (latest[2] === Number.MAX_SAFE_INTEGER)
    throw new Error("Cannot increment the published patch version.");
  return `${latest[0]}.${latest[1]}.${latest[2] + 1}`;
}

export async function prepareRelease({
  packageFile = new URL("../package.json", import.meta.url),
  fetchImpl = fetch,
} = {}) {
  const pkg = JSON.parse(await readFile(packageFile, "utf8"));
  parts(pkg.version);
  if (typeof pkg.name !== "string" || !pkg.name)
    throw new Error("Package name is missing.");
  const response = await fetchImpl(
    `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`,
    {
      headers: { Accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(30000),
    },
  );
  let publishedVersions = [];
  if (response.status !== 404) {
    if (!response.ok)
      throw new Error(
        `Cannot read published versions: HTTP ${response.status}`,
      );
    const data = await response.json();
    if (
      !data.versions ||
      typeof data.versions !== "object" ||
      Array.isArray(data.versions)
    )
      throw new Error("The npm registry returned invalid version metadata.");
    publishedVersions = Object.keys(data.versions);
  }
  pkg.version = nextReleaseVersion(pkg.version, publishedVersions);
  await writeFile(packageFile, JSON.stringify(pkg, null, 2) + "\n");
  return { name: pkg.name, version: pkg.version };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const { name, version } = await prepareRelease();
    if (process.env.GITHUB_OUTPUT)
      await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\n`);
    console.log(`Prepared ${name}@${version}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
