/**
 * The session the terminal resumes after a restart (harness/gaffer-pi): the newest one in the sessions dir that
 * no live process holds, as Pi's --continue would pick it but never one open in the Gaffer App (NFR-REL-03).
 * Prints its path, or nothing (Pi then starts a new session).
 *
 *   node /opt/pi-gaffer/scripts/continue-session.ts /sessions
 */
import { newestFreeSession } from "../src/app-data.ts";

const file = newestFreeSession(process.argv[2] ?? "/sessions");
if (file) process.stdout.write(`${file}\n`);
