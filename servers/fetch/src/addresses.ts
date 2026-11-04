/**
 * Which addresses the fetcher may connect to: public unicast only. Built on
 * `node:net`'s BlockList and `isIP`, so no address text is parsed by hand.
 */
import { BlockList, isIP } from "node:net";

const V4: [string, number][] = [
  ["0.0.0.0", 8], // "this network", incl. unspecified
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. 169.254.169.254 metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay (deprecated)
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. broadcast
];

// IPv6 is an allowlist: only global unicast, 2000::/3, is ever a candidate.
// That alone refuses all space below 2000::: unspecified, loopback, IPv4-mapped
// and IPv4-compatible forms, NAT64, 6to4's neighbours, unique-local, link-local,
// multicast, and 5f00::/16 (SRv6). The denylist then carves the special-purpose
// ranges out of 2000::/3.
const V6_ALLOWED: [string, number][] = [["2000::", 3]];
const V6_DENIED: [string, number][] = [
  ["2001::", 32], // Teredo
  ["2001:2::", 48], // benchmarking
  ["2001:10::", 28], // ORCHID
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4: embeds an IPv4 address
  ["3fff::", 20], // documentation
];

// Separate lists per family: BlockList matches an IPv4 address against IPv6
// rules by its mapped form, so mixing them would blur the two.
const blocked4 = new BlockList();
for (const [net, prefix] of V4) blocked4.addSubnet(net, prefix, "ipv4");
const allowed6 = new BlockList();
for (const [net, prefix] of V6_ALLOWED) allowed6.addSubnet(net, prefix, "ipv6");
const denied6 = new BlockList();
for (const [net, prefix] of V6_DENIED) denied6.addSubnet(net, prefix, "ipv6");

/** Whether `address` (an IP literal) is one the fetcher may connect to. */
export function isPublicAddress(address: string): boolean {
  switch (isIP(address)) {
    case 4:
      return !blocked4.check(address, "ipv4");
    case 6:
      return allowed6.check(address, "ipv6") && !denied6.check(address, "ipv6");
    default:
      return false;
  }
}
