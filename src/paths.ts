import os from "os";
import path from "path";

// dotenv does no shell expansion, so values like "~/x" or "$HOME/x" arrive literal.
// Kept side-effect-free (no DB open) so collectors can import it without pulling in db.ts.
export function expandHome(p: string): string {
  const home = os.homedir();
  if (p === "~" || p.startsWith("~/")) return path.join(home, p.slice(1));
  if (p === "$HOME" || p.startsWith("$HOME/")) return path.join(home, p.slice("$HOME".length));
  return p;
}
