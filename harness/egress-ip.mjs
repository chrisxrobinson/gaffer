// Print the IPv4 address of the interface that holds the default route (from /proc/net/route).
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";

const rows = readFileSync("/proc/net/route", "utf8").trim().split("\n").slice(1).map((l) => l.trim().split(/\s+/));
const iface = rows.find((r) => r[1] === "00000000")?.[0];
const addr = iface && networkInterfaces()[iface]?.find((a) => a.family === "IPv4")?.address;
if (!addr) {
  console.error("egress-ip: no default-route interface found");
  process.exit(1);
}
console.log(addr);
