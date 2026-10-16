// DESIGN_AUTHORITY.md §6.12 — operator access. A1: only the identity-aware proxy reaches the platform.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { files, read } from './support.js';

/** Every `aws_vpc_security_group_ingress_rule` block and inline `ingress {}` block in the AWS landing zone. */
function ingressBlocks(): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  for (const f of files('landing-zones/aws', (p) => p.endsWith('.tf'))) {
    const text = read(f);
    for (const m of text.matchAll(/resource "aws_vpc_security_group_ingress_rule" "([^"]+)" \{[\s\S]*?\n\}/g)) out.push({ where: `${f} ${m[1]}`, text: m[0] });
    for (const m of text.matchAll(/^\s*ingress\s*\{[\s\S]*?\n\s*\}/gm)) out.push({ where: `${f} inline ingress`, text: m[0] });
  }
  return out;
}

describe('A1 one front door (AWS landing zone)', () => {
  it('no ingress rule is open to the whole internet', () => {
    const open = ingressBlocks().filter((b) => /0\.0\.0\.0\/0|::\/0/.test(b.text)).map((b) => b.where);
    assert.deepEqual(open, []);
  });

  it('the load balancer accepts only var.ingress_cidrs', () => {
    const alb = ingressBlocks().filter((b) => /security_group_id\s*=\s*aws_security_group\.alb\.id/.test(b.text));
    assert.ok(alb.length > 0, 'no load balancer ingress rule found');
    for (const b of alb) assert.match(b.text, /var\.ingress_cidrs/, `${b.where} admits a source other than var.ingress_cidrs`);
    const network = read('landing-zones/aws/network.tf');
    assert.doesNotMatch(network, /^\s*\w+\s*=\s*\[aws_security_group\.alb\.id,/m, 'network.tf opens a port on the load balancer');
  });

  it('ingress_cidrs is required and refuses /0 in both AWS and GCP landing zones', () => {
    for (const path of ['landing-zones/aws/variables.tf', 'landing-zones/gcp/variables.tf']) {
      const v = read(path).match(/variable "ingress_cidrs" \{[\s\S]*?\n\}/)?.[0] ?? '';
      assert.ok(v, `${path}: variable ingress_cidrs is not declared`);
      assert.doesNotMatch(v, /\bdefault\b/, `${path}: ingress_cidrs must have no default`);
      assert.match(v, /\/0\$/, `${path}: ingress_cidrs validation must refuse /0`);
    }
  });

  it('the GCP landing zone restricts Cloud Run ingress to internal + LB and protects the LB with Cloud Armor', () => {
    const cr = read('landing-zones/gcp/cloud_run.tf');
    assert.doesNotMatch(cr, /INGRESS_TRAFFIC_ALL/, 'no Cloud Run service may accept direct internet traffic');
    const lb = read('landing-zones/gcp/lb.tf');
    assert.match(lb, /resource "google_compute_security_policy" "front_door"/);
    assert.match(lb, /chunklist\(var\.ingress_cidrs/);
    assert.match(lb, /action\s*=\s*"deny\(403\)"/);
  });
});
