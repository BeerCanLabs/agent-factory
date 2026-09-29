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

  it('ingress_cidrs is required and refuses /0', () => {
    const v = read('landing-zones/aws/variables.tf').match(/variable "ingress_cidrs" \{[\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(v, 'variable ingress_cidrs is not declared');
    assert.doesNotMatch(v, /\bdefault\b/, 'ingress_cidrs must have no default');
    assert.match(v, /\/0\$/, 'ingress_cidrs validation must refuse /0');
  });
});
