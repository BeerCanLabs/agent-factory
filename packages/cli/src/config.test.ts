import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInstance } from './config.js';

describe('§6.17 CL1 pointing at an instance', () => {
  it('CL1 takes a bare host as https and keeps only the origin', () => {
    assert.equal(normalizeInstance('agent-factory.example.com'), 'https://agent-factory.example.com');
    assert.equal(normalizeInstance('https://agent-factory.example.com/some/path?x=1'), 'https://agent-factory.example.com');
  });

  it('CL1 refuses plain http except on the machine itself, and refuses embedded credentials', () => {
    assert.throws(() => normalizeInstance('http://factory.example.com'), /https/);
    assert.equal(normalizeInstance('http://localhost:8088'), 'http://localhost:8088');
    assert.throws(() => normalizeInstance('https://user:pw@factory.example.com'), /username or password/);
    assert.throws(() => normalizeInstance('not a url at all'), /not a factory address/);
  });
});
