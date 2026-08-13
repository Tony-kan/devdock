import { Console } from "@/components/Console";
import { buildSnapshot } from "@/lib/server/core";

// The first paint reflects live process state, so this page is never prerendered.
// Loading it is also what boots the supervisor and generates services.json.
export const dynamic = "force-dynamic";

export default async function Page() {
  const snapshot = await buildSnapshot();
  return <Console initial={snapshot} />;
}
