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

// A merged grouped PR whose only section is the root package (component "")
// is read by release-please as a standalone PR, which it then requires to come
// from a component branch; ours never does, so that release would be skipped.
// A second section for a component no package uses keeps the body in the
// multi-package form, where the root section matches the root's empty component.
const GROUP_MARKER =
  "<details><summary>release-group: 0.0.0</summary>\n\n" +
  "Keeps a single-package release in the grouped form.\n</details>\n\n";

function visibleNotes(packageInfo, version, notes) {
  const content = notes
    .trim()
    .replace(/^## \[([^\]]+)\]\(([^)]+)\)(.*)$/m, "[Compare changes]($2)$3");
  return `## ${packageInfo.display} ${version}\n\n${content}`;
}

function formatReleasePrBody(body) {
  body = body.replace(GROUP_MARKER, "");
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

  const restored = [];
  const result = body.replace(section, (block, display, version, notes) => {
    const packageInfo = PACKAGE_BY_DISPLAY.get(display);
    if (!packageInfo) {
      return block;
    }
    restored.push(display);
    const canonicalNotes = notes
      .trimEnd()
      .replace(
        /^\[Compare changes\]\(([^)]+)\)(.*)$/m,
        `## [${version}]($1)$2`,
      );
    const details = `<details><summary>${packageInfo.summary(version)}</summary>\n\n${canonicalNotes}\n</details>\n\n`;
    // A placeholder after the root section, resolved once every section is known.
    return display === "tithon" ? details + "\u0000" : details;
  });
  const rootOnly = restored.length === 1 && restored[0] === "tithon";
  return result.replace("\u0000", rootOnly ? GROUP_MARKER : "");
}

module.exports = { formatReleasePrBody, restoreReleasePrBody };
