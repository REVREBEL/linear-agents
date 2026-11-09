export interface LinearIssueLabel {
  name: string;
  parent?: { name: string } | null;
}

export function issueAgentLocation(labels: LinearIssueLabel[] | undefined): string | null {
  const matches = (labels || []).filter(label =>
    label.parent?.name?.toLowerCase() === "agent-location" ||
    label.parent?.name?.toLowerCase() === "agent location");
  if (matches.length > 1) throw Error("Conflicting Agent Location labels on issue");
  return matches[0]?.name ?? null;
}
