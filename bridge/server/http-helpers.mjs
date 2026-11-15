// Shared, behavior-preserving bridge HTTP primitives.
export function normalizeHost(hostHeader) {
  return String(hostHeader || "").split(":")[0].toLowerCase();
}

export function matchesHost(actualHost, expectedHost) {
  return actualHost === expectedHost || actualHost.endsWith(`.${expectedHost}`);
}

export function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;

    request.on("data", (chunk) => {
      totalBytes += chunk.length;

      if (totalBytes > 1_000_000) {
        reject(new Error("Body too large"));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    request.on("error", reject);
  });
}

export function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });

  response.end(JSON.stringify(body, null, 2));
}
