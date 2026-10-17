/** Team ids are stored only as an HMAC (NFR-PRIV-01, ADR 0004). No dependencies: plain-node tools import it. */
import { createHmac } from "node:crypto";

export function hashTeamId(teamId: number, salt: string): string {
	return `hmac-sha256:${createHmac("sha256", salt).update(String(teamId)).digest("hex")}`;
}
