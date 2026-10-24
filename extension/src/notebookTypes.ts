/** Notebook identity is independent of the percent-format source representation. */
export const NOTEBOOK_TYPES = ["tithon-py", "tithon-notebook"] as const;

export function isTithonNotebookType(type: string): boolean {
  return NOTEBOOK_TYPES.some((candidate) => candidate === type);
}

export function notebookTypeForPath(path: string): (typeof NOTEBOOK_TYPES)[number] {
  return path.toLowerCase().endsWith(".pynb") ? "tithon-notebook" : "tithon-py";
}
