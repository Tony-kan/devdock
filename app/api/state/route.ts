import { buildSnapshot } from "@/lib/server/core";

// Every response reflects live process state, so nothing here may be prerendered.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const forceGit = new URL(request.url).searchParams.get("git") === "refresh";
  const snapshot = await buildSnapshot({ forceGit });
  return Response.json(snapshot);
}
