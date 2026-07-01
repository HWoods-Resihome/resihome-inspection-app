import { describe, it, expect } from 'vitest';
import { isPrivateIp } from '@/lib/safeProxyFetch';

describe('isPrivateIp — SSRF guard', () => {
  it('blocks IPv4 private / internal ranges', () => {
    for (const ip of [
      '169.254.169.254', // cloud metadata (the classic SSRF target)
      '127.0.0.1', '127.1.2.3', // loopback
      '10.0.0.5', '10.255.255.255', // 10/8
      '172.16.0.1', '172.31.255.255', // 172.16/12
      '192.168.1.1', // 192.168/16
      '100.64.0.1', '100.127.255.255', // CGNAT
      '0.0.0.0', // unspecified
      '224.0.0.1', '239.1.2.3', // multicast
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it('allows public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '13.107.42.14', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it('blocks IPv6 loopback / link-local / ULA / mapped-private', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', '::ffff:169.254.169.254', '::ffff:10.0.0.1']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it('allows public IPv6 (incl. IPv4-mapped public)', () => {
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it('errs closed on non-literal / malformed input', () => {
    for (const bad of ['not-an-ip', '', '999.999.999.999', 'localhost']) {
      expect(isPrivateIp(bad), bad).toBe(true);
    }
  });
});
