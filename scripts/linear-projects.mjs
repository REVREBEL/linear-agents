#!/usr/bin/env node
// List all Linear projects and their full UUIDs for routing.json.
const apiKey = process.env.LINEAR_API_KEY;
if (!apiKey) {
  console.error("Missing LINEAR_API_KEY in the root .env");
  process.exit(1);
}
let cursor = null;
const seen = new Set();
try {
  do {
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `query ListProjects($after: String) {
          projects(first: 100, after: $after) {
            nodes { id name }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        variables: { after: cursor },
      }),
    });
    if (!response.ok) throw new Error(`Linear API returned HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.errors?.length) throw new Error(payload.errors.map((error) => error.message).join("; "));
    const connection = payload.data?.projects;
    if (!connection?.nodes || !connection.pageInfo) throw new Error("Unexpected Linear projects response");
    for (const project of connection.nodes) console.log(`${project.name}\t${project.id}`);
    if (!connection.pageInfo.hasNextPage) break;
    const nextCursor = connection.pageInfo.endCursor;
    if (!nextCursor || seen.has(nextCursor)) throw new Error("Linear pagination returned an invalid/repeated cursor");
    seen.add(nextCursor);
    cursor = nextCursor;
  } while (true);
} catch (error) {
  console.error(`Could not list Linear projects: ${error.message}`);
  process.exitCode = 1;
}
