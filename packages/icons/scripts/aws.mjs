#!/usr/bin/env node
/**
 * `pnpm icons:aws` — generate the OPT-IN AWS icon pack (DGC-99).
 *
 * Downloads the official "AWS Architecture Icons" asset package from
 * aws.amazon.com — the download happens on YOUR machine, directly from
 * AWS, exactly like clicking "Download the asset package" on the official
 * page; this repo never redistributes the artwork — then extracts the
 * 48px Architecture-Service SVGs VERBATIM (no recolor, no reshape; only
 * the XML declaration is stripped so the markup can be injected inline)
 * and writes, into `packages/icons/packs/` (gitignored):
 *
 *   aws.icons.json      — the pack (loaded by web via vite glob and by the
 *                         server via loadIconPacksFromDisk)
 *   aws.ATTRIBUTION.md  — source + terms-of-use notes
 *
 * AWS permits customers/partners to use these assets to create
 * architecture diagrams (https://aws.amazon.com/architecture/icons/), and
 * the AWS Trademark Guidelines forbid altering the artwork — both are
 * honored here: verbatim glyphs, local-only files.
 *
 * Usage:
 *   node scripts/aws.mjs [--zip <local-package.zip>] [--url <package-url>]
 *
 * Without flags the current package URL is discovered by scraping the
 * official icons page. `--zip` skips the download entirely (offline runs,
 * tests); `--url` pins a specific release.
 */
import { parseArgs } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const ICONS_PAGE = "https://aws.amazon.com/architecture/icons/";
/** 48px Architecture-Service SVGs, e.g.
 *  `Architecture-Service-Icons_04302026/Arch_Storage/48/Arch_Amazon-Simple-Storage-Service_48.svg` */
const ENTRY_RE = /^Architecture-Service-Icons_(\d+)\/Arch_[^/]+\/48\/Arch_(.+)_48\.svg$/;
const PACKS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packs");

/**
 * Short names people actually type → the bare id derived from the AWS
 * filename (vendor prefix stripped, lowercased). Aliases whose target is
 * missing from the downloaded release are skipped with a warning, so this
 * table can stay ahead of (or behind) AWS's quarterly renames safely.
 *
 * NOTE: bare names that the BUILT-IN registry already claims (e.g. `mq`,
 * `cache`) are resolved by the built-in set at runtime, never by a pack —
 * don't bother aliasing those here.
 */
const ALIASES = {
  s3: "simple-storage-service",
  glacier: "simple-storage-service-glacier",
  sqs: "simple-queue-service",
  sns: "simple-notification-service",
  ses: "simple-email-service",
  ebs: "elastic-block-store",
  ecs: "elastic-container-service",
  ecr: "elastic-container-registry",
  eks: "elastic-kubernetes-service",
  elb: "elastic-load-balancing",
  alb: "elastic-load-balancing",
  nlb: "elastic-load-balancing",
  beanstalk: "elastic-beanstalk",
  vpc: "virtual-private-cloud",
  route53: "route-53",
  iam: "identity-and-access-management",
  kms: "key-management-service",
  acm: "certificate-manager",
  msk: "managed-streaming-for-apache-kafka",
  firehose: "data-firehose",
  opensearch: "opensearch-service",
  dynamo: "dynamodb",
  ddb: "dynamodb",
  sfn: "step-functions",
  quicksight: "quick",
  cfn: "cloudformation",
};

function fail(message) {
  console.error(`[icons:aws] ${message}`);
  process.exit(1);
}

async function discoverPackageUrl() {
  console.log(`[icons:aws] discovering current asset-package URL from ${ICONS_PAGE} ...`);
  const res = await fetch(ICONS_PAGE, { headers: { "user-agent": "diagram-copilot icons:aws (local opt-in pack generator)" } });
  if (!res.ok) fail(`could not fetch ${ICONS_PAGE} (HTTP ${res.status}) — pass --url or --zip instead`);
  const html = await res.text();
  const match = html.match(/https:\/\/d1\.awsstatic\.com\/[^"'\s]*Icon-package[^"'\s]*\.zip/);
  if (!match) fail("could not find an Icon-package .zip link on the page — pass --url or --zip instead");
  return match[0];
}

async function loadZip(values) {
  if (values.zip !== undefined) {
    console.log(`[icons:aws] reading local zip ${values.zip}`);
    return new Uint8Array(fs.readFileSync(values.zip));
  }
  const url = values.url ?? (await discoverPackageUrl());
  console.log(`[icons:aws] downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) fail(`download failed (HTTP ${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  console.log(`[icons:aws] downloaded ${(bytes.length / 1024 / 1024).toFixed(1)} MB`);
  return bytes;
}

/** `Amazon-Simple-Storage-Service` → id `simple-storage-service`, title `Amazon Simple Storage Service`. */
function deriveIcon(rawName) {
  return {
    id: rawName.replace(/^(Amazon|AWS)-/, "").toLowerCase(),
    title: rawName.replace(/-/g, " "),
  };
}

/** Keep artwork verbatim; strip only the XML declaration (invalid inside innerHTML). */
function cleanSvg(svgText) {
  return svgText.replace(/^\s*<\?xml[^>]*\?>\s*/, "").trim();
}

async function main() {
  const { values } = parseArgs({ options: { zip: { type: "string" }, url: { type: "string" } } });
  const zipBytes = await loadZip(values);

  const files = unzipSync(zipBytes, {
    filter: (file) => !file.name.startsWith("__MACOSX/") && ENTRY_RE.test(file.name),
  });
  const names = Object.keys(files).sort();
  if (names.length === 0) fail("no Architecture-Service 48px SVGs found in the zip — did AWS change the package layout?");

  const decoder = new TextDecoder();
  const icons = {};
  let version = "";
  let duplicates = 0;
  for (const name of names) {
    const match = name.match(ENTRY_RE);
    version = match[1];
    const { id, title } = deriveIcon(match[2]);
    if (icons[id] !== undefined) {
      duplicates += 1; // same service listed under two categories — same artwork, first wins
      continue;
    }
    icons[id] = { title, svg: cleanSvg(decoder.decode(files[name])) };
  }

  const aliases = {};
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (icons[target] === undefined) {
      console.warn(`[icons:aws] skipping alias "${alias}" — target "${target}" not in this release`);
      continue;
    }
    aliases[alias] = target;
  }

  const pack = {
    namespace: "aws",
    title: "AWS Architecture Icons",
    version,
    source: ICONS_PAGE,
    license: "AWS Architecture Icons terms — architecture-diagram use only, artwork unaltered, not redistributable (see packs/aws.ATTRIBUTION.md)",
    icons,
    aliases,
  };

  fs.mkdirSync(PACKS_DIR, { recursive: true });
  const jsonPath = path.join(PACKS_DIR, "aws.icons.json");
  fs.writeFileSync(jsonPath, JSON.stringify(pack, null, 1));

  const attributionPath = path.join(PACKS_DIR, "aws.ATTRIBUTION.md");
  fs.writeFileSync(
    attributionPath,
    `# AWS Architecture Icons — local opt-in pack (NOT redistributed)

Generated ${new Date().toISOString().slice(0, 10)} by \`pnpm icons:aws\` (release ${version},
${Object.keys(icons).length} service icons) from the official asset package linked at:

- ${ICONS_PAGE}

This directory is **gitignored**. The artwork is © Amazon Web Services, Inc.
or its affiliates, downloaded by you directly from AWS. It is NOT part of
this repository's MIT-licensed sources and must not be committed or
redistributed. AWS states on the page above: "We allow customers and
partners to use these toolkits and assets to create architecture diagrams."

Constraints diagram-copilot honors when rendering this pack:

- Glyphs render **verbatim** — no recolor, re-theme, reshape, or cropping
  (the AWS Trademark Guidelines forbid altering the artwork:
  https://aws.amazon.com/trademark-guidelines/).
- Icons identify AWS services inside architecture diagrams only; their use
  implies no AWS sponsorship, endorsement, or affiliation.

To refresh after a quarterly AWS release: run \`pnpm icons:aws\` again.
To remove the pack: delete this directory.
`,
  );

  console.log(`[icons:aws] wrote ${jsonPath} (${Object.keys(icons).length} icons, ${Object.keys(aliases).length} aliases, release ${version})`);
  if (duplicates > 0) console.log(`[icons:aws] deduped ${duplicates} icon(s) listed under multiple categories`);
  console.log(`[icons:aws] wrote ${attributionPath}`);
  console.log("[icons:aws] pick-up: restart `pnpm dev` (or re-run `pnpm build`) so web + server load the pack.");
  console.log("[icons:aws] try it: [icon: aws:s3], [icon: aws:lambda], [icon: aws:dynamodb] — see list_icons / the 🎨 palette.");
}

await main();
