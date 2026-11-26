// A stand-in for `plannotator review`: answers /api/diff, keeps what is
// posted, and clears by source as Plannotator does.

import type { ReviewComment } from "../../src/guide";

export function fakeReview(port = 0) {
  const calls: string[] = [];
  let held: ReviewComment[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/diff") {
        return Response.json({ rawPatch: "" });
      }
      calls.push(`${req.method} ${url.pathname}${url.search}`);
      if (req.method === "DELETE") {
        const source = url.searchParams.get("source");
        held = source ? held.filter((c) => c.source !== source) : [];
        return Response.json({ ok: true });
      }
      const body = (await req.json()) as { annotations: ReviewComment[] };
      held.push(...body.annotations);
      return Response.json(
        { ids: body.annotations.map(() => "x") },
        { status: 201 },
      );
    },
  });
  return { server, calls, held: () => held };
}
