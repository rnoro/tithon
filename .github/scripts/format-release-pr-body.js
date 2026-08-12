"use strict";

const VERSION = "\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?";
const PACKAGE_BY_COMPONENT = new Map([
  ["", { display: "tithon", summary: (version) => version }],
  [
    "vscode",
    { display: "vscode-tithon", summary: (version) => `vscode: ${version}` },
  ],
]);
const PACKAGE_BY_DISPLAY = new Map(
  [...PACKAGE_BY_COMPONENT.values()].map((packageInfo) => [
    packageInfo.display,
    packageInfo,
  ]),
);

function visibleNotes(packageInfo, version, notes) {
  const content = notes
    .trim()
    .replace(/^## \[([^\]]+)\]\(([^)]+)\)(.*)$/m, "[Compare changes]($2)$3");
  return `## ${packageInfo.display} ${version}\n\n${content}`;
}

function formatReleasePrBody(body) {
  let formatted = body.replace(
    /^<details><summary>([^<\n]+)<\/summary>\n\n([\s\S]*?)\n<\/details>(?=\n\n(?:<details><summary>|---(?:\n|$)))/gm,
    (block, summary, notes) => {
      const separator = summary.indexOf(":");
      const component =
        separator === -1 ? "" : summary.slice(0, separator).trim();
      const version = (
        separator === -1 ? summary : summary.slice(separator + 1)
      ).trim();
      const packageInfo = PACKAGE_BY_COMPONENT.get(component);
      return packageInfo && new RegExp(`^${VERSION}$`).test(version)
        ? visibleNotes(packageInfo, version, notes)
        : block;
    },
  );

  if (formatted !== body) {
    return formatted;
  }

  return body.replace(
    new RegExp(
      `^## \\[(${VERSION})\\]\\(([^)]+/compare/[^)]+?\\.\\.\\.([^)]+))\\)(.*)$`,
      "m",
    ),
    (heading, version, compareUrl, targetTag, suffix) => {
      const component = targetTag.startsWith("vscode-v") ? "vscode" : "";
      const packageInfo = PACKAGE_BY_COMPONENT.get(component);
      return packageInfo
        ? `## ${packageInfo.display} ${version}\n\n[Compare changes](${compareUrl})${suffix}`
        : heading;
    },
  );
}

function restoreReleasePrBody(body) {
  const section = new RegExp(
    `^## (tithon|vscode-tithon) (${VERSION})\\n\\n([\\s\\S]*?)(?=^## (?:tithon|vscode-tithon) ${VERSION}\\n\\n|^---\\s*$)`,
    "gm",
  );

  return body.replace(section, (block, display, version, notes) => {
    const packageInfo = PACKAGE_BY_DISPLAY.get(display);
    if (!packageInfo) {
      return block;
    }
    const canonicalNotes = notes
      .trimEnd()
      .replace(
        /^\[Compare changes\]\(([^)]+)\)(.*)$/m,
        `## [${version}]($1)$2`,
      );
    return `<details><summary>${packageInfo.summary(version)}</summary>\n\n${canonicalNotes}\n</details>\n\n`;
  });
}

module.exports = { formatReleasePrBody, restoreReleasePrBody };
